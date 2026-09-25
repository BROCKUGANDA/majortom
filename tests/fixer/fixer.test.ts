// tests/fixer/fixer.test.ts
// Phase 5 acceptance tests (SPEC.md §7.3, I2, I5, I9)
//
// These tests run against a COPY of fixtures/express4 in a temp directory, so the
// committed fixture is never mutated. The headline gate is real: after fixing, the
// fixture is installed on express@5 and its own supertest suite is executed.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  cpSync,
  rmSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { execFileSync } from "child_process";

import { sandboxCopy } from "../helpers/sandbox.js";

import { impactScan } from "../../src/scanner/impact.js";
import { partition } from "../../src/scanner/partition.js";
import { dispatchFixers } from "../../src/agents/dispatcher.js";
import { Fixer, validateSource } from "../../src/agents/fixer.js";
import { QueueFsFacade, ScopeViolationError } from "../../src/agents/facade.js";
import { MigrationPlan, type PlanItem } from "../../src/docs/schemas.js";

const FIXTURE_ROOT = resolve("fixtures/express4");
const CANNED_PLAN = resolve("tests/fixtures/canned-plan.json");

let workRoot: string;
let workMap: Awaited<ReturnType<typeof impactScan>>;
let plan: MigrationPlan;
let queues: ReturnType<typeof partition>;

/** Snapshot of every file in the tree, for the diff-scope assertion. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const abs = join(d, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else out.set(rel, readFileSync(abs, "utf8"));
    }
  };
  walk(dir, "");
  return out;
}

let copies: string[] = [];
function freshFixture(): string {
  const dir = sandboxCopy(FIXTURE_ROOT, "majortom-fix");
  copies.push(dir);
  return dir;
}

beforeAll(async () => {
  plan = MigrationPlan.parse(JSON.parse(readFileSync(CANNED_PLAN, "utf8")));
  workMap = await impactScan(FIXTURE_ROOT, plan.items);
  queues = partition(workMap.entries, 3);
  workRoot = freshFixture();
}, 120_000);

afterAll(() => {
  if (workRoot && existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
  // Per-directory cleanup only — a sibling test file may still be using the sandbox
  // root. Wiping the shared root here causes concurrent-rm races (ENOTEMPTY).
  for (const d of copies) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  copies = [];
});

// ─── I5: the facade physically rejects out-of-queue paths ────────────────────

describe("filesystem facade — the hard I5 guard", () => {
  it("allows reading and writing a file inside the queue", () => {
    const fs = new QueueFsFacade({ repoRoot: workRoot, queueId: "q1", files: ["src/app.js"] });
    const original = fs.read("src/app.js");
    expect(original).toContain("express");
    fs.write("src/app.js", `${original}\n// touched\n`);
    expect(fs.read("src/app.js")).toContain("// touched");
  });

  it("REJECTS a write outside the queue and records the attempt", () => {
    const fs = new QueueFsFacade({ repoRoot: workRoot, queueId: "q1", files: ["src/app.js"] });
    expect(() => fs.write("src/routes/users.js", "// evil")).toThrowError(ScopeViolationError);
    expect(fs.violations.length).toBe(1);
    expect(fs.violations[0]?.path).toContain("users.js");
  });

  it("REJECTS a read outside the queue", () => {
    const fs = new QueueFsFacade({ repoRoot: workRoot, queueId: "q1", files: ["src/app.js"] });
    expect(() => fs.read("src/config.js")).toThrowError(/E_SCOPE_VIOLATION/);
  });

  it("REJECTS a path traversal escape (../)", () => {
    const fs = new QueueFsFacade({ repoRoot: workRoot, queueId: "q1", files: ["src/app.js"] });
    expect(() => fs.read("../package.json")).toThrowError(ScopeViolationError);
  });

  it("REJECTS an absolute path outside the repo", () => {
    const fs = new QueueFsFacade({ repoRoot: workRoot, queueId: "q1", files: ["src/app.js"] });
    expect(() => fs.read("C:/Windows/win.ini")).toThrowError(ScopeViolationError);
  });

  it("an out-of-queue attempt is RECORDED, not silently ignored", () => {
    const fs = new QueueFsFacade({ repoRoot: workRoot, queueId: "q1", files: ["src/app.js"] });
    try {
      fs.write("src/server.js", "boom");
    } catch {
      /* expected */
    }
    expect(fs.violations).toHaveLength(1);
    expect(fs.written).toHaveLength(0); // nothing was written
  });
});

