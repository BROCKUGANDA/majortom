// src/verify/adapters.ts — test-runner adapters, SPEC.md §8.1
//
// ALLOWED (§7.4): the pinned test-runner invocation, and reading files.
// FORBIDDEN: editing source files — triage never fixes.
//
// The runner is DETECTED (config.testRunner.detect = ["vitest","jest"]) and invoked
// through an allowlisted argument builder. There is no shell string interpolated
// from user data: the command is an argv array, so a repo name can never become a
// second command (I9).

import { readFileSync, rmSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { Baseline, type TestResult } from "./schemas.js";
import { scrubbedEnv } from "../core/manifest.js";

const execFileAsync = promisify(execFile);

export type Runner = "vitest" | "jest";

export interface RunOptions {
  repoRoot: string;
  runner: Runner;
  timeoutMs: number;
  /** Test ids to re-run in isolation for flake control (§8.2). */
  only?: string[];
  env?: NodeJS.ProcessEnv;
}

export class NoTestsError extends Error {
  readonly code = "E_NO_TESTS" as const;
  constructor(message: string) {
    super(message);
    this.name = "NoTestsError";
  }
}

export class TestTimeoutError extends Error {
  readonly code = "E_TEST_TIMEOUT" as const;
  constructor(message: string) {
    super(message);
    this.name = "TestTimeoutError";
  }
}

/**
 * Build the argv for the runner. No shell string is ever constructed.
 *
 * `outputFile` MUST be an absolute path: a relative one is resolved against the
 * runner's cwd, so the report lands somewhere the caller never looks and the run
 * reports "no test results" for a suite that actually ran.
 */
export function buildArgs(
  runner: Runner,
  outputFile: string,
  only?: string[],
  configFile?: string
): string[] {
  if (runner === "vitest") {
    const args = ["vitest", "run", "--reporter=json", `--outputFile=${outputFile}`];
    if (configFile) args.push("--config", configFile);
    if (only?.length) args.push("-t", only.join("|"));
    return args;
  }
  const args = ["jest", "--json", `--outputFile=${outputFile}`];
  if (configFile) args.push("--config", configFile);
  if (only?.length) args.push("-t", only.join("|"));
  return args;
}

/** Run the suite and parse its JSON report into the §8.1 Baseline shape. */
export async function runSuite(options: RunOptions): Promise<Baseline> {
  const started = Date.now();
  // This host exports npm_config_allow_scripts, which makes npm ABORT with
  // "EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped installs".
  // Scrub every npm_config_* key, not just userconfig.
  const env = scrubbedEnv({ ...options.env, CI: "1" });

  // The JSON reporter writes NOTHING to stdout, so the report must be read back from
  // disk. Use an ABSOLUTE output path: a relative one resolves against the runner's
  // cwd, which is not necessarily the repo under test, and the run then reports
  // "no test results" for a suite that actually ran.
  const reportPath = join(options.repoRoot, ".majortom-vitest-results.json");
  const args =
    options.runner === "vitest"
      ? ["vitest", "run", "--reporter=json", `--outputFile=${reportPath}`]
      : buildArgs(options.runner, reportPath, options.only);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const res = await execFileAsync("npx", args, {
      cwd: options.repoRoot,
      env,
      timeout: options.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    if (e.killed) throw new TestTimeoutError(`Test run exceeded ${options.timeoutMs}ms`);
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    exitCode = typeof e.code === "number" ? e.code : 1;
  }

  // Prefer the on-disk report; fall back to stdout for runners that print JSON.
  let reportText = "";
  try {
    reportText = readFileSync(reportPath, "utf8");
  } catch {
    reportText = "";
  } finally {
    try {
      rmSync(reportPath, { force: true });
    } catch {
      /* best effort: the file may not exist */
    }
  }
  if (!reportText.trim()) reportText = stdout;

  const parsed = parseReport(options.runner, reportText, stderr);
  const totalMs = Date.now() - started;

  if (parsed.results.length === 0 && parsed.collectionErrors.length === 0) {
    throw new NoTestsError(
      `The suite produced no test results on ${options.runner}. ` +
        `MajorTom does not migrate a repo it cannot verify (SPEC.md 8.1).\n` +
        `stdout: ${stdout.slice(0, 800)}\nstderr: ${stderr.slice(0, 800)}`
    );
  }

  const baseline: Baseline = {
    runner: options.runner,
    command: `npx ${args.join(" ")}`,
    exitCode,
    totalMs,
    results: parsed.results,
    failingIds: parsed.results
      .filter((r) => r.status === "fail" || r.status === "error")
      .map((r) => r.id),
    collectionErrors: parsed.collectionErrors,
  };
  return baseline;
}

/** Parse a vitest/jest JSON report into stable `file::suite::test` ids (§8.1). */
export function parseReport(
  runner: Runner,
  stdout: string,
  stderr: string
): { results: TestResult[]; collectionErrors: string[] } {
  const results: TestResult[] = [];
  const collectionErrors: string[] = [];

  // vitest --reporter=json writes the report to stdout.
  const json = extractJson(stdout) ?? extractJson(stderr);
  if (!json) {
    if (/No test files found|no tests found/i.test(stdout + stderr)) {
      collectionErrors.push("no test files found");
    }
    return { results, collectionErrors };
  }

  // Distinguish the two report shapes. Vitest's JSON ALSO carries a `testResults`
  // key, so `runner` alone is not enough — and testing for the key alone sends
  // every vitest report down the jest branch, silently losing the suite path.
  // Jest's assertions carry `fullName`; vitest's carry `ancestorTitles`.
  const suites = ((json as { testResults?: unknown }).testResults ?? []) as Array<
    Record<string, unknown>
  >;
  const firstAssertion = (
    suites[0]?.assertionResults as Array<Record<string, unknown>> | undefined
  )?.[0];
  const isJestShape = firstAssertion !== undefined && "fullName" in firstAssertion;

  if (runner === "jest" || isJestShape) {
    for (const s of suites) {
      const suite = s as {
        name?: string;
        message?: string;
        assertionResults?: Array<{
          fullName?: string;
          title?: string;
          status?: string;
          duration?: number | null;
          failureMessages?: string[];
        }>;
      };
      const file = (suite.name ?? "unknown").replace(/\\/g, "/");
      if (suite.message) collectionErrors.push(`${file}: ${suite.message}`);
      for (const t of suite.assertionResults ?? []) {
        results.push({
          id: `${file}::${t.fullName ?? t.title ?? "?"}`,
          status: mapJestStatus(t.status),
          durationMs: t.duration ?? null,
          message: t.failureMessages?.[0] ?? null,
        });
      }
    }
    return { results, collectionErrors };
  }

  // vitest
  for (const s of suites) {
    const suite = s as {
      name?: string;
      status?: string;
      message?: string;
      assertionResults?: Array<{
        fullName?: string;
        title?: string;
        ancestorTitles?: string[];
        status?: string;
        duration?: number | null;
        failureMessages?: string[];
      }>;
    };
    const file = (suite.name ?? "unknown").replace(/\\/g, "/");
    if (suite.status === "failed" && (suite.assertionResults?.length ?? 0) === 0) {
      collectionErrors.push(`${file}: ${suite.message ?? "collection error"}`);
    }
    for (const t of suite.assertionResults ?? []) {
      const suitePath = (t.ancestorTitles ?? []).join(" > ");
      // §8.1 id shape: file::suitePath::testName
      const label = suitePath ? `${suitePath}::${t.title ?? "?"}` : (t.title ?? "?");
      results.push({
        id: `${file}::${label}`,
        status: mapJestStatus(t.status),
        durationMs: t.duration ?? null,
        message: t.failureMessages?.[0] ?? null,
      });
    }
  }
  return { results, collectionErrors };
}

function mapJestStatus(status: string | undefined): TestResult["status"] {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "pending":
    case "todo":
    case "skipped":
      return "skip";
    default:
      return "error";
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  // The JSON report is the last top-level object in the output.
  for (let end = text.length; end > start; end--) {
    if (text[end - 1] !== "}") continue;
    try {
      return JSON.parse(text.slice(start, end)) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}
