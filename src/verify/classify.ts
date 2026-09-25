// src/verify/classify.ts — §8.2 classification, implemented exactly as specified
//
//   post=fail, id in baseline.failingIds  -> pre_existing         (excluded)
//   post=fail, id was passing at baseline -> migration_caused     (routes back)
//   post=fail, id absent from baseline    -> new_or_renamed       (migration_caused, flag)
//   post=pass, id in baseline.failingIds  -> incidentally_fixed   (report, do not celebrate)
//   id in baseline, absent from post      -> collection_regression (migration_caused, high)
//
// I8: pre-existing failures are recorded and EXCLUDED from migration accounting —
// never silently "fixed", never counted as migration damage.
//
// §8.2 routing: a migration_caused failure maps to a file via the stack trace or the
// test's source file, then to the queue that owns that file. If the failing file
// belongs to NO queue it is escalated to HUMAN REVIEW (H5), never reassigned (I5).

// Types only — a type-only import emits no runtime binding, so classify.ts has no
// runtime edge to schemas.js and no import-order hazard. (Importing a VALUE across
// this edge made COUNTS_AGAINST_MIGRATION resolve to undefined whenever a consumer
// imported classify.js first; the local COUNTS_AGAINST set replaces it.)
import type { Baseline, ClassifiedFailure, Classification } from "./schemas.js";

/**
 * Classifications that count against the migration (§8.2, I8).
 *
 * This module is the SINGLE owner of the set. It previously existed in schemas.ts as
 * well, and index.ts re-exported both via `export *` — an ambiguous name that
 * resolved to `undefined` in some import orders, so `set.has(...)` threw
 * "COUNTS_AGAINST_MIGRATION is not defined" at a call site far from the cause.
 */
export const COUNTS_AGAINST_MIGRATION: ReadonlySet<Classification> = new Set<Classification>([
  "migration_caused",
  "new_or_renamed",
  "collection_regression",
]);

export interface WorkMapOwnership {
  /** file → queueId, built from the Phase 3 work map. */
  queueByFile: Map<string, string>;
}

export function ownershipFromQueues(
  queues: Array<{ queueId: string; files: string[] }>
): WorkMapOwnership {
  const queueByFile = new Map<string, string>();
  for (const q of queues) {
    for (const f of q.files) queueByFile.set(normalise(f), q.queueId);
  }
  return { queueByFile };
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Pull the first repo-relative source path out of a failure message's stack. */
export function fileFromMessage(message: string | null): string | null {
  if (!message) return null;
  // Prefer an explicit src/ path wherever it appears. A Windows drive letter
  // ("C:\repo\src\app.js") must not be captured as the filename, so the pattern
  // anchors on the src/ segment rather than on a leading path prefix.
  const withSrc = /[A-Za-z]:?[\\/][^\s()'"`]*?[\\/]?(src[\\/][\w.\\/-]+\.(?:js|ts|mjs|cjs|jsx|tsx))(?::\d+)?/.exec(
    message
  );
  const raw = withSrc?.[1];
  if (raw) {
    const idx = raw.indexOf("src/");
    return normalise(idx >= 0 ? raw.slice(idx) : raw.replace(/^[\\/]/, ""));
  }
  // vitest's verbose reporter marks the failing source with a ❯.
  const marked = /❯\s*([\w./\\-]+\.(?:js|ts|mjs|cjs|jsx|tsx))(?::\d+)?/.exec(message);
  const markedRaw = marked?.[1];
  if (markedRaw) {
    const idx = markedRaw.indexOf("src/");
    return normalise(idx >= 0 ? markedRaw.slice(idx) : markedRaw);
  }
  return null;
}

/** The test id embeds its own file as the first `::` segment. */
export function fileFromTestId(id: string): string | null {
  const first = id.split("::")[0];
  return first && first.length > 0 ? normalise(first) : null;
}

/** The assertion that failed, extracted for the fixer's failure context (§8.2). */
export function assertionFromMessage(message: string | null): string | null {
  if (!message) return null;
  const m =
    /AssertionError[^\n]*/.exec(message) ??
    /expected\s+([^\n]+)/i.exec(message) ??
    /Error:\s*([^\n]+)/.exec(message);
  return m?.[0]?.slice(0, 300) ?? null;
}

export interface ClassifyInput {
  baseline: Baseline;
  post: Baseline;
  ownership: WorkMapOwnership;
  /** Test ids that passed on an isolated rerun (§8.2 flake control). */
  flakyIds?: string[];
}

export function classify(input: ClassifyInput): {
  failures: ClassifiedFailure[];
  counts: Record<string, number>;
  green: boolean;
} {
  const { baseline, post, ownership } = input;
  const flaky = new Set(input.flakyIds ?? []);

  const baselineById = new Map(baseline.results.map((r) => [r.id, r]));
  const baselineFailing = new Set(baseline.failingIds);
  const postById = new Map(post.results.map((r) => [r.id, r]));

  const failures: ClassifiedFailure[] = [];
  const counts: Record<string, number> = {
    pre_existing: 0,
    migration_caused: 0,
    new_or_renamed: 0,
    incidentally_fixed: 0,
    collection_regression: 0,
    flaky_suspect: 0,
  };

  for (const result of post.results) {
    const failed = result.status === "fail" || result.status === "error";
    const inBaseline = baselineById.has(result.id);

    if (flaky.has(result.id)) {
      if (failed) {
        counts.flaky_suspect!++;
        continue; // excluded from routing
      }
      // It passed on rerun — not a failure at all.
      continue;
    }

    if (failed) {
      let classification: Classification;
      if (baselineFailing.has(result.id)) classification = "pre_existing";
      else if (inBaseline) classification = "migration_caused";
      else classification = "new_or_renamed";

      counts[classification]!++;
      failures.push(
        build(result.id, classification, result.message, ownership, baselineFailing.has(result.id))
      );
    } else if (baselineFailing.has(result.id)) {
      counts.incidentally_fixed!++;
      failures.push(build(result.id, "incidentally_fixed", result.message, ownership, true));
    }
  }

  // id in baseline, absent from post → collection_regression.
  for (const result of baseline.results) {
    if (postById.has(result.id)) continue;
    if (baselineFailing.has(result.id)) {
      // A test that failed at baseline and is now absent is still not migration damage.
      counts.pre_existing!++;
      failures.push(build(result.id, "pre_existing", result.message, ownership, true));
      continue;
    }
    counts.collection_regression!++;
    failures.push(
      build(result.id, "collection_regression", "test present at baseline, absent after migration", ownership, false)
    );
  }

  const green = failures.every((f) => !COUNTS_AGAINST_MIGRATION.has(f.classification));
  return { failures, counts, green };
}

function build(
  testId: string,
  classification: Classification,
  message: string | null,
  ownership: WorkMapOwnership,
  _wasFailingAtBaseline: boolean
): ClassifiedFailure {
  const file = fileFromMessage(message) ?? fileFromTestId(testId);
  const queueId = file ? (ownership.queueByFile.get(normalise(file)) ?? null) : null;
  const orphaned =
    COUNTS_AGAINST_MIGRATION.has(classification) && (file === null || queueId === null);

  return {
    testId,
    classification,
    message,
    file,
    queueId,
    orphaned,
    assertion: assertionFromMessage(message),
  };
}
