// src/scanner/partition.ts
// Partition work map into disjoint queues per SPEC.md §6.3

import type { WorkMapEntry, WorkMapQueue } from "./schemas.js";
import { ulid } from "ulid";

/**
 * Partition entries into maxQueues disjoint queues.
 * Algorithm: sort files by estimatedEdits desc (ties by path), then
 * greedy least-loaded assignment into buckets.
 * Deterministic: same input → same queues.
 */
export function partition(entries: WorkMapEntry[], maxQueues: number): WorkMapQueue[] {
  if (entries.length === 0) return [];

  // Only include entries with at least one unsuppressed hit
  const active = entries.filter((e) => e.estimatedEdits > 0);

  if (active.length === 0) return [];

  // Sort: descending by estimatedEdits, then ascending by file path (deterministic)
  const sorted = [...active].sort((a, b) => {
    if (b.estimatedEdits !== a.estimatedEdits) return b.estimatedEdits - a.estimatedEdits;
    return a.file.localeCompare(b.file);
  });

  const numQueues = Math.min(maxQueues, sorted.length);

  // Initialize queues
  const queues: Array<{
    queueId: string;
    files: string[];
    itemIds: Set<string>;
    estimatedEdits: number;
  }> = Array.from({ length: numQueues }, () => ({
    queueId: ulid(),
    files: [],
    itemIds: new Set(),
    estimatedEdits: 0,
  }));

  // Greedy least-loaded assignment
  for (const entry of sorted) {
    // Find the queue with the lowest estimatedEdits
    let minIdx = 0;
    for (let i = 1; i < queues.length; i++) {
      if ((queues[i]?.estimatedEdits ?? Infinity) < (queues[minIdx]?.estimatedEdits ?? Infinity)) {
        minIdx = i;
      }
    }
    const q = queues[minIdx];
    if (!q) continue;
    q.files.push(entry.file);
    q.estimatedEdits += entry.estimatedEdits;
    for (const hit of entry.hits) {
      if (!hit.suppressed) {
        q.itemIds.add(hit.itemId);
      }
    }
  }

  return queues
    .filter((q) => q.files.length > 0)
    .map((q) => ({
      queueId: q.queueId,
      files: q.files,
      itemIds: Array.from(q.itemIds),
      estimatedEdits: q.estimatedEdits,
    }));
}

/**
 * Assert that queues are disjoint: no file appears in more than one queue.
 * Returns a list of files that appear in multiple queues (empty = disjoint).
 */
export function findQueueOverlap(queues: WorkMapQueue[]): string[] {
  const seen = new Map<string, string>(); // file → queueId
  const duplicates: string[] = [];
  for (const queue of queues) {
    for (const file of queue.files) {
      const existing = seen.get(file);
      if (existing) {
        duplicates.push(file);
      } else {
        seen.set(file, queue.queueId);
      }
    }
  }
  return duplicates;
}
