// src/agents/facade.ts — the hard I5 guard (SPEC.md §7.3, Annex A.2/A.3)
//
// A fixer subagent may read and edit files WITHIN ITS OWN QUEUE. The prompt states
// the boundary; this facade ENFORVES it. Annex A.2 is explicit: because the
// subagent runtime cannot restrict tools per-subagent, "the filesystem restriction
// MUST be enforced by the in-process filesystem facade. ... the hard enforcement is
// the facade."
//
// The facade is constructed with a queue's file list. Every path that reaches it is
// resolved and checked against that list. A path outside the queue THROWS
// (E_SCOPE_VIOLATION, always fatal per §3.5) — it is not silently ignored.
//
// FORBIDDEN by construction (§7.3 / I9): this facade exposes no shell, no network,
// no test runner, and no git. There is deliberately no method to reach them.

import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { dirname, isAbsolute, relative, resolve, sep } from "path";

export class ScopeViolationError extends Error {
  readonly code = "E_SCOPE_VIOLATION" as const;
  constructor(
    readonly attemptedPath: string,
    readonly queueId: string
  ) {
    super(
      `E_SCOPE_VIOLATION: ${attemptedPath} is outside queue ${queueId}. ` +
        `A fixer may only touch files in its own queue.`
    );
    this.name = "ScopeViolationError";
  }
}

/** Normalise a path to repo-relative POSIX form for comparison. */
function toRepoRelative(repoRoot: string, target: string): string {
  const abs = isAbsolute(target) ? resolve(target) : resolve(repoRoot, target);
  return relative(resolve(repoRoot), abs).split(sep).join("/");
}

export interface QueueFsFacadeOptions {
  repoRoot: string;
  queueId: string;
  /** The queue's files, repo-relative. */
  files: string[];
}

export class QueueFsFacade {
  private readonly repoRoot: string;
  private readonly queueId: string;
  private readonly allowed: Set<string>;

  /** Every rejected path, recorded rather than swallowed (Phase 5 acceptance). */
  readonly violations: Array<{ path: string; operation: string }> = [];

  /** Files this fixer actually wrote, in order. */
  readonly written: string[] = [];

  constructor(options: QueueFsFacadeOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.queueId = options.queueId;
    this.allowed = new Set(options.files.map((f) => toRepoRelative(this.repoRoot, f)));
  }

  /** Throw if `target` is not in this queue. */
  private guard(target: string, operation: string): string {
    const rel = toRepoRelative(this.repoRoot, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      this.violations.push({ path: target, operation });
      throw new ScopeViolationError(target, this.queueId);
    }
    if (!this.allowed.has(rel)) {
      this.violations.push({ path: target, operation });
      throw new ScopeViolationError(rel, this.queueId);
    }
    return rel;
  }

  canTouch(target: string): boolean {
    try {
      this.guard(target, "canTouch");
      return true;
    } catch {
      return false;
    }
  }

  read(target: string): string {
    const rel = this.guard(target, "read");
    return readFileSync(resolve(this.repoRoot, rel), "utf8");
  }

  exists(target: string): boolean {
    const rel = this.guard(target, "exists");
    return existsSync(resolve(this.repoRoot, rel));
  }

  write(target: string, contents: string): void {
    const rel = this.guard(target, "write");
    const abs = resolve(this.repoRoot, rel);
    if (!existsSync(dirname(abs))) {
      this.violations.push({ path: target, operation: "write" });
      throw new ScopeViolationError(rel, this.queueId);
    }
    // Reject a write that would not parse — §7.3: "Edits failing AST or parse
    // validation are reverted, not committed." The caller reverts; refusing the
    // bad bytes at the boundary is stronger than writing then reverting.
    assertParses(rel, contents);
    writeFileSync(abs, contents, "utf8");
    this.written.push(rel);
  }

  /** Snapshot for revert-on-failure (§7.3). */
  snapshot(target: string): string | null {
    const rel = this.guard(target, "snapshot");
    const abs = resolve(this.repoRoot, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  restore(target: string, contents: string | null): void {
    const rel = this.guard(target, "restore");
    const abs = resolve(this.repoRoot, rel);
    if (contents === null) return;
    writeFileSync(abs, contents, "utf8");
  }

  get files(): string[] {
    return [...this.allowed].sort();
  }

  isJson(relPath: string): boolean {
    return relPath.endsWith(".json");
  }
}

function assertParses(rel: string, contents: string): void {
  if (rel.endsWith(".json")) {
    try {
      JSON.parse(contents);
    } catch (err) {
      throw new Error(`Refusing to write invalid JSON to ${rel}: ${(err as Error).message}`);
    }
  }
  // JS/TS syntax validation happens in the fixer via ts-morph after the edit; the
  // facade only guards scope, which is its single responsibility (Annex A.2).
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
