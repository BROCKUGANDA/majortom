// src/verify/schemas.ts — SPEC.md §8.1 baseline + classification shapes
//
// NOTE: this module is a LEAF. It imports nothing from the rest of src/verify, and
// nothing in src/verify re-exports it *from another module*. A cycle here would make
// `COUNTS_AGAINST_MIGRATION` resolve to undefined when a consumer happened to import
// classify.js before schemas.js — the failure appears at the call site, far from the
// real cause.

import { z } from "zod";
export const TestResult = z.object({
  id: z.string(), // file::suitePath::testName
  status: z.enum(["pass", "fail", "skip", "error"]),
  durationMs: z.number().int().nullable(),
  message: z.string().nullable(),
});
export type TestResult = z.infer<typeof TestResult>;

export const Baseline = z.object({
  runner: z.enum(["vitest", "jest"]),
  command: z.string(),
  exitCode: z.number().int(),
  totalMs: z.number().int(),
  results: z.array(TestResult),
  failingIds: z.array(z.string()),
  collectionErrors: z.array(z.string()),
});
export type Baseline = z.infer<typeof Baseline>;

// ─── §8.2 classification ─────────────────────────────────────────────────────

export const Classification = z.enum([
  "pre_existing", // post=fail, id in baseline.failingIds → excluded from accounting
  "migration_caused", // post=fail, id was passing at baseline → routes back
  "new_or_renamed", // post=fail, id absent from baseline → treat as migration_caused
  "incidentally_fixed", // post=pass, id in baseline.failingIds → report, do not celebrate
  "collection_regression", // in baseline, absent from post → migration_caused, high severity
  "flaky_suspect", // passed on isolated rerun → excluded from routing
]);
export type Classification = z.infer<typeof Classification>;

export interface ClassifiedFailure {
  testId: string;
  classification: Classification;
  message: string | null;
  /** File that owns the failing test, from the stack trace or the test's own file. */
  file: string | null;
  queueId: string | null;
  /** True when the owning file belongs to no queue → escalate to H5, never reassign. */
  orphaned: boolean;
  assertion: string | null;
}

export interface VerifyOutput {
  post: Baseline;
  failures: ClassifiedFailure[];
  /** §8.2 counters. Pre-existing failures are EXCLUDED (I8). */
  counts: {
    preExisting: number;
    migrationCaused: number;
    incidentallyFixed: number;
    collectionRegression: number;
    flakySuspect: number;
  };
  iteration: number;
  green: boolean;
}
