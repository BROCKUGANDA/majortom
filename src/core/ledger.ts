// src/core/ledger.ts
// Run ledger: create, checkpoint, resume, metrics.
// All writes are atomic (temp file + rename) and zod-validated.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";
import { RunLedger, StageRecord, Stage, StageState, STAGE_ORDER } from "./schemas.js";
import { MajorTomError } from "./errors.js";
import { newRunId } from "./ids.js";
import { nowIso, durationMs } from "./clock.js";

export type { RunLedger, StageRecord, Stage, StageState };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function runDir(repoRoot: string, runId: string): string {
  return join(repoRoot, ".majortom", "runs", runId);
}

export function ledgerPath(repoRoot: string, runId: string): string {
  return join(runDir(repoRoot, runId), "ledger.json");
}

export function artifactPath(repoRoot: string, runId: string, name: string): string {
  return join(runDir(repoRoot, runId), "artifacts", name);
}

export function logPath(repoRoot: string, runId: string, name: string): string {
  return join(runDir(repoRoot, runId), "logs", name);
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

function writeLedgerAtomic(filePath: string, ledger: RunLedger): void {
  // Validate before writing
  RunLedger.parse(ledger);

  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Read + validate
// ---------------------------------------------------------------------------

export function readLedger(repoRoot: string, runId: string): RunLedger {
  const path = ledgerPath(repoRoot, runId);
  if (!existsSync(path)) {
    throw new MajorTomError("E_RUN_TIMEOUT", `Ledger not found: ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new MajorTomError("E_RUN_TIMEOUT", `Failed to read ledger: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MajorTomError("E_RUN_TIMEOUT", `Ledger is not valid JSON: ${path}`);
  }
  const result = RunLedger.safeParse(parsed);
  if (!result.success) {
    throw new MajorTomError(
      "E_RUN_TIMEOUT",
      `Ledger schema validation failed: ${result.error.message}`
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// createRun
// ---------------------------------------------------------------------------

export interface CreateRunParams {
  repoRoot: string;
  target: RunLedger["target"];
  repo: RunLedger["repo"];
  guide: RunLedger["guide"];
  idempotencyKeyValue: string;
  force?: boolean;
}

/**
 * Creates a new run or returns the existing runId for a running/completed run.
 * Per SPEC.md §3.4.
 */
export function createRun(params: CreateRunParams): {
  runId: string;
  created: boolean;
  ledger: RunLedger;
} {
  const { repoRoot, target, repo, guide, idempotencyKeyValue, force } = params;

  // Check if a run with this idempotency key already exists
  const existing = findRunByIdempotencyKey(repoRoot, idempotencyKeyValue);
  if (existing) {
    const { ledger } = existing;
    if (ledger.status === "running" || ledger.status === "completed") {
      // Return existing run — do not create a new one
      return { runId: ledger.runId, created: false, ledger };
    }
    // failed or cancelled: only create new if force is true
    if (!force) {
      throw new MajorTomError(
        "E_RUN_TIMEOUT",
        `Run ${ledger.runId} is in status '${ledger.status}'. Pass force=true to create a new run.`
      );
    }
  }

  const runId = newRunId();
  const now = nowIso();

  const ledger: RunLedger = {
    schemaVersion: 1,
    runId,
    idempotencyKey: idempotencyKeyValue,
    status: "running",
    createdAt: now,
    target,
    repo,
    guide,
    stages: [],
    humanTouches: [],
    metrics: {
      wallClockMs: null,
      stageMs: {},
      fixerIterations: 0,
      verifyIterations: 0,
      filesChanged: 0,
      citationCoverage: null,
      testDelta: null,
    },
  };

  const dir = runDir(repoRoot, runId);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeLedgerAtomic(ledgerPath(repoRoot, runId), ledger);

  return { runId, created: true, ledger };
}

// ---------------------------------------------------------------------------
// Stage transitions
// ---------------------------------------------------------------------------

/**
 * Mark a stage as running. Validates the legal-transition rule:
 * a stage may only start when the previous stage is checkpointed or skipped.
 */
export function startStage(repoRoot: string, runId: string, stage: Stage): RunLedger {
  const ledger = readLedger(repoRoot, runId);
  validateTransition(ledger, stage);

  // Compute attempt number for this stage
  const attempt = ledger.stages.filter((s) => s.stage === stage).length + 1;

  const record: StageRecord = {
    stage,
    state: "running",
    attempt,
    startedAt: nowIso(),
    endedAt: null,
    durationMs: null,
    checkpointRef: null,
    error: null,
  };

  const updated: RunLedger = {
    ...ledger,
    stages: [...ledger.stages, record],
  };

  writeLedgerAtomic(ledgerPath(repoRoot, runId), updated);
  return updated;
}

/**
 * Write an artifact and mark the stage as checkpointed.
 */
export function checkpoint(
  repoRoot: string,
  runId: string,
  stage: Stage,
  artifactName: string,
  artifactData: unknown
): RunLedger {
  const ledger = readLedger(repoRoot, runId);
  const stageRecord = lastStageRecord(ledger, stage, "running");

  // Write the artifact
  const artPath = artifactPath(repoRoot, runId, artifactName);
  mkdirSync(dirname(artPath), { recursive: true });
  writeFileSync(artPath, JSON.stringify(artifactData, null, 2), "utf8");

  const now = nowIso();
  const updatedRecord: StageRecord = {
    ...stageRecord,
    state: "checkpointed",
    endedAt: now,
    durationMs: durationMs(stageRecord.startedAt, now),
    checkpointRef: artifactName,
  };

  const updatedStages = replaceLast(ledger.stages, stageRecord, updatedRecord);
  const updated: RunLedger = {
    ...ledger,
    metrics: {
      ...ledger.metrics,
      stageMs: { ...ledger.metrics.stageMs, [stage]: updatedRecord.durationMs ?? 0 },
    },
    stages: updatedStages,
  };

  writeLedgerAtomic(ledgerPath(repoRoot, runId), updated);
  return updated;
}

/**
 * Mark a stage as failed with an error.
 */
export function failStage(
  repoRoot: string,
  runId: string,
  stage: Stage,
  error: MajorTomError
): RunLedger {
  const ledger = readLedger(repoRoot, runId);
  const stageRecord = lastStageRecord(ledger, stage, "running");

  const now = nowIso();
  const updatedRecord: StageRecord = {
    ...stageRecord,
    state: "failed",
    endedAt: now,
    durationMs: durationMs(stageRecord.startedAt, now),
    error: error.toJSON(),
  };

  const updatedStages = replaceLast(ledger.stages, stageRecord, updatedRecord);
  const updated: RunLedger = {
    ...ledger,
    status: "failed",
    stages: updatedStages,
  };

  writeLedgerAtomic(ledgerPath(repoRoot, runId), updated);
  return updated;
}

/**
 * Mark the entire run as completed and compute wall-clock time.
 */
export function completeRun(repoRoot: string, runId: string): RunLedger {
  const ledger = readLedger(repoRoot, runId);
  const wallClockMs = durationMs(ledger.createdAt, nowIso());

  const updated: RunLedger = {
    ...ledger,
    status: "completed",
    metrics: { ...ledger.metrics, wallClockMs },
  };

  writeLedgerAtomic(ledgerPath(repoRoot, runId), updated);
  return updated;
}

/**
 * Update metrics fields on the ledger.
 */
export function updateMetrics(
  repoRoot: string,
  runId: string,
  patch: Partial<RunLedger["metrics"]>
): RunLedger {
  const ledger = readLedger(repoRoot, runId);
  const updated: RunLedger = {
    ...ledger,
    metrics: { ...ledger.metrics, ...patch },
  };
  writeLedgerAtomic(ledgerPath(repoRoot, runId), updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export interface ResumeResult {
  runId: string;
  ledger: RunLedger;
  nextStage: Stage | null;
}

/**
 * Resume a run from the last checkpointed stage.
 * Per SPEC.md §3.4.
 */
export function resume(repoRoot: string, runId: string): ResumeResult {
  const ledger = readLedger(repoRoot, runId);

  // Discard any running stage's partial artifacts — re-open it
  const runningRecord = ledger.stages
    .slice()
    .reverse()
    .find((s) => s.state === "running");

  let cleanedLedger = ledger;

  if (runningRecord) {
    // Delete the partial artifact if any
    if (runningRecord.checkpointRef) {
      const artPath = artifactPath(repoRoot, runId, runningRecord.checkpointRef);
      if (existsSync(artPath)) {
        rmSync(artPath);
      }
    }
    // Remove the running record from stages (it will be re-executed)
    cleanedLedger = {
      ...ledger,
      stages: ledger.stages.filter((s) => s !== runningRecord),
    };
    writeLedgerAtomic(ledgerPath(repoRoot, runId), cleanedLedger);
  }

  // Find the last checkpointed stage
  const lastCheckpointed = cleanedLedger.stages
    .slice()
    .reverse()
    .find((s) => s.state === "checkpointed");

  let nextStage: Stage | null;
  if (!lastCheckpointed) {
    // No checkpointed stage — restart from INTAKE
    nextStage = "INTAKE";
  } else {
    const idx = STAGE_ORDER.indexOf(lastCheckpointed.stage);
    nextStage = idx < STAGE_ORDER.length - 1 ? (STAGE_ORDER[idx + 1] ?? null) : null;
  }

  return { runId, ledger: cleanedLedger, nextStage };
}

// ---------------------------------------------------------------------------
// Metrics computation (§10.2)
// ---------------------------------------------------------------------------

export interface LedgerMetrics {
  wallClockMs: number | null;
  humanTouches: number;
  citationCoverage: number | null;
  stageMs: Record<string, number>;
  fixerIterations: number;
  verifyIterations: number;
  filesChanged: number;
  testDelta: { before: number; after: number } | null;
}

export function metricsFromLedger(repoRoot: string, runId: string): LedgerMetrics {
  const ledger = readLedger(repoRoot, runId);
  return {
    wallClockMs: ledger.metrics.wallClockMs,
    humanTouches: ledger.humanTouches.length,
    citationCoverage: ledger.metrics.citationCoverage,
    stageMs: ledger.metrics.stageMs,
    fixerIterations: ledger.metrics.fixerIterations,
    verifyIterations: ledger.metrics.verifyIterations,
    filesChanged: ledger.metrics.filesChanged,
    testDelta: ledger.metrics.testDelta,
  };
}

// ---------------------------------------------------------------------------
// Index: find run by idempotency key
// ---------------------------------------------------------------------------

function findRunByIdempotencyKey(
  repoRoot: string,
  key: string
): { runId: string; ledger: RunLedger } | null {
  const majortomDir = join(repoRoot, ".majortom", "runs");
  if (!existsSync(majortomDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(majortomDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const path = join(majortomDir, entry, "ledger.json");
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { idempotencyKey?: string; runId?: string };
      if (parsed.idempotencyKey === key && parsed.runId) {
        const ledger = readLedger(repoRoot, parsed.runId);
        return { runId: parsed.runId, ledger };
      }
    } catch {
      // corrupted ledger, skip
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateTransition(ledger: RunLedger, stage: Stage): void {
  const stageIdx = STAGE_ORDER.indexOf(stage);

  if (stageIdx === 0) {
    // INTAKE can always start (first stage)
    return;
  }

  const prevStage = STAGE_ORDER[stageIdx - 1];
  if (!prevStage) return;

  // The previous stage must be checkpointed or skipped
  const prevRecord = ledger.stages
    .slice()
    .reverse()
    .find((s) => s.stage === prevStage);

  if (!prevRecord) {
    throw new MajorTomError(
      "E_RUN_TIMEOUT",
      `Cannot start ${stage}: previous stage ${prevStage} has not been started`
    );
  }

  if (prevRecord.state !== "checkpointed" && prevRecord.state !== "skipped") {
    throw new MajorTomError(
      "E_RUN_TIMEOUT",
      `Cannot start ${stage}: previous stage ${prevStage} is in state '${prevRecord.state}', must be 'checkpointed' or 'skipped'`
    );
  }
}

function lastStageRecord(ledger: RunLedger, stage: Stage, expectedState: StageState): StageRecord {
  const records = ledger.stages.filter((s) => s.stage === stage);
  const last = records[records.length - 1];
  if (!last) {
    throw new MajorTomError("E_RUN_TIMEOUT", `Stage ${stage} has not been started`);
  }
  if (last.state !== expectedState) {
    throw new MajorTomError(
      "E_RUN_TIMEOUT",
      `Stage ${stage} is in state '${last.state}', expected '${expectedState}'`
    );
  }
  return last;
}

function replaceLast(
  records: readonly StageRecord[],
  target: StageRecord,
  replacement: StageRecord
): StageRecord[] {
  const arr = [...records];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === target) {
      arr[i] = replacement;
      return arr;
    }
  }
  return arr;
}