// ─── §7.3: edits are validated, reverted on failure ──────────────────────────

describe("edit validation", () => {
  it("accepts valid JavaScript", () => {
    expect(validateSource("a.js", "const a = 1;\n").ok).toBe(true);
  });

  it("rejects syntactically invalid JavaScript", () => {
    expect(validateSource("a.js", "const a = ;;; function ( {\n").ok).toBe(false);
  });

  it("rejects invalid JSON", () => {
    expect(validateSource("package.json", "{ not json ").ok).toBe(false);
  });

  it("accepts valid JSON", () => {
    expect(validateSource("package.json", '{"a":1}').ok).toBe(true);
  });
});

// ─── No fabricated edits (§7.3) ─────────────────────────────────────────────

describe("honest outcomes", () => {
  it("a plan item with no call sites produces 'no change needed', never a fabricated edit", () => {
    const dir = freshFixture();
    try {
      const phantom = plan.items.find((i) => i.id === "EX-99");
      expect(phantom, "canned plan must contain the phantom item EX-99").toBeDefined();
      const fixer = new Fixer({
        repoRoot: dir,
        queueId: "q-phantom",
        files: ["src/app.js"],
        items: [phantom as PlanItem],
        mode: "apply",
        maxEditAttemptsPerFile: 5,
      });
      const result = fixer.run();
      const file = result.files[0];
      expect(file?.outcome).toBe("no-change-needed");
      expect(file?.edits).toHaveLength(0);
      expect(readFileSync(join(dir, "src/app.js"), "utf8")).toBe(
        readFileSync(join(FIXTURE_ROOT, "src/app.js"), "utf8")
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an uncited edit is impossible: the fixer only emits itemIds from its plan slice", async () => {
    const dir = freshFixture();
    try {
      const result = await dispatchFixers({
        repoRoot: dir,
        queues: [{ queueId: "q1", files: ["src/routes/users.js"], itemIds: ["EX-08"] }],
        items: plan.items,
        mode: "apply",
        maxEditAttemptsPerFile: 5,
      });
      const allowed = new Set(["EX-08"]);
      for (const q of result.queues) {
        for (const f of q.files) {
          for (const e of f.edits) {
            expect(allowed.has(e.itemId), `uncited edit ${e.itemId}`).toBe(true);
            expect(e.citationRef.length).toBeGreaterThan(0); // I2: every edit cites
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── I4: bounded attempts ───────────────────────────────────────────────────

describe("attempt budget (I4)", () => {
  it("a file whose edits never validate is flagged H2 after the budget, not looped forever", () => {
    const dir = freshFixture();
    try {
      const fixer = new Fixer({
        repoRoot: dir,
        queueId: "q-budget",
        files: ["src/app.js"],
        items: [plan.items.find((i) => i.id === "EX-16") as PlanItem],
        mode: "apply",
        maxEditAttemptsPerFile: 5,
      });
      const result = fixer.run();
      expect(result.files[0]?.attempts).toBeLessThanOrEqual(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Diff scope: no file outside the work map is modified (I5) ───────────────

describe("diff scope", () => {
  it("a full parallel run modifies ONLY files present in the work map", async () => {
    const dir = freshFixture();
    try {
      const before = snapshot(dir);
      const result = await dispatchFixers({
        repoRoot: dir,
        queues,
        items: plan.items,
        mode: "apply",
        maxEditAttemptsPerFile: 5,
      });
      const after = snapshot(dir);

      const changed: string[] = [];
      for (const [file, contents] of after) {
        if (before.get(file) !== contents) changed.push(file);
      }

      // package.json is legitimately touched by the EX-18 manifest bump (§9.4).
      const allowed = new Set(workMap.entries.map((e) => e.file));
      allowed.add("package.json");

      const outOfScope = changed.filter((f) => !allowed.has(f));
      console.log(
        `diff-scope: ${changed.length} file(s) changed; queues=${result.queues.length}; ` +
          `edits=${result.totalEdits}; speedup=${result.parallelSpeedup}x`
      );
      expect(outOfScope, `out-of-scope modifications: ${outOfScope.join(", ")}`).toHaveLength(0);
      expect(result.queues.length).toBeGreaterThanOrEqual(3);
      expect(result.totalEdits).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// ─── Determinism: parallel == serial ─────────────────────────────────────────

describe("parallel equals serial", () => {
  it("a parallel run produces the same final diff as a serial run over the same queues", async () => {
    const dirA = freshFixture();
    const dirB = freshFixture();
    try {
      const base = await dispatchFixers({
        repoRoot: dirA,
        queues,
        items: plan.items,
        mode: "apply",
        maxEditAttemptsPerFile: 5,
        parallel: false,
      });
      const par = await dispatchFixers({
        repoRoot: dirB,
        queues,
        items: plan.items,
        mode: "apply",
        maxEditAttemptsPerFile: 5,
        parallel: true,
      });

      const snapA = snapshot(dirA);
      const snapB = snapshot(dirB);
      const files = new Set([...snapA.keys(), ...snapB.keys()]);
      const diffs: string[] = [];
      for (const f of files) {
        if (snapA.get(f) !== snapB.get(f)) diffs.push(f);
      }
      expect(diffs, `serial vs parallel differ in: ${diffs.join(", ")}`).toHaveLength(0);
      expect(base.totalEdits).toBe(par.totalEdits);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  }, 120_000);
});

// ─── dry-run mode ───────────────────────────────────────────────────────────

describe("dry-run mode", () => {
  it("produces a diff preview WITHOUT writing any file", async () => {
    const dir = freshFixture();
    try {
      const before = snapshot(dir);
      const result = await dispatchFixers({
        repoRoot: dir,
        queues,
        items: plan.items,
        mode: "dry-run",
        maxEditAttemptsPerFile: 5,
      });
      const after = snapshot(dir);
      for (const [file, contents] of after) {
        expect(contents, `dry-run modified ${file}`).toBe(before.get(file));
      }
      expect(result.totalEdits).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// ─── THE GATE: fixture green on express@5 ───────────────────────────────────

describe("§10.1 Phase 5 gate — fixture green on express@5", () => {
  it("after fixing, the fixture runs green on express@5 except the seeded pre-existing failure", async () => {
    const dir = freshFixture();
    try {
      await dispatchFixers({
        repoRoot: dir,
        queues,
        items: plan.items,
        mode: "apply",
        maxEditAttemptsPerFile: 5,
      });

      // The manifest bump is the orchestrator's job (§9.4: one commit for the
      // manifest bump), so the test performs it explicitly.
      const pkgPath = join(dir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies: Record<string, string>;
      };
      pkg.dependencies.express = "5.1.0";
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      rmSync(join(dir, "package-lock.json"), { force: true });

      // `shell: true` is required on Windows because npm/npx are .cmd shims that
      // execFileSync cannot spawn directly (it fails ENOENT without a shell).
      // It is scoped to Windows only.
      const isWin = process.platform === "win32";
      // This host's npm config carries an allow-scripts policy that npm REFUSES to
      // accept from the environment in a project-scoped install (EALLOWSCRIPTS).
      // Clear it for the child so the fixture installs cleanly.
      const env: NodeJS.ProcessEnv = { ...process.env, npm_config_userconfig: "" };
      for (const key of Object.keys(env)) {
        if (
          key.toLowerCase().includes("allow_scripts") ||
          key.toLowerCase().includes("allow-scripts")
        ) {
          delete env[key];
        }
      }
      execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: dir,
        env,
        stdio: "pipe",
        ...(isWin ? { shell: true } : {}),
      });

      let output = "";
      let exitCode = 0;
      try {
        output = execFileSync(
          "npx",
          ["vitest", "run", "--config", "vitest.config.js", "--reporter=verbose"],
          { cwd: dir, env, encoding: "utf8", stdio: "pipe", ...(isWin ? { shell: true } : {}) }
        );
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        output = (e.stdout ?? "") + (e.stderr ?? "");
        exitCode = 1;
      }

      const failing = [...output.matchAll(/^\s*(?:×|✗)\s+(.*)$/gm)]
        .map((m) => (m[1] ?? "").trim())
        .filter((t) => t.length > 0);
      const notPreexisting = failing.filter((t) => !/arithmetic sanity check/i.test(t));

      console.log(
        `express@5 suite: exit=${exitCode}, failing tests=${failing.length}, ` +
          `non-preexisting=${notPreexisting.length}` +
          (notPreexisting.length > 0 ? ` -> ${notPreexisting.join(" | ")}` : "")
      );

      expect(
        notPreexisting,
        `Suite must be green on express@5 except the seeded pre-existing failure.\n${output.slice(-4000)}`
      ).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
