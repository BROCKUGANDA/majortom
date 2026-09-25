// src/core/orchestrator.ts — the seven-stage pipeline, SPEC.md §3
//
//   INTAKE → PLAN → IMPACT → BASELINE → EXECUTE → VERIFY → REPORT
//
// I7: every stage checkpoints to the ledger, so a run is resumable and idempotent.
// I4: the whole run is bounded by a hard timeout; the verify loop by maxVerifyIterations.
// I6: VERIFY exhaustion does NOT abort — the run proceeds to REPORT with a NOT GREEN
//     verdict, because an honest failure report is the required output (SPEC.md §3.3).
//
// The orchestrator is the ONLY component allowed to invoke the package manager and the
// test runner (I9). Fixer subagents receive a filesystem facade and nothing else.

import { createRun, readLedger, startStage, checkpoint, failStage } from "./ledger.js";
import { MajorTomError } from "./errors.js";
import { ingestGuide } from "../docs/ingest.js";
import { readGuide } from "../docs/docreader.js";
import { impactScan } from "../scanner/impact.js";
import { partition } from "../scanner/partition.js";
import { dispatchFixers } from "../agents/dispatcher.js";
import { runSuite } from "../verify/adapters.js";
import { classify, ownershipFromQueues } from "../verify/classify.js";
import { computeCitationCoverage, renderReport } from "../report/report.js";
import type { MigrationPlan, PlanItem } from "../docs/schemas.js";
import type { Baseline, ClassifiedFailure } from "../verify/schemas.js";
import type { RunLedger } from "./ledger.js";

export interface OrchestratorConfig {
  repoRoot: string;
  dependency: string;
  fromVersion: string;
  toVersion: string;
  /** Local path, URL, or raw markdown for the migration guide. */
  guide: string;
  testCommand: string[];
  testRunner: "vitest" | "jest";
  /** Parallel fixer fan-out width (§6.2). */
  parallelism: number;
  maxEditAttemptsPerFile: number;
  maxVerifyIterations: number;
  /** Hard run timeout (I4). */
  timeoutMs: number;
  dryRun: boolean;
  /** For tests: inject a baseline instead of really running the suite. */
  baselineOverride?: Baseline;
  /** For tests: inject the post-edit run instead of really running the suite. */
  postOverride?: Baseline;
}

export interface StageOutcome {
  stage: string;
  state: "checkpointed" | "skipped" | "failed";
  artifact?: string;
  detail?: string;
}

export interface RunResult {
  runId: string;
  green: boolean;
  ledger: RunLedger;
  stages: StageOutcome[];
  plan: MigrationPlan;
  report: string;
  citationCoverage: number;
  changedFiles: string[];
  workMapFiles: string[];
  failures: ClassifiedFailure[];
  verifyIterations: number;
  wallClockMs: number;
  baseCommit: string;
  /** Populated when the run could not complete honestly. */
  error?: string;
}

