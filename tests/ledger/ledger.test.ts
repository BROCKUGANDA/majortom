// tests/ledger/ledger.test.ts
// Phase 2 acceptance tests for the run ledger + state machine (SPEC.md §3)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SANDBOX_ROOT } from "../helpers/sandbox.js";
import {
  createRun,
  startStage,
  checkpoint,
  failStage,
  resume,
  metricsFromLedger,
  readLedger,
  ledgerPath,
  RunLedger,
} from "../../src/core/ledger.js";
import { MajorTomError } from "../../src/core/errors.js";
import { idempotencyKey } from "../../src/core/ids.js";
import { STAGE_ORDER } from "../../src/core/schemas.js";

// ─── test helpers ───────────────────────────────────────────────────────────

afterEach(() => {
  if (current && existsSync(current)) {
    rmSync(current, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  current = "";
});

// Vitest runs test FILES in parallel, so teardown removes ONLY this file's sandbox
// directory. Wiping the shared root would delete a sibling file's in-flight fixtures.
let current = "";

function tmpRepo(): string {
  // In-repo sandbox, not os.tmpdir() — see tests/helpers/sandbox.ts for why.
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  const dir = join(SANDBOX_ROOT, `ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  current = dir;
  return dir;
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const DUMMY_TARGET: RunLedger["target"] = {
  ecosystem: "npm",
  name: "express",
  fromVersion: "4.21.2",
  toVersion: "5.0.0",
};

const DUMMY_REPO = (root: string): RunLedger["repo"] => ({
  root,
  commitSha: "abc123",
  baseBranch: "main",
  workBranch: "majortom/test",
  dirty: false,
});

const DUMMY_GUIDE: RunLedger["guide"] = {
  kind: "markdown",
  path: "guides/express5.md",
  sha256: "deadbeef",
  pages: null,
};

function makeKey(root: string) {
  return idempotencyKey(root, "abc123", "express", "5.0.0");
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("createRun — idempotency", () => {
  it("same idempotency key returns the same runId when run is running", () => {
    const root = tmpRepo();
    try {
      const key = makeKey(root);
      const { runId } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });
      const { runId: runId2, created } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });
      expect(runId2).toBe(runId);
      expect(created).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  it("force=true creates a new runId after a failed run", () => {
    const root = tmpRepo();
    try {
      const key = makeKey(root);
      const { runId } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });

      // Fail the run
      startStage(root, runId, "INTAKE");
      failStage(root, runId, "INTAKE", new MajorTomError("E_REPO_DIRTY", "dirty repo"));

      // Without force: throws
      expect(() =>
        createRun({
          repoRoot: root,
          target: DUMMY_TARGET,
          repo: DUMMY_REPO(root),
          guide: DUMMY_GUIDE,
          idempotencyKeyValue: key,
        })
      ).toThrow();

      // With force: new runId
      const { runId: runId2, created } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
        force: true,
      });
      expect(runId2).not.toBe(runId);
      expect(created).toBe(true);
    } finally {
      cleanup(root);
    }
  });
});

describe("stage transitions", () => {
  it("rejects a stage started out of order", () => {
    const root = tmpRepo();
    try {
      const key = makeKey(root);
      const { runId } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });

      // Try to start PLAN without INTAKE being checkpointed
      expect(() => startStage(root, runId, "PLAN")).toThrow();
    } finally {
      cleanup(root);
    }
  });

  it("allows stages in legal order", () => {
    const root = tmpRepo();
    try {
      const key = makeKey(root);
      const { runId } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });

      startStage(root, runId, "INTAKE");
      checkpoint(root, runId, "INTAKE", "plan.json", { test: "intake-artifact" });

      startStage(root, runId, "PLAN");
      checkpoint(root, runId, "PLAN", "plan.json", { schemaVersion: 1, items: [] });

      const ledger = readLedger(root, runId);
      const stages = ledger.stages.filter((s) => s.state === "checkpointed");
      expect(stages).toHaveLength(2);
      expect(stages[0]!.stage).toBe("INTAKE");
      expect(stages[1]!.stage).toBe("PLAN");
    } finally {
      cleanup(root);
    }
  });
});

describe("crash + resume", () => {
  it("crash after IMPACT checkpoint: resume continues at BASELINE; IMPACT does NOT run twice", () => {
    const root = tmpRepo();
    try {
      const key = makeKey(root);
      const { runId } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });

      // Run INTAKE
      startStage(root, runId, "INTAKE");
      checkpoint(root, runId, "INTAKE", "plan.json", { stage: "intake" });

      // Run PLAN
      startStage(root, runId, "PLAN");
      checkpoint(root, runId, "PLAN", "plan.json", { stage: "plan" });

      // Run IMPACT — checkpointed
      startStage(root, runId, "IMPACT");
      checkpoint(root, runId, "IMPACT", "workmap.json", { stage: "impact" });

      // Simulate crash: start BASELINE but don't checkpoint (leave it running)
      startStage(root, runId, "BASELINE");
      // ← process dies here

      // Count IMPACT appearances before resume
      const preLedger = readLedger(root, runId);
      const impactCountBefore = preLedger.stages.filter((s) => s.stage === "IMPACT").length;

      // Resume
      const result = resume(root, runId);

      // The running BASELINE stage is discarded
      // Next stage to run should be BASELINE
      expect(result.nextStage).toBe("BASELINE");

      // IMPACT should still appear exactly once (checkpointed), not re-run
      const postLedger = readLedger(root, runId);
      const impactCountAfter = postLedger.stages.filter(
        (s) => s.stage === "IMPACT" && s.state === "checkpointed"
      ).length;
      expect(impactCountAfter).toBe(1);
      expect(impactCountAfter).toBe(impactCountBefore - 0); // no change in checkpointed count

      // BASELINE running record should be gone
      const baselineRunning = postLedger.stages.find(
        (s) => s.stage === "BASELINE" && s.state === "running"
      );
      expect(baselineRunning).toBeUndefined();
    } finally {
      cleanup(root);
    }
  });

  it("resume never re-executes a checkpointed stage", () => {
    const root = tmpRepo();
    try {
      const key = makeKey(root);
      const { runId } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });

      startStage(root, runId, "INTAKE");
      checkpoint(root, runId, "INTAKE", "plan.json", { ok: true });

      const result = resume(root, runId);
      expect(result.nextStage).toBe("PLAN");

      const ledger = readLedger(root, runId);
      // INTAKE should be checkpointed exactly once
      const intakeCheckpointed = ledger.stages.filter(
        (s) => s.stage === "INTAKE" && s.state === "checkpointed"
      );
      expect(intakeCheckpointed).toHaveLength(1);
    } finally {
      cleanup(root);
    }
  });
});

describe("ledger validates against zod after a simulated seven-stage run", () => {
  it("produces a valid ledger after all 7 stages", () => {
    const root = tmpRepo();
    try {
      const key = makeKey(root);
      const { runId } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });

      const artifacts: Record<string, string> = {
        INTAKE: "plan.json",
        PLAN: "plan.json",
        IMPACT: "workmap.json",
        BASELINE: "baseline.json",
        EXECUTE: "diff.patch",
        VERIFY: "verify.json",
        REPORT: "report.md",
      };

      for (const stage of STAGE_ORDER) {
        startStage(root, runId, stage);
        checkpoint(root, runId, stage, artifacts[stage]!, { stage });
      }

      const ledger = readLedger(root, runId);
      // Zod validates on read — if it doesn't throw, it's valid
      expect(ledger.schemaVersion).toBe(1);
      expect(ledger.stages).toHaveLength(7);
      expect(ledger.stages.every((s) => s.state === "checkpointed")).toBe(true);
    } finally {
      cleanup(root);
    }
  });
});

describe("atomic write: truncated ledger is detected", () => {
  it("throws when the ledger file is truncated/corrupted", () => {
    const root = tmpRepo();
    try {
      const key = makeKey(root);
      const { runId } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });

      // Corrupt the ledger file
      const lPath = ledgerPath(root, runId);
      writeFileSync(lPath, '{"schemaVersion": 1, "runId": "truncat', "utf8");

      // Reading should throw
      expect(() => readLedger(root, runId)).toThrow();
    } finally {
      cleanup(root);
    }
  });
});

describe("metricsFromLedger", () => {
  it("returns metrics from a complete ledger", () => {
    const root = tmpRepo();
    try {
      const key = makeKey(root);
      const { runId } = createRun({
        repoRoot: root,
        target: DUMMY_TARGET,
        repo: DUMMY_REPO(root),
        guide: DUMMY_GUIDE,
        idempotencyKeyValue: key,
      });

      startStage(root, runId, "INTAKE");
      checkpoint(root, runId, "INTAKE", "plan.json", {});

      const metrics = metricsFromLedger(root, runId);
      expect(metrics.humanTouches).toBe(0);
      expect(metrics.fixerIterations).toBe(0);
      expect(metrics.wallClockMs).toBeNull();
    } finally {
      cleanup(root);
    }
  });
});
