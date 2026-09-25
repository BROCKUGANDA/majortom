// src/core/schemas.ts
// Zod schemas for the run ledger, exactly as specified in SPEC.md §3.3
import { z } from "zod";

export const Stage = z.enum([
  "INTAKE",
  "PLAN",
  "IMPACT",
  "BASELINE",
  "EXECUTE",
  "VERIFY",
  "REPORT",
]);
export type Stage = z.infer<typeof Stage>;

export const StageState = z.enum(["pending", "running", "checkpointed", "failed", "skipped"]);
export type StageState = z.infer<typeof StageState>;

export const StageRecord = z.object({
  stage: Stage,
  state: StageState,
  attempt: z.number().int().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nullable(),
  checkpointRef: z.string().nullable(), // path under artifacts/
  error: z
    .object({
      code: z.string(), // 3.5 taxonomy
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
});
export type StageRecord = z.infer<typeof StageRecord>;

export const RunLedger = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(), // ULID
  idempotencyKey: z.string(), // 3.4
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  createdAt: z.string().datetime(),
  target: z.object({
    ecosystem: z.literal("npm"),
    name: z.string(),
    fromVersion: z.string(),
    toVersion: z.string(),
  }),
  repo: z.object({
    root: z.string(),
    commitSha: z.string(),
    baseBranch: z.string(),
    workBranch: z.string(),
    dirty: z.boolean(),
  }),
  guide: z.object({
    kind: z.enum(["pdf", "markdown", "url"]),
    path: z.string(),
    sha256: z.string(),
    pages: z.number().int().nullable(),
  }),
  stages: z.array(StageRecord),
  humanTouches: z.array(
    z.object({
      at: z.string().datetime(),
      kind: z.enum(["select-dependency", "approve-pr", "manual-intervention"]),
      note: z.string().nullable(),
    })
  ),
  metrics: z.object({
    wallClockMs: z.number().int().nullable(),
    stageMs: z.record(z.number().int()),
    fixerIterations: z.number().int(),
    verifyIterations: z.number().int(),
    filesChanged: z.number().int(),
    citationCoverage: z.number().min(0).max(1).nullable(),
    testDelta: z.object({ before: z.number().int(), after: z.number().int() }).nullable(),
  }),
});
export type RunLedger = z.infer<typeof RunLedger>;

// Ordered list of stages for transition validation
export const STAGE_ORDER: Stage[] = [
  "INTAKE",
  "PLAN",
  "IMPACT",
  "BASELINE",
  "EXECUTE",
  "VERIFY",
  "REPORT",
];
