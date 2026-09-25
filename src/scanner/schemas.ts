// src/scanner/schemas.ts
// WorkMap schema from SPEC.md §6.3

import { z } from "zod";

export const WorkMapHit = z.object({
  itemId: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  snippet: z.string(),
  matchKind: z.enum(["regex", "ast"]),
  suppressed: z.boolean(),
  suppressionReason: z.string().nullable(),
});
export type WorkMapHit = z.infer<typeof WorkMapHit>;

export const WorkMapEntry = z.object({
  file: z.string(),
  hits: z.array(WorkMapHit),
  estimatedEdits: z.number().int(),
});
export type WorkMapEntry = z.infer<typeof WorkMapEntry>;

export const WorkMapQueue = z.object({
  queueId: z.string(),
  files: z.array(z.string()),
  itemIds: z.array(z.string()),
  estimatedEdits: z.number().int(),
});
export type WorkMapQueue = z.infer<typeof WorkMapQueue>;

export const WorkMap = z.object({
  runId: z.string(),
  entries: z.array(WorkMapEntry),
  unmatchedItemIds: z.array(z.string()),
  queues: z.array(WorkMapQueue),
});
export type WorkMap = z.infer<typeof WorkMap>;
