// src/core/errors.ts
// Error taxonomy from SPEC.md §3.5

export type ErrorCode =
  | "E_REPO_DIRTY"
  | "E_NO_TESTS"
  | "E_NO_LOCKFILE"
  | "E_GUIDE_UNREADABLE"
  | "E_GUIDE_VERSION_MISMATCH"
  | "E_PLAN_EMPTY"
  | "E_INSTALL_FAILED"
  | "E_TEST_RUNNER_UNKNOWN"
  | "E_TEST_TIMEOUT"
  | "E_FIXER_EXHAUSTED"
  | "E_VERIFY_EXHAUSTED"
  | "E_SCOPE_VIOLATION"
  | "E_PROTECTED_BRANCH"
  | "E_GITHUB_API"
  | "E_RUN_TIMEOUT";

const ALWAYS_FATAL: ReadonlySet<ErrorCode> = new Set(["E_SCOPE_VIOLATION", "E_PROTECTED_BRANCH"]);

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "E_INSTALL_FAILED",
  "E_TEST_TIMEOUT",
  "E_GITHUB_API",
  "E_RUN_TIMEOUT",
]);

export class MajorTomError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "MajorTomError";
    this.code = code;
    this.retryable = !ALWAYS_FATAL.has(code) && RETRYABLE.has(code);
  }

  toJSON(): { code: ErrorCode; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
