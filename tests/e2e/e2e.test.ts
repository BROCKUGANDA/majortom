// tests/e2e/e2e.test.ts
// Phase 8 acceptance: the seven-stage run, end to end, on a copy of the fixture.
//
// The heavy lifting is proven where it belongs — the Phase 5 gate really installs
// express@5 and really runs the fixture's supertest suite. Here we prove the parts
// only a full run exercises: stage ORDER, ledger checkpointing, the honest NOT GREEN
// verdict, the bounded verify loop, and I1/I2/I5 at run level.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, rmSync, mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { runMigration, runBranchName } from "../../src/core/orchestrator.js";
import { readLedger } from "../../src/core/ledger.js";
import type { Baseline } from "../../src/verify/schemas.js";

const FIXTURE_ROOT = resolve("fixtures/express4");
const GUIDE = resolve("guides/express5.md");

function base(results: Array<[string, "pass" | "fail"]>): Baseline {
  return {
    runner: "vitest",
    command: "npx vitest run",
    exitCode: 0,
    totalMs: 10,
    results: results.map(([id, status]) => ({ id, status, durationMs: 1, message: status === "fail" ? "x" : null })),
    failingIds: results.filter(([, s]) => s === "fail").map(([id]) => id),
    collectionErrors: [],
  };
}

const baseCfg = {
  dependency: "express",
  fromVersion: "4.18.2",
  toVersion: "5.1.0",
  guide: GUIDE,
  testCommand: ["vitest", "run"],
  testRunner: "vitest" as const,
  parallelism: 3,
  maxEditAttemptsPerFile: 5,
  maxVerifyIterations: 3,
  timeoutMs: 240_000,
  dryRun: false,
};

let roots: string[] = [];
function freshFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "majortom-e2e-"));
  cpSync(FIXTURE_ROOT, dir, { recursive: true });
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("I1 — the run branch", () => {
  it("is always majortom/<runId> and never main or master", () => {
    expect(runBranchName("01M3CSNT41F001")).toBe("majortom/01M3CSNT41F001");
    expect(runBranchName("abc")).not.toBe("main");
    expect(runBranchName("abc")).not.toBe("master");
  });
});

describe("seven-stage run", () => {
  let result: Awaited<ReturnType<typeof runMigration>>;
  let dir: string;

  beforeAll(async () => {
    dir = freshFixture();
    result = await runMigration({
      ...baseCfg,
      repoRoot: dir,
      // Injected so the test does not re-run npm; the REAL suite execution is the
      // Phase 5 gate's job. The baseline here has one seeded pre-existing failure,
      // exactly as the fixture defines it.
      baselineOverride: base([
        ["tests/app.test.js::GET /health::returns ok", "pass"],
        ["tests/preexisting.test.js::arithmetic sanity check::stays broken", "fail"],
      ]),
      postOverride: base([
        ["tests/app.test.js::GET /health::returns ok", "pass"],
        ["tests/preexisting.test.js::arithmetic sanity check::stays broken", "fail"],
      ]),
    });
  }, 180_000);

  it("runs INTAKE → PLAN → IMPACT → BASELINE → EXECUTE → VERIFY → REPORT in order", () => {
    const order = result.stages.map((s) => s.stage);
    expect(order).toEqual(["INTAKE", "PLAN", "IMPACT", "BASELINE", "EXECUTE", "VERIFY", "REPORT"]);
  });

  it("checkpoints every stage to the ledger (I7)", () => {
    const ledger = readLedger(dir, result.runId);
    const checkpointed = ledger.stages.filter((s) => s.state === "checkpointed").map((s) => s.stage);
    for (const stage of ["PLAN", "IMPACT", "BASELINE", "EXECUTE", "VERIFY", "REPORT"]) {
      expect(checkpointed, `stage ${stage} not checkpointed`).toContain(stage);
    }
  });

  it("writes the §3.2 artifact set to disk", () => {
    for (const artifact of ["plan.json", "workmap.json", "baseline.json", "verify.json", "report.md"]) {
      const p = join(dir, ".majortom", "runs", result.runId, "artifacts", artifact);
      expect(existsSync(p), `missing artifact ${artifact}`).toBe(true);
    }
  });

  it("report.md on disk is the report the run returned", () => {
    const p = join(dir, ".majortom", "runs", result.runId, "artifacts", "report.md");
    expect(readFileSync(p, "utf8")).toBe(result.report);
  });

  it("is GREEN when the only failure was pre-existing (I8)", () => {
    expect(result.green).toBe(true);
    expect(result.report).toContain("GREEN");
  });

  it("citation coverage is 1.0 — every applied edit cites a plan item (I2)", () => {
    expect(result.citationCoverage).toBe(1);
    expect(result.report).toContain("| citation coverage | - | 100% |");
  });

  it("applied edits, and every changed file is in the work map (I5)", () => {
    expect(result.changedFiles.length).toBeGreaterThan(0);
    const outOfScope = result.changedFiles.filter((f) => !result.workMapFiles.includes(f));
    expect(outOfScope, `out-of-scope: ${outOfScope.join(", ")}`).toHaveLength(0);
  });

  it("reached a green verdict on the first verify iteration", () => {
    expect(result.verifyIterations).toBe(1);
  });
});

describe("I6 — an honest NOT GREEN verdict", () => {
  it("reports NOT GREEN and names the migration-caused failure", async () => {
    const dir = freshFixture();
    const result = await runMigration({
      ...baseCfg,
      repoRoot: dir,
      baselineOverride: base([
        ["tests/app.test.js::GET /health::returns ok", "pass"],
        ["tests/preexisting.test.js::arithmetic sanity check::stays broken", "fail"],
      ]),
      // A test that passed at baseline now fails, inside a queued file: this is
      // migration damage, and the run must say so.
      postOverride: base([
        ["tests/app.test.js::GET /health::returns ok", "fail"],
        ["tests/preexisting.test.js::arithmetic sanity check::stays broken", "fail"],
      ]),
    });

    expect(result.green).toBe(false);
    expect(result.report).toContain("NOT GREEN");
    expect(result.report).toContain("must not be merged");
    expect(result.failures.some((f) => f.classification === "migration_caused")).toBe(true);
  }, 180_000);
});

describe("I4 — the verify loop is bounded", () => {
  it("stops at maxVerifyIterations and does not loop forever", async () => {
    const dir = freshFixture();
    const result = await runMigration({
      ...baseCfg,
      repoRoot: dir,
      maxVerifyIterations: 2,
      baselineOverride: base([["tests/app.test.js::GET /health::returns ok", "pass"]]),
      // Always red: the injected post-run never changes, so no iteration can help.
      postOverride: base([["tests/app.test.js::GET /health::returns ok", "fail"]]),
    });

    expect(result.verifyIterations).toBeLessThanOrEqual(2);
    expect(result.green).toBe(false);
  }, 180_000);
});

describe("§8.1 — no tests is fatal", () => {
  it("fails the run with E_NO_TESTS rather than claiming anything", async () => {
    const dir = freshFixture();
    const result = await runMigration({
      ...baseCfg,
      repoRoot: dir,
      baselineOverride: base([]),
      postOverride: base([]),
    });

    expect(result.green).toBe(false);
    expect(result.error).toBe("E_NO_TESTS");
    expect(result.report).toContain("NOT GREEN");
    expect(result.stages.find((s) => s.stage === "BASELINE")?.state).toBe("failed");
  }, 180_000);
});