function listFiles(dir: string, skip: Set<string> = new Set(["node_modules", ".git", ".majortom"])): string[] {
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d)) {
      if (skip.has(entry)) continue;
      const abs = join(d, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

function gitHead(repoRoot: string): string {
  const { execFileSync } = require("child_process") as typeof import("child_process");
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** I1: the run branch is derived from the runId and never targets main/master. */
export function runBranchName(runId: string): string {
  return `majortom/${runId}`;
}

export async function runMigration(cfg: OrchestratorConfig): Promise<RunResult> {
  const startedAt = Date.now();
  const deadline = startedAt + cfg.timeoutMs;
  const stages: StageOutcome[] = [];

  // ---- INTAKE -------------------------------------------------------------
  const baseCommit = gitHead(cfg.repoRoot);
  const idempotencyKeyValue = `${cfg.repoRoot}:${baseCommit}:${cfg.dependency}:${cfg.toVersion}`;
  const { runId } = createRun({
    repoRoot: cfg.repoRoot,
    target: {
      ecosystem: "npm",
      name: cfg.dependency,
      fromVersion: cfg.fromVersion,
      toVersion: cfg.toVersion,
    },
    repo: {
      root: cfg.repoRoot,
      commitSha: baseCommit,
      baseBranch: "main",
      workBranch: runBranchName("pending"),
      dirty: false,
    },
    guide: {
      kind: /\.pdf$/i.test(cfg.guide) ? "pdf" : "markdown",
      path: cfg.guide,
      sha256: "",
      pages: null,
    },
    idempotencyKeyValue,
  });
  void idempotencyKeyValue;

  let ledger = readLedger(cfg.repoRoot, runId);
  stages.push({ stage: "INTAKE", state: "checkpointed" });

  const artifactFor = {
    INTAKE: "intake.json",
    PLAN: "plan.json",
    IMPACT: "workmap.json",
    BASELINE: "baseline.json",
    EXECUTE: "diff.patch",
    VERIFY: "verify.json",
    REPORT: "report.md",
  } as const;

  const overrun = (): boolean => Date.now() > deadline;

  // ---- PLAN ---------------------------------------------------------------
  startStage(cfg.repoRoot, runId, "PLAN");
  const artifact = ingestGuide(cfg.repoRoot, cfg.guide, { maxGuidePages: 200 });
  const read = readGuide({
    artifact,
    dependency: { name: cfg.dependency, from: cfg.fromVersion, to: cfg.toVersion },
  });
  const plan: MigrationPlan = read.plan;
  checkpoint(cfg.repoRoot, runId, "PLAN", artifactFor.PLAN, plan);
  stages.push({ stage: "PLAN", state: "checkpointed" });

  // ---- IMPACT -------------------------------------------------------------
  startStage(cfg.repoRoot, runId, "IMPACT");
  const scan = await impactScan(cfg.repoRoot, plan.items);
  const queues = partition(scan.entries, cfg.parallelism);
  const workMap = {
    entries: scan.entries,
    queues: queues.map((q) => ({ queueId: q.queueId, files: q.files, itemIds: q.itemIds })),
    unmatchedItemIds: scan.unmatchedItemIds,
  };
  checkpoint(cfg.repoRoot, runId, "IMPACT", artifactFor.IMPACT, workMap);
  stages.push({ stage: "IMPACT", state: "checkpointed" });

  const before = snapshotContents(cfg.repoRoot);

  // ---- BASELINE -----------------------------------------------------------
  // §8.1: the baseline is captured BEFORE any edit. No tests is fatal (E_NO_TESTS).
  startStage(cfg.repoRoot, runId, "BASELINE");
  const baseline: Baseline =
    cfg.baselineOverride ??
    (await runSuite({
      repoRoot: cfg.repoRoot,
      runner: cfg.testRunner,
      timeoutMs: Math.max(1_000, deadline - Date.now()),
    }));
  if (baseline.results.length === 0 && baseline.collectionErrors.length === 0) {
    failStage(
      cfg.repoRoot,
      runId,
      "BASELINE",
      new MajorTomError("E_NO_TESTS", "no tests found — cannot establish a baseline")
    );
    stages.push({ stage: "BASELINE", state: "failed", detail: "E_NO_TESTS" });
    ledger = readLedger(cfg.repoRoot, runId);
    return {
      runId,
      green: false,
      ledger,
      stages,
      plan,
      report: `# MajorTom Migration Report - ${cfg.dependency} ${cfg.fromVersion} -> ${cfg.toVersion}\n\n## Verdict\nNOT GREEN - no tests were found, so no baseline could be established and no claim about this migration can be made.`,
      citationCoverage: 1,
      changedFiles: [],
      workMapFiles: [],
      failures: [],
      verifyIterations: 0,
      wallClockMs: Date.now() - startedAt,
      baseCommit,
      error: "E_NO_TESTS",
    };
  }
  checkpoint(cfg.repoRoot, runId, "BASELINE", artifactFor.BASELINE, baseline);
  stages.push({ stage: "BASELINE", state: "checkpointed" });

  // ---- EXECUTE ------------------------------------------------------------
  startStage(cfg.repoRoot, runId, "EXECUTE");
  const dispatch = await dispatchFixers({
    repoRoot: cfg.repoRoot,
    queues: workMap.queues,
    items: plan.items,
    mode: cfg.dryRun ? "dry-run" : "apply",
    maxEditAttemptsPerFile: cfg.maxEditAttemptsPerFile,
    parallel: true,
  });
  checkpoint(cfg.repoRoot, runId, "EXECUTE", artifactFor.EXECUTE, {
    queues: dispatch.queues,
    totalEdits: dispatch.totalEdits,
    parallelSpeedup: dispatch.parallelSpeedup,
    wallClockMs: dispatch.wallClockMs,
  });
  stages.push({ stage: "EXECUTE", state: "checkpointed" });

  const after = cfg.dryRun ? before : snapshotContents(cfg.repoRoot);
  const changedFiles = [...after.entries()]
    .filter(([file, content]) => before.get(file) !== content)
    .map(([file]) => file);
  const workMapFiles = workMap.entries.map((e) => e.file);

  // ---- VERIFY (bounded, §8) ------------------------------------------------
  startStage(cfg.repoRoot, runId, "VERIFY");
  const ownership = ownershipFromQueues(
    workMap.queues.map((q) => ({ queueId: q.queueId, files: q.files }))
  );
  let postRun: Baseline | null = null;
  let failures: ClassifiedFailure[] = [];
  let green = false;
  let verifyIterations = 0;

  for (let i = 1; i <= cfg.maxVerifyIterations; i++) {
    if (overrun()) break;
    verifyIterations = i;
    postRun =
      cfg.postOverride ??
      (await runSuite({
        repoRoot: cfg.repoRoot,
        runner: cfg.testRunner,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
      }));

    const classified = classify({ baseline, post: postRun, ownership });
    failures = classified.failures;
    green = classified.green;
    if (green) break;

    // I4: only a migration_caused failure in a QUEUED file is worth another pass.
    // Everything else (pre-existing, orphaned, flaky) will not change by re-running.
    const routable = failures.filter(
      (f) => f.classification === "migration_caused" && !f.orphaned
    );
    if (routable.length === 0) break; // bounded honestly: no progress is possible

    if (i < cfg.maxVerifyIterations) {
      const targetFiles = [...new Set(routable.map((f) => f.file).filter(Boolean))] as string[];
      for (const q of workMap.queues) {
        const retryItems = plan.items.filter(
          (it) => q.itemIds.includes(it.id) && targetFiles.some((tf) => q.files.includes(tf))
        );
        if (retryItems.length === 0) continue;
        await dispatchFixers({
          repoRoot: cfg.repoRoot,
          queues: [{ queueId: q.queueId, files: targetFiles, itemIds: retryItems.map((r) => r.id) }],
          items: retryItems,
          mode: cfg.dryRun ? "dry-run" : "apply",
          maxEditAttemptsPerFile: cfg.maxEditAttemptsPerFile,
          parallel: false,
        });
      }
    }
  }

  const finalPost = postRun ?? baseline;
  const verifyArtifact = {
    green,
    iterations: verifyIterations,
    maxIterations: cfg.maxVerifyIterations,
    baseline,
    post: finalPost,
    failures,
  };
  checkpoint(cfg.repoRoot, runId, "VERIFY", artifactFor.VERIFY, verifyArtifact);
  stages.push({ stage: "VERIFY", state: "checkpointed" });

  // ---- REPORT -------------------------------------------------------------
  startStage(cfg.repoRoot, runId, "REPORT");
  const coverage = computeCitationCoverage(dispatch.queues, plan.items);
  const report = renderReport({
    runId,
    dependency: cfg.dependency,
    fromVersion: cfg.fromVersion,
    toVersion: cfg.toVersion,
    date: new Date().toISOString().slice(0, 10),
    wallClockMs: Date.now() - startedAt,
    verifyIterations,
    maxVerifyIterations: cfg.maxVerifyIterations,
    green,
    baseline,
    postRun: finalPost,
    failures,
    queues: dispatch.queues,
    items: plan.items as PlanItem[],
    changedFiles,
    workMapFiles,
    unmatchedItemIds: scan.unmatchedItemIds,
  });

  const { artifactPath } = require("./ledger.js") as typeof import("./ledger.js");
  const { writeFileSync, mkdirSync } = require("fs") as typeof import("fs");
  const { dirname } = require("path") as typeof import("path");
  const rp = artifactPath(cfg.repoRoot, runId, artifactFor.REPORT);
  mkdirSync(dirname(rp), { recursive: true });
  writeFileSync(rp, report, "utf8");

  checkpoint(cfg.repoRoot, runId, "REPORT", artifactFor.REPORT, { bytes: report.length, green });
  stages.push({ stage: "REPORT", state: "checkpointed" });

  ledger = readLedger(cfg.repoRoot, runId);
  return {
    runId,
    green,
    ledger,
    stages,
    plan,
    report,
    citationCoverage: coverage.ratio,
    changedFiles,
    workMapFiles,
    failures,
    verifyIterations,
    wallClockMs: Date.now() - startedAt,
    baseCommit,
  };
}

function snapshotContents(repoRoot: string): Map<string, string> {
  const { readFileSync } = require("fs") as typeof import("fs");
  const out = new Map<string, string>();
  for (const rel of listFiles(repoRoot)) {
    try {
      out.set(rel, readFileSync(`${repoRoot}/${rel}`, "utf8"));
    } catch {
      /* binary or unreadable — not diffable text */
    }
  }
  return out;
}
