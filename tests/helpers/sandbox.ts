// tests/helpers/sandbox.ts — in-repo scratch space for tests that need a real tree.
//
// WHY THIS EXISTS: acceptance tests copy fixtures/express4 into a scratch directory
// so the committed fixture is never mutated. Using os.tmpdir() put those copies in
// the user's %TEMP%, scattering build artifacts outside the project. Everything now
// lands under <repo>/.test-sandbox/ instead, which is gitignored and deleted on exit.
//
// This is test infrastructure only — it has no role in the runtime.

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

const REPO_ROOT = resolve(__dirname, "..", "..");

/** Root of the in-repo sandbox. Gitignored; safe to delete wholesale. */
export const SANDBOX_ROOT = join(REPO_ROOT, ".test-sandbox");

/**
 * Copy `sourceDir` into a fresh sandbox directory and return its absolute path.
 * The caller is responsible for calling `rmSandbox` (or `cleanupAllSandboxes`).
 */
export function sandboxCopy(sourceDir: string, prefix: string): string {
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SANDBOX_ROOT, `${prefix}-`));
  cpSync(sourceDir, dir, { recursive: true });
  return dir;
}

/** Remove one sandbox directory. Safe to call on a path that never existed. */
export function rmSandbox(dir: string): void {
  if (dir && dir.startsWith(SANDBOX_ROOT)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Remove the whole sandbox tree — used only by a serial/global teardown. */
export function cleanupAllSandboxes(): void {
  if (existsSync(SANDBOX_ROOT)) {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Write a file inside the sandbox, creating parent directories. */
export function sandboxWrite(dir: string, relPath: string, contents: string): string {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, "utf8");
  return abs;
}
