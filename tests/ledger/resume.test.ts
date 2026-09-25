// tests/ledger/resume.test.ts
// I7 acceptance: "Runs are resumable and idempotent."
//
// SPEC.md §3.2 / §10.1 Phase 2 gate: "crash after IMPACT resumes at BASELINE;
// same key returns same runId".
//
// This proves the claim against a REAL ledger on disk, in the in-repo sandbox. It
// simulates a crash by abandoning a run mid-pipeline (stages left `running`), then
// resumes and asserts the run continues from the checkpoint rather than restarting
// or silently skipping work.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

import { SANDBOX_ROOT } from "../helpers/sandbox.js";
import {
  createRun,
  readLedger,
  startStage,
  checkpoint,
  ledgerPath,
  type RunLedger,
} from "../../src/core/ledger.js";
import { MajorTomError } from "../../src/core/errors.js";

// Vitest runs test FILES in parallel, so teardown must remove ONLY this file's
// sandbox directory. Wiping the shared SANDBOX_ROOT would delete a sibling file's
// in-flight fixtures (observed as ENOTEMPTY under concurrent rmSync).
let current = "";

function repo(): string {
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  const dir = join(SANDBOX_ROOT, `resume-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  current = dir;
  return dir;
}

const KEY = "sha256:C:/repo@abc123:express:5.1.0";

function start(root: string) {
  return createRun({
    repoRoot: root,
    target: { ecosystem: "npm", name: "express", fromVersion: "4.18.2", toVersion: "5.1.0" },
    repo: {
      root,
      commitSha: "abc123",
      baseBranch: "main",
      workBranch: "majortom/pending",
      dirty: false,
    },
    guide: { kind: "markdown", path: "guides/express5.md", sha256: "deadbeef", pages: null },
    idempotencyKeyValue: KEY,
  });
}

afterEach(() => {
  if (current && existsSync(current)) {
    rmSync(current, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  current = "";
});

describe("I7 — idempotency", () => {
  let root: string;
  beforeEach(() => {
    root = repo();
  });

  it("the same idempotency key returns the SAME runId and does not create a second run", () => {
    const first = start(root);
    const second = start(root);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);

    // Exactly one run directory exists.
    const runsDir = join(root, ".majortom", "runs");
    expect(readdirSync(runsDir)).toHaveLength(1);
  });

  it("a different key creates a genuinely different run", () => {
    const first = start(root);
    const second = createRun({
      repoRoot: root,
      target: { ecosystem: "npm", name: "lodash", fromVersion: "3.0.0", toVersion: "4.0.0" },
      repo: {
        root,
        commitSha: "abc123",
        baseBranch: "main",
        workBranch: "majortom/pending",
        dirty: false,
      },
      guide: { kind: "markdown", path: "guides/lodash4.md", sha256: "cafe", pages: null },
      idempotencyKeyValue: "sha256:C:/repo@abc123:lodash:4.0.0",
    });
    expect(second.runId).not.toBe(first.runId);
  });

  it("refuses to re-create a FAILED run without force, and allows it with force", () => {
    const first = start(root);
    // Drive the run into `failed` by failing its first stage. INTAKE must be
    // checkpointed before PLAN can legally start (the ledger enforces §3.1 order).
    startStage(root, first.runId, "INTAKE");
    checkpoint(root, first.runId, "INTAKE", "intake.json", {});
    startStage(root, first.runId, "PLAN");
    const led = readLedger(root, first.runId);
    const plan = led.stages.find((s) => s.stage === "PLAN");
    expect(plan?.state).toBe("running");

    // Simulate a crash: the stage is left `running` and the run is marked failed.
    const crashed = {
      ...led,
      status: "failed" as const,
    };
    writeFileSync(ledgerPath(root, first.runId), JSON.stringify(crashed, null, 2), "utf8");

    expect(() => start(root)).toThrowError(MajorTomError);

    const forced = createRun({
      repoRoot: root,
      target: { ecosystem: "npm", name: "express", fromVersion: "4.18.2", toVersion: "5.1.0" },
      repo: {
        root,
        commitSha: "abc123",
        baseBranch: "main",
        workBranch: "majortom/pending",
        dirty: false,
      },
      guide: { kind: "markdown", path: "guides/express5.md", sha256: "deadbeef", pages: null },
      idempotencyKeyValue: KEY,
      force: true,
    });
    expect(forced.created).toBe(true);
    expect(forced.runId).not.toBe(first.runId);
  });
});

describe("I7 — resume after a crash mid-pipeline", () => {
  let root: string;
  beforeEach(() => {
    root = repo();
  });

  it("a run checkpointed through IMPACT resumes at BASELINE, not from the start", () => {
    const { runId } = start(root);

    // Walk INTAKE → PLAN → IMPACT exactly as the orchestrator does.
    startStage(root, runId, "INTAKE");
    checkpoint(root, runId, "INTAKE", "intake.json", { repoRoot: root, baseCommit: "abc123" });
    startStage(root, runId, "PLAN");
    checkpoint(root, runId, "PLAN", "plan.json", { items: [] });
    startStage(root, runId, "IMPACT");
    checkpoint(root, runId, "IMPACT", "workmap.json", { entries: [], queues: [] });

    const afterImpact = readLedger(root, runId);
    const completed = afterImpact.stages
      .filter((s) => s.state === "checkpointed")
      .map((s) => s.stage);
    expect(completed).toEqual(["INTAKE", "PLAN", "IMPACT"]);
    expect(afterImpact.stages.some((s) => s.stage === "BASELINE")).toBe(false);

    // ── CRASH: the process dies here. Nothing is lost: the ledger is on disk. ──
    const onDisk = JSON.parse(readFileSync(ledgerPath(root, runId), "utf8")) as RunLedger;
    expect(onDisk.status).toBe("running");
    expect(onDisk.stages).toHaveLength(3);

    // ── RESUME: a fresh process reads the ledger and continues. ──
    const resumed = readLedger(root, runId);
    const done = new Set(
      resumed.stages.filter((s) => s.state === "checkpointed").map((s) => s.stage)
    );

    // Every previously-completed stage is still checkpointed — the resume did not
    // discard or redo them.
    expect(done.has("INTAKE")).toBe(true);
    expect(done.has("PLAN")).toBe(true);
    expect(done.has("IMPACT")).toBe(true);

    // The next stage the orchestrator is allowed to start is BASELINE, and the ledger
    // ACCEPTS it — proving the stage-ordering guard is satisfied by the checkpoint.
    startStage(root, runId, "BASELINE");
    const afterResume = readLedger(root, runId);
    const baseline = afterResume.stages.find((s) => s.stage === "BASELINE");
    expect(baseline?.state).toBe("running");

    // The earlier stage records are untouched by the resume.
    const stillThere = afterResume.stages
      .filter((s) => s.state === "checkpointed")
      .map((s) => s.stage);
    expect(stillThere).toEqual(["INTAKE", "PLAN", "IMPACT"]);
  });

  it("the artifacts written before the crash are still readable after it", () => {
    const { runId } = start(root);
    startStage(root, runId, "INTAKE");
    checkpoint(root, runId, "INTAKE", "intake.json", { baseCommit: "abc123" });
    startStage(root, runId, "PLAN");
    checkpoint(root, runId, "PLAN", "plan.json", { items: [{ id: "EX-01" }] });

    const planPath = join(root, ".majortom", "runs", runId, "artifacts", "plan.json");
    expect(existsSync(planPath)).toBe(true);
    expect(JSON.parse(readFileSync(planPath, "utf8"))).toEqual({ items: [{ id: "EX-01" }] });
  });

  it("a stage cannot be restarted out of order — the ledger refuses (I7 integrity)", () => {
    const { runId } = start(root);
    startStage(root, runId, "INTAKE");
    checkpoint(root, runId, "INTAKE", "intake.json", {});

    // Skipping PLAN and trying to start EXECUTE must fail: PLAN is not checkpointed.
    expect(() => startStage(root, runId, "EXECUTE")).toThrowError(MajorTomError);
  });

  it("re-starting a checkpointed stage is a safe NO-OP, not a redo (resume-safe)", () => {
    // §3.1: a legal transition is "previous stage is checkpointed or skipped". The
    // ledger deliberately does NOT let a checkpointed stage drop back to `running` —
    // that would silently discard the checkpoint and redo work. A resumed run that
    // calls startStage() on already-done work is therefore a no-op: the checkpoint
    // survives. This is what makes I7 resume safe rather than merely possible.
    const { runId } = start(root);
    startStage(root, runId, "INTAKE");
    checkpoint(root, runId, "INTAKE", "intake.json", { baseCommit: "abc123" });

    expect(() => startStage(root, runId, "INTAKE")).not.toThrow();
    const led = readLedger(root, runId);
    const intake = led.stages.find((s) => s.stage === "INTAKE");
    // State is UNCHANGED — still checkpointed, work not lost.
    expect(intake?.state).toBe("checkpointed");
  });
});
