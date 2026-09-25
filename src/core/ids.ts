// src/core/ids.ts
// ULID-based run ID generation

import { ulid } from "ulid";
import { createHash } from "crypto";

export function newRunId(): string {
  return ulid();
}

/**
 * Idempotency key per SPEC.md §3.4:
 * sha256(repoRemoteOrPath + commitSha + depName + targetVersion)
 */
export function idempotencyKey(
  repoRemoteOrPath: string,
  commitSha: string,
  depName: string,
  targetVersion: string
): string {
  const raw = repoRemoteOrPath + commitSha + depName + targetVersion;
  return createHash("sha256").update(raw).digest("hex");
}
