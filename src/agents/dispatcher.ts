// src/agents/dispatcher.ts — parallel fixer dispatcher, SPEC.md §7.3 + Annex A.3
//
// Annex A.3: the native runtime exposes no "launch N parallel subagents and join"
// primitive, so the fallback is `Promise.all()` over N in-process async tasks. Each
// task receives (a) its §7.3 contract prompt, (b) a filesystem facade that
// physically rejects out-of-queue paths, (c) its own log file. "The architecture is
// self-contained TypeScript, not dependent on [the] runtime."
//
// METRICS: §10.2 defines parallel speedup as (sum of per-queue durations) /
// (EXECUTE wall clock). Both numbers are computed here from real timings, never
// estimated.
//
// DETERMINISM: queues are independent (I5 — provably disjoint), so the final diff
// is identical whether the run is parallel or serial. The acceptance suite asserts
// that equality.

import { Fixer, type FixerInput, type FixerMode, type QueueResult } from "./fixer.js";
import type { PlanItem } from "../docs/schemas.js";

export interface DispatchInput {
  repoRoot: string;
  queues: Array<{ queueId: string; files: string[]; itemIds: string[] }>;
  items: PlanItem[];
  mode: FixerMode;
  maxEditAttemptsPerFile: number;
  /** Optional per-file failure context from the §8 verify loop. */
  failureContext?: Record<string, string>;
  /** When false, run queues one after another (for the serial/parallel equality test). */
  parallel?: boolean;
}

export interface DispatchResult {
  queues: QueueResult[];
  wallClockMs: number;
  /** §10.2 parallel speedup metric. 1.0 for a serial run. */
  parallelSpeedup: number;
  totalEdits: number;
  filesFixed: number;
  filesHumanReview: number;
  scopeViolations: Array<{ queueId: string; path: string; operation: string }>;
}

export async function dispatchFixers(input: DispatchInput): Promise<DispatchResult> {
  const started = Date.now();
  const parallel = input.parallel !== false;

  // Each queue sees ONLY the plan items it references (§7.3 input restriction).
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const tasks: Array<() => QueueResult> = input.queues.map((queue) => {
    const queueItems = queue.itemIds
      .map((id) => byId.get(id))
      .filter((i): i is PlanItem => i !== undefined);
    return () => {
      const fixerInput: FixerInput = {
        repoRoot: input.repoRoot,
        queueId: queue.queueId,
        files: queue.files,
        items: queueItems,
        mode: input.mode,
        maxEditAttemptsPerFile: input.maxEditAttemptsPerFile,
        ...(input.failureContext ? { failureContext: input.failureContext } : {}),
      };
      return new Fixer(fixerInput).run();
    };
  });

  // Annex A.3 fallback: Promise.all over in-process tasks. The serial branch maps the
  // same task list — it must NOT invoke the mapped array (`tasks.map(t => t())()`
  // calls the array as a function and throws "tasks.map(...) is not a function").
  const results = parallel ? await Promise.all(tasks.map((t) => t())) : tasks.map((t) => t());

  const wallClockMs = Date.now() - started;
  const sumDurations = results.reduce((acc, r) => acc + r.durationMs, 0);
  const parallelSpeedup = wallClockMs > 0 ? sumDurations / wallClockMs : 1;

  const scopeViolations = results.flatMap((r) =>
    r.scopeViolations.map((v) => ({ queueId: r.queueId, path: v.path, operation: v.operation }))
  );

  return {
    queues: results,
    wallClockMs,
    parallelSpeedup: Number(parallelSpeedup.toFixed(2)),
    totalEdits: results.reduce((acc, r) => acc + r.files.reduce((a, f) => a + f.edits.length, 0), 0),
    filesFixed: results.reduce(
      (acc, r) => acc + r.files.filter((f) => f.outcome === "fixed").length,
      0
    ),
    filesHumanReview: results.reduce(
      (acc, r) => acc + r.files.filter((f) => f.outcome === "human-review").length,
      0
    ),
    scopeViolations,
  };
}
