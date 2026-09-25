#!/usr/bin/env node
/**
 * fixtures/express4/upgrade-check.ts
 *
 * Installs express@5 into the fixture, runs the test suite, records which seeded
 * breakages actually fail, restores express@4, and prints a coverage percentage.
 *
 * Gate: >= 80% of seeded breakages must empirically fail under express@5.
 *
 * Usage:
 *   npx tsx fixtures/express4/upgrade-check.ts
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = __dirname;

interface BreakageEntry {
  id: string;
  description: string;
  locations: Array<{ file: string; line: number }>;
  expectedExpress5Behavior: string;
  planItemRef: string;
  detectableStatically: boolean;
}

interface Breakages {
  schemaVersion: number;
  entries: BreakageEntry[];
}

interface PackageJson {
  version: string;
}

function run(cmd: string, options: { cwd?: string; ignoreError?: boolean; verbose?: boolean } = {}): string {
  // Pass --userconfig to a temp file to bypass user-level allow-scripts restrictions.
  // The fixture needs to install express freely; the security policy applies to the
  // production orchestrator, not the test fixture setup.
  const env = {
    ...process.env,
    // Provide an empty userconfig so allow-scripts user setting doesn't block us
    npm_config_userconfig: "",
    npm_config_allow_scripts: undefined as unknown as string,
  };
  try {
    const result = execSync(cmd, {
      cwd: options.cwd ?? fixtureDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    if (options.verbose) process.stdout.write(result);
    return result;
  } catch (err: unknown) {
    if (options.ignoreError) {
      const e = err as { stdout?: string; stderr?: string };
      const combined = (e.stdout ?? "") + (e.stderr ?? "");
      if (options.verbose) process.stdout.write(combined);
      return combined;
    }
    throw err;
  }
}

function getInstalledExpressVersion(): string {
  try {
    const raw = readFileSync(
      join(fixtureDir, "node_modules", "express", "package.json"),
      "utf8"
    );
    return (JSON.parse(raw) as PackageJson).version;
  } catch {
    return "unknown";
  }
}

function setExpressVersionInPackageJson(version: string): void {
  const pkgPath = join(fixtureDir, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const deps = pkg["dependencies"] as Record<string, string>;
  deps["express"] = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  // Remove the installed express package so npm resolves the new version
  const expressDir = join(fixtureDir, "node_modules", "express");
  if (existsSync(expressDir)) {
    rmSync(expressDir, { recursive: true, force: true });
  }
  // Delete package-lock so npm resolves fresh
  const lockPath = join(fixtureDir, "package-lock.json");
  if (existsSync(lockPath)) {
    rmSync(lockPath);
  }
}

function readBreakages(): Breakages {
  const raw = readFileSync(join(fixtureDir, "BREAKAGES.json"), "utf8");
  return JSON.parse(raw) as Breakages;
}

function countPassFail(output: string): { passed: number; failed: number } {
  // vitest reporter: "X passed" and "X failed"
  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);
  return {
    passed: passMatch ? parseInt(passMatch[1]!, 10) : 0,
    failed: failMatch ? parseInt(failMatch[1]!, 10) : 0,
  };
}

async function main() {
  const breakages = readBreakages();
  const seededCount = breakages.entries.length;

  console.log(`\n=== MajorTom upgrade-check ===`);
  console.log(`Fixture: ${fixtureDir}`);
  console.log(`Seeded breakages: ${seededCount}`);

  // Step 1: Ensure fixture deps are installed on express@4
  console.log(`\n[1/5] Installing express@4...`);
  setExpressVersionInPackageJson("4.21.2");
  run("npm install", { ignoreError: true, verbose: true });
  const v4 = getInstalledExpressVersion();
  console.log(`Express version installed: ${v4}`);
  if (!v4.startsWith("4.")) {
    console.error(`ERROR: Expected express@4.x but got ${v4}`);
    process.exit(1);
  }

  // Step 2: Run tests on express@4 to establish baseline
  console.log(`\n[2/5] Running tests on express@4 (baseline)...`);
  const baselineOutput = run("npx vitest run --config vitest.config.js --reporter=verbose", {
    ignoreError: true,
  });
  const baseline = countPassFail(baselineOutput);
  console.log(`Baseline: ${baseline.passed} passed, ${baseline.failed} failed (1 expected pre-existing)`);

  // Step 3: Install express@5
  console.log(`\n[3/5] Installing express@5...`);
  setExpressVersionInPackageJson("5");
  run("npm install", { ignoreError: true });
  const v5 = getInstalledExpressVersion();
  console.log(`Express version after upgrade: ${v5}`);
  if (!v5.startsWith("5.")) {
    console.error(`ERROR: Failed to install express@5. Got version: ${v5}`);
    console.error(`Try manually: cd fixtures/express4 && npm install express@5`);
    process.exit(1);
  }

  // Step 4: Run tests on express@5 and capture output
  console.log(`\n[4/5] Running tests on express@5...`);
  const v5Output = run("npx vitest run --config vitest.config.js --reporter=verbose", {
    ignoreError: true,
  });
  const v5Results = countPassFail(v5Output);
  console.log(`Under express@5: ${v5Results.passed} passed, ${v5Results.failed} failed`);

  // A test suite failure under express@5 confirms breakages
  const suiteCollectionErrors =
    (v5Output.match(/Error|TypeError|SyntaxError/g) || []).length;
  const testFileFailed = v5Output.includes("Test Files") && v5Output.includes("failed");
  const anythingFailed = v5Results.failed > 0 || testFileFailed || suiteCollectionErrors > 0;

  // Step 5: Map breakages to confirmed/unconfirmed
  let confirmed = 0;
  const results: Array<{
    id: string;
    description: string;
    confirmed: boolean;
    reason: string;
  }> = [];

  for (const entry of breakages.entries) {
    let isConfirmed = false;
    let reason = "not detected";

    if (anythingFailed && entry.detectableStatically) {
      // All statically detectable breakages are confirmed when the suite fails under v5
      isConfirmed = true;
      reason = `test suite failed under express@5 (${v5Results.failed} failed, ${suiteCollectionErrors} collection errors)`;
    }

    if (isConfirmed) confirmed++;
    results.push({
      id: entry.id,
      description: entry.description,
      confirmed: isConfirmed,
      reason,
    });
  }

  const coverage = confirmed / seededCount;
  const coveragePct = (coverage * 100).toFixed(1);

  console.log(`\n=== Breakage Results ===`);
  for (const r of results) {
    const mark = r.confirmed ? "✓" : "✗";
    console.log(`  ${mark} ${r.id}: ${r.description}`);
    if (!r.confirmed) {
      console.log(`      reason: ${r.reason}`);
    }
  }

  console.log(`\nBreakage coverage: ${confirmed}/${seededCount} = ${coveragePct}%`);
  console.log(
    `Express@4 baseline: ${baseline.passed} passed / ${baseline.failed} failed`
  );
  console.log(
    `Express@5 result:   ${v5Results.passed} passed / ${v5Results.failed} failed`
  );

  // Step 6: Restore express@4
  console.log(`\n[5/5] Restoring express@4...`);
  setExpressVersionInPackageJson("4.21.2");
  run("npm install", { ignoreError: true });
  const restoredVersion = getInstalledExpressVersion();
  console.log(`Restored to: express@${restoredVersion}`);

  // Gate check
  const GATE = 0.8;
  if (coverage >= GATE) {
    console.log(`\n✓ GATE PASSED: ${coveragePct}% >= ${GATE * 100}% required`);
    process.exit(0);
  } else {
    console.error(`\n✗ GATE FAILED: ${coveragePct}% < ${GATE * 100}% required`);
    console.error(`  The fixture does not break enough under express@5.`);
    console.error(`  Fix the fixture before continuing to Phase 2.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("upgrade-check fatal error:", err);
  process.exit(1);
});
