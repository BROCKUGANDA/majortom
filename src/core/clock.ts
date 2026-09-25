// src/core/clock.ts
// Monotonic wall-clock helpers

export function nowIso(): string {
  return new Date().toISOString();
}

export function durationMs(startIso: string, endIso: string): number {
  return new Date(endIso).getTime() - new Date(startIso).getTime();
}
