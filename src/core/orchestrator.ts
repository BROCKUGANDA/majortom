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

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
import {
  createRun,
  readLedger,
  startStage,
  checkpoint,
  failStage,
  artifactPath,
} from "./ledger.js";
import { MajorTomError } from "./errors.js";
import { bumpManifest, installDependencies } from "./manifest.js";
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

/** Read a file, or null when it does not exist. Used for before/after lockfile diffing. */
function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
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
  /**
   * Files rewritten by the manifest bump's reinstall (currently package-lock.json).
   * Reported separately from `changedFiles` so I5 stays strict over FIXER edits.
   */
  bumpArtifacts: string[];
  workMapFiles: string[];
  failures: ClassifiedFailure[];
  verifyIterations: number;
  wallClockMs: number;
  baseCommit: string;
  /** Populated when the run could not complete honestly. */
  error?: string;
}

function listFiles(
  dir: string,
  skip: Set<string> = new Set(["node_modules", ".git", ".majortom"])
): string[] {
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

  const artifactFor = {
    INTAKE: "intake.json",
    PLAN: "plan.json",
    IMPACT: "workmap.json",
    BASELINE: "baseline.json",
    EXECUTE: "diff.patch",
    VERIFY: "verify.json",
    REPORT: "report.md",
  } as const;

  // INTAKE is a real stage in the ledger, not just a local marker: §3.2 requires a
  // stage record per stage, and startStage() enforces that PLAN cannot begin until
  // INTAKE is checkpointed.
  startStage(cfg.repoRoot, runId, "INTAKE");
  checkpoint(cfg.repoRoot, runId, "INTAKE", artifactFor.INTAKE, {
    repoRoot: cfg.repoRoot,
    baseCommit,
    workBranch: runBranchName(runId),
    dryRun: cfg.dryRun,
  });
  stages.push({ stage: "INTAKE", state: "checkpointed" });

  let ledger = readLedger(cfg.repoRoot, runId);

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
      bumpArtifacts: [],
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

  // §9.4: the manifest bump is its own, separate concern from the code edits. It must
  // happen BEFORE verify, because a major-version migration whose manifest still pins
  // the old major is guaranteed to fail verification for reasons that have nothing to
  // do with the code edits.
  //
  // I2: the bump is a real edit, so it carries a citation. A plan item whose fix
  // mentions the dependency's version range authorises it; without one it is still
  // applied (the manifest IS the migration target) but the report records it as
  // uncited rather than claiming a citation it does not have.
  const manifestItem = plan.items.find(
    (it) =>
      it.id === "EX-18" || /version|engine|bump|upgrade the declared/i.test(it.fix.instruction)
  );
  const { bump } = bumpManifest({
    repoRoot: cfg.repoRoot,
    ecosystem: "npm",
    dependency: cfg.dependency,
    toVersion: cfg.toVersion,
    ...(manifestItem ? { planItem: manifestItem } : {}),
    write: !cfg.dryRun,
  });

  // A bumped manifest is not an installed dependency. Until `npm install` runs, the
  // test suite still executes against the OLD major, so verification measures the
  // wrong thing — the migrated code is correct for v5 but loaded against v4. Reinstall
  // before verify so the result reflects the migration the manifest now declares.
  //
  // Honesty rules: a failed install is reported, never swallowed; and a dry-run never
  // installs, because dry-run must not mutate the target repo's dependency tree.
  //
  // I5: reinstalling legitimately rewrites package-lock.json, which is NOT in the
  // work map (it holds no source call sites). Rather than widen the map, the lockfile
  // is recorded as a manifest-bump side effect so the I5 diff-scope check can account
  // for it explicitly instead of flagging the run as having touched an unlisted file.
  const lockBefore = readFileSafe(join(cfg.repoRoot, "package-lock.json"));
  const reinstall = await installDependencies({
    repoRoot: cfg.repoRoot,
    ecosystem: "npm",
    enabled: bump.changed && !cfg.dryRun,
    dependency: cfg.dependency,
    toVersion: cfg.toVersion,
  });
  const lockAfter = readFileSafe(join(cfg.repoRoot, "package-lock.json"));
  const lockChanged = lockBefore !== null && lockAfter !== null && lockBefore !== lockAfter;

  checkpoint(cfg.repoRoot, runId, "EXECUTE", artifactFor.EXECUTE, {
    queues: dispatch.queues,
    totalEdits: dispatch.totalEdits,
    parallelSpeedup: dispatch.parallelSpeedup,
    wallClockMs: dispatch.wallClockMs,
    manifestBump: bump,
    dependencyInstall: reinstall,
  });
  stages.push({ stage: "EXECUTE", state: "checkpointed" });

  const after = cfg.dryRun ? before : snapshotContents(cfg.repoRoot);
  // The reinstall performed by the manifest bump rewrites package-lock.json. That is a
  // declared side effect of the bump, not a FIXER edit, so it must not be counted here —
  // I5 is an assertion about fixer scope, and letting the bump's file inflate the fixer
  // diff would quietly weaken it. It is reported as `bumpArtifacts` instead.
  const BUMP_ARTIFACTS = new Set(["package-lock.json"]);
  const changedFiles = [...after.entries()]
    .filter(([file, content]) => before.get(file) !== content && !BUMP_ARTIFACTS.has(file))
    .map(([file]) => file);
  const workMapFiles = workMap.entries.map((e) => e.file);

  // I5 applies to FIXER edits only. The lockfile is rewritten by the reinstall that the
  // manifest bump requires (§9.4) — it is a declared side effect of the bump, not a
  // fixer wandering outside its queue. Mixing the two would weaken the invariant, so
  // they are reported separately and the caller can check both.
  const bumpArtifacts = lockChanged ? ["package-lock.json"] : [];

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
    const routable = failures.filter((f) => f.classification === "migration_caused" && !f.orphaned);
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
          queues: [
            { queueId: q.queueId, files: targetFiles, itemIds: retryItems.map((r) => r.id) },
          ],
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
    bumpArtifacts,
    manifestBump: bump,
    unmatchedItemIds: scan.unmatchedItemIds,
  });

  // Write the markdown report FIRST, then checkpoint with a JSON payload that does
  // NOT claim ownership of report.md. checkpoint() writes JSON.stringify(data) to
  // the artifact path, so pointing it at report.md would overwrite the report with a
  // JSON summary. §3.2 wants report.md to BE the report.
  const rp = artifactPath(cfg.repoRoot, runId, artifactFor.REPORT);
  mkdirSync(dirname(rp), { recursive: true });
  writeFileSync(rp, report, "utf8");

  // Checkpoint the stage against a JSON sidecar, and record the report's own path in
  // the ledger so the artifact reference stays accurate.
  checkpoint(cfg.repoRoot, runId, "REPORT", "report-meta.json", {
    reportArtifact: artifactFor.REPORT,
    bytes: report.length,
    green,
    citationCoverage: coverage.ratio,
  });
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
    bumpArtifacts,
    workMapFiles,
    failures,
    verifyIterations,
    wallClockMs: Date.now() - startedAt,
    baseCommit,
  };
}

function snapshotContents(repoRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of listFiles(repoRoot)) {
    try {
      out.set(rel, readFileSync(join(repoRoot, rel), "utf8"));
    } catch {
      /* binary or unreadable — not diffable text */
    }
  }
  return out;
}
