#!/usr/bin/env node
// src/cli/index.ts — the MajorTom CLI (SPEC.md §2)
//
// `majortom migrate --repo <path> --dep <name> --to <version> --guide <path>`
//
// The CLI is a thin shell over the orchestrator. It validates arguments and NOTHING
// else — no git, no network, no file writes of its own. I1 and I9 are properties of
// the orchestrator and its components, not of this file.

import { readFileSync } from "fs";
import { join } from "path";
import { runMigration } from "../core/orchestrator.js";
import { MajorTomError } from "../core/errors.js";
import { readLedger, runDir } from "../core/ledger.js";

interface Args {
  command: string;
  flags: Map<string, string>;
  bools: Set<string>;
}

const USAGE = `MajorTom — a guide-driven dependency migration agent

USAGE
  majortom migrate --repo <path> --dep <name> --to <version> --guide <path>
                   [--from <version>] [--runner vitest|jest] [--parallelism <n>]
                   [--dry-run] [--timeout <ms>]
  majortom status --repo <path> --run <runId>
  majortom --help

MIGRATE OPTIONS
  --repo <path>        repository to migrate (required)
  --dep <name>         dependency to upgrade (required)
  --to <version>       target major version (required)
  --guide <path>       migration guide: .md or .pdf
  --from <version>     current version, for the report header (default: read from the manifest)
  --runner <name>      vitest | jest (default: vitest)
  --parallelism <n>    fixer fan-out width (default: 3)
  --timeout <ms>       hard run timeout (default: 1800000)
  --dry-run            produce a diff preview without writing any file

I1: work happens on majortom/<runId>; main is never touched.
I6: the command exits non-zero whenever the run is NOT green.`;

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) {
      // The first bare token is the command; later ones are ignored (no subcommands
      // take positional arguments).
      if (command === "") command = tok;
      continue;
    }
    const key = tok.slice(2);
    if (key === "dry-run" || key === "help" || key === "version") {
      bools.add(key);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      bools.add(key);
    } else {
      flags.set(key, next);
      i++;
    }
  }
  // `majortom --help` has no command token at all; treat the flag as the request.
  if (command === "" && bools.has("help")) command = "help";
  return { command, flags, bools };
}

function requireFlag(args: Args, name: string): string {
  const v = args.flags.get(name);
  // The spec's §3.5 taxonomy has no "bad CLI input" code, so argument errors use
  // E_RUN_TIMEOUT rather than inventing a code outside the taxonomy.
  if (!v) throw new MajorTomError("E_RUN_TIMEOUT", `Missing required flag --${name}`);
  return v;
}

function readCurrentVersion(repoRoot: string, dep: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const raw = pkg.dependencies?.[dep] ?? "unknown";
    return raw.replace(/^[\^~]/, "");
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.bools.has("help") || args.command === "" || args.command === "help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  if (args.command === "migrate") {
    const repoRoot = requireFlag(args, "repo");
    const dep = requireFlag(args, "dep");
    const to = requireFlag(args, "to");
    const guide = requireFlag(args, "guide");
    const from = args.flags.get("from") ?? readCurrentVersion(repoRoot, dep);
    const runner = (args.flags.get("runner") ?? "vitest") as "vitest" | "jest";
    const parallelism = Number(args.flags.get("parallelism") ?? "3");
    const timeoutMs = Number(args.flags.get("timeout") ?? "1800000");

    if (!Number.isFinite(parallelism) || parallelism < 1) {
      throw new MajorTomError("E_RUN_TIMEOUT", "--parallelism must be a positive integer");
    }

    const result = await runMigration({
      repoRoot,
      dependency: dep,
      fromVersion: from,
      toVersion: to,
      guide,
      testCommand: runner === "vitest" ? ["vitest", "run"] : ["jest"],
      testRunner: runner,
      parallelism,
      maxEditAttemptsPerFile: 5,
      maxVerifyIterations: 3,
      timeoutMs,
      dryRun: args.bools.has("dry-run"),
    });

    process.stdout.write(result.report + "\n");
    process.stdout.write(
      `\nrun ${result.runId} — branch majortom/${result.runId} — ` +
        `${result.changedFiles.length} file(s) changed — citation coverage ` +
        `${(result.citationCoverage * 100).toFixed(0)}% — ` +
        `${result.green ? "GREEN" : "NOT GREEN"}\n`
    );

    // I6: the exit code IS the verdict. A non-green run is a failed command.
    return result.green ? 0 : 1;
  }

  if (args.command === "status") {
    const repoRoot = requireFlag(args, "repo");
    const runId = requireFlag(args, "run");
    const ledger = readLedger(repoRoot, runId);
    process.stdout.write(JSON.stringify(ledger, null, 2) + "\n");
    process.stdout.write(`artifacts: ${runDir(repoRoot, runId)}/artifacts\n`);
    return ledger.status === "failed" ? 1 : 0;
  }

  process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}\n`);
  return 2;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    if (err instanceof MajorTomError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`E_UNEXPECTED: ${(err as Error).message}\n`);
    process.exit(1);
  });
