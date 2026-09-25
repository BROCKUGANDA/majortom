// src/verify/loop.ts — the bounded verification loop, SPEC.md §8
//
// I4/I6: the loop is bounded at maxVerifyIterations (3). On exhaustion the run
// PROCEEDS to REPORT with status `failed_verification`, listing every unresolved
// failure with its classification. It never reports green when tests are red.
//
// I8: pre-existing failures never block the run and never count against the migration.
//
// §8.2 flake control: each failing test is rerun ONCE in isolation before it is
// classified; a test that passes on rerun is `flaky_suspect` and is not routed.
//
// §7.4: the test-triage subagent NEVER edits source files. This module only runs the
// runner, parses, classifies and routes. Repair is the fixer's job, invoked by the
// orchestrator through the callback below.

import { runSuite, type Runner } from "./adapters.js";
import { classify, ownershipFromQueues, type WorkMapOwnership } from "./classify.js";
import { Baseline, type ClassifiedFailure } from "./schemas.js";

export interface VerifyLoopOptions {
  repoRoot: string;
  runner: Runner;
  timeoutMs: number;
  maxIterations: number;
  queues: Array<{ queueId: string; files: string[] }>;
  /** Invoked with the routed failures for ONE queue. Must not edit outside it. */
  repair: (queueId: string, failures: ClassifiedFailure[]) => Promise<void>;
}

export interface VerifyLoopResult {
  baseline: Baseline;
  final: Baseline;
  failures: ClassifiedFailure[];
  counts: Record<string, number>;
  iterations: number;
  green: boolean;
  status: "verified" | "failed_verification";
  /** Ledger trail: one entry per iteration (§6 acceptance: complete ledger trail). */
  trail: Array<{
    iteration: number;
    migrationCaused: number;
    routedQueues: string[];
    humanReview: string[];
  }>;
}

export async function baseline(options: VerifyLoopOptions): Promise<Baseline> {
  return runSuite({
    repoRoot: options.repoRoot,
    runner: options.runner,
    timeoutMs: options.timeoutMs,
  });
}

export async function verifyLoop(options: VerifyLoopOptions): Promise<VerifyLoopResult> {
  const started = Date.now();
  const ownership: WorkMapOwnership = ownershipFromQueues(options.queues);

  // §8.1: baseline BEFORE any edit, on the unmodified tree.
  const base = await baseline(options);

  const trail: VerifyLoopResult["trail"] = [];
  let post = base;
  let failures: ClassifiedFailure[] = [];
  let counts: Record<string, number> = {};
  let iteration = 0;
  let green = false;

  for (iteration = 1; iteration <= options.maxIterations; iteration++) {
    post = await runSuite({
      repoRoot: options.repoRoot,
      runner: options.runner,
      timeoutMs: options.timeoutMs,
    });

    // §8.2 flake control: rerun each failing test once in isolation.
    const failingIds = post.failingIds;
    let flakyIds: string[] = [];
    if (failingIds.length > 0) {
      try {
        const rerun = await runSuite({
          repoRoot: options.repoRoot,
          runner: options.runner,
          timeoutMs: options.timeoutMs,
          only: failingIds,
        });
        flakyIds = rerun.results.filter((r) => r.status === "pass").map((r) => r.id);
      } catch {
        // A flake rerun that cannot complete simply routes everything — honest.
        flakyIds = [];
      }
    }

    const classified = classify({ baseline: base, post, ownership, flakyIds });
    failures = classified.failures;
    counts = classified.counts;
    green = classified.green;

    // Only migration-caused failures route back to a fixer.
    const routable = failures.filter(
      (f) => f.classification === "migration_caused" || f.classification === "new_or_renamed"
    );
    const humanReview = failures
      .filter((f) => f.orphaned)
      .map((f) => `${f.testId} (${f.file ?? "unknown file"}) → H5`);

    const byQueue = new Map<string, ClassifiedFailure[]>();
    for (const f of routable) {
      if (!f.queueId) continue; // orphaned → H5, never reassigned (I5)
      const list = byQueue.get(f.queueId) ?? [];
      list.push(f);
      byQueue.set(f.queueId, list);
    }

    trail.push({
      iteration,
      migrationCaused: counts.migration_caused ?? 0,
      routedQueues: [...byQueue.keys()].sort(),
      humanReview,
    });

    if (green) break;
    if (byQueue.size === 0) {
      // Nothing left we are allowed to fix. Report honestly rather than retry.
      break;
    }

    // Repair, then loop. Bounded: the for-condition is the budget (I4).
    await Promise.all(
      [...byQueue.entries()].map(([queueId, queueFailures]) =>
        options.repair(queueId, queueFailures)
      )
    );
  }

  const status: VerifyLoopResult["status"] = green ? "verified" : "failed_verification";

  return {
    baseline: base,
    final: post,
    failures,
    counts,
    iterations: iteration,
    green,
    status,
    trail,
  };
}
