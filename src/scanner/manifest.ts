// src/scanner/manifest.ts
// scanManifest() per SPEC.md §6.1

import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface DependencyEntry {
  name: string;
  declaredRange: string;
  resolvedVersion: string | null;
  majorDistance: number | null;
}

export interface ManifestScan {
  packageManager: "npm" | "pnpm" | "unknown";
  hasLockfile: boolean;
  hasTestScript: boolean;
  workspaces: boolean;
  dependencies: DependencyEntry[];
  warnings: string[];
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: unknown;
  engines?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<string, { version?: string }>;
}

export function scanManifest(repoRoot: string): ManifestScan {
  const warnings: string[] = [];

  // Read package.json
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      packageManager: "unknown",
      hasLockfile: false,
      hasTestScript: false,
      workspaces: false,
      dependencies: [],
      warnings: ["E_NO_LOCKFILE: package.json not found"],
    };
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
  } catch {
    return {
      packageManager: "unknown",
      hasLockfile: false,
      hasTestScript: false,
      workspaces: false,
      dependencies: [],
      warnings: ["package.json is not valid JSON"],
    };
  }

  // Detect package manager
  const hasNpmLock = existsSync(join(repoRoot, "package-lock.json"));
  const hasPnpmLock = existsSync(join(repoRoot, "pnpm-lock.yaml"));
  const hasLockfile = hasNpmLock || hasPnpmLock;
  const packageManager: ManifestScan["packageManager"] = hasPnpmLock
    ? "pnpm"
    : hasNpmLock
      ? "npm"
      : "unknown";

  if (!hasLockfile) {
    warnings.push("E_NO_LOCKFILE: no lockfile found (package-lock.json or pnpm-lock.yaml)");
  }

  // Detect test script
  const hasTestScript = !!(
    pkg.scripts?.["test"] ||
    pkg.scripts?.["vitest"] ||
    pkg.scripts?.["jest"]
  );
  if (!hasTestScript) {
    warnings.push("E_NO_TESTS: no test script found in package.json");
  }

  // Workspace detection
  const workspaces = !!(pkg.workspaces);

  // Read resolved versions from lockfile
  const resolvedVersions = new Map<string, string>();
  if (hasNpmLock) {
    try {
      const lock = JSON.parse(
        readFileSync(join(repoRoot, "package-lock.json"), "utf8")
      ) as PackageLock;
      for (const [pkg, data] of Object.entries(lock.packages ?? {})) {
        // pkg is like "node_modules/express" or "node_modules/foo/node_modules/express"
        const parts = pkg.split("/");
        const name = parts[parts.length - 1] ?? "";
        if (name && data.version) {
          resolvedVersions.set(name, data.version);
        }
      }
    } catch {
      // lockfile unreadable — ignore
    }
  }

  // Collect all deps
  const allDeps: Record<string, string> = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };

  const dependencies: DependencyEntry[] = Object.entries(allDeps).map(([name, range]) => {
    const resolved = resolvedVersions.get(name) ?? null;
    const majorDistance = resolved ? computeMajorDistance(range, resolved) : null;
    return { name, declaredRange: range, resolvedVersion: resolved, majorDistance };
  });

  return { packageManager, hasLockfile, hasTestScript, workspaces, dependencies, warnings };
}

function computeMajorDistance(declaredRange: string, resolvedVersion: string): number | null {
  // Extract the declared major version from common range strings
  // e.g. "^4.21.2" → 4, "~5.0.0" → 5, "4.21.2" → 4
  const declaredMajorMatch = declaredRange.match(/[~^]?(\d+)\./);
  const resolvedMajorMatch = resolvedVersion.match(/^(\d+)\./);
  if (!declaredMajorMatch || !resolvedMajorMatch) return null;

  const declaredMajor = parseInt(declaredMajorMatch[1]!, 10);
  const resolvedMajor = parseInt(resolvedMajorMatch[1]!, 10);
  return Math.abs(resolvedMajor - declaredMajor);
}
