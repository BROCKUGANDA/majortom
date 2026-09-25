// src/core/manifest.ts — the dependency manifest bump, SPEC.md §9.4
//
// §9.4 assigns the manifest bump its own commit: "One commit per queue plus one for
// the manifest bump." Without it the run rewrites source code for a major-version
// migration while the manifest still pins the OLD major — the code is correct for
// express@5 but still installed as express@4, so verification honestly reports
// NOT GREEN.
//
// I2 applies here exactly as it does to every other edit: the bump is driven by the
// plan and recorded with a citation. It is NOT an untracked side effect.
//
// I1: this module only WRITES the file. It never commits, pushes, or branches —
// those are the orchestrator's job, and it must refuse a protected target.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import type { PlanItem } from "../docs/schemas.js";

export type Ecosystem = "npm" | "pip" | "go" | "cargo";

export interface ManifestBump {
  file: string;
  from: string;
  to: string;
  changed: boolean;
  /** I2: the plan item that justifies this change, or null when already correct. */
  itemId: string | null;
  citationRef: string | null;
}

export interface BumpResult {
  bump: ManifestBump;
  written: boolean;
}

/** The manifest file for an ecosystem, in the order npm would resolve it. */
export function manifestCandidates(ecosystem: Ecosystem, repoRoot: string): string[] {
  switch (ecosystem) {
    case "npm":
      return ["package.json"];
    case "pip":
      return ["requirements.txt", "pyproject.toml"];
    case "go":
      return ["go.mod"];
    case "cargo":
      return ["Cargo.toml"];
    default:
      return [join(repoRoot, "package.json")];
  }
}

/** Read the currently-declared version of a dependency, if the manifest declares it. */
export function readDeclaredVersion(
  contents: string,
  ecosystem: Ecosystem,
  dep: string
): string | null {
  if (ecosystem === "npm") {
    try {
      const pkg = JSON.parse(contents) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const raw =
        pkg.dependencies?.[dep] ?? pkg.devDependencies?.[dep] ?? pkg.peerDependencies?.[dep];
      return typeof raw === "string" ? raw.replace(/^[\^~]/, "") : null;
    } catch {
      return null;
    }
  }
  // Non-npm manifests: a single anchored line is enough to read the pin.
  const re = new RegExp(
    `^\\s*"?${dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*[:=]\\s*"?([^"\\s]+)"?`,
    "m"
  );
  const m = re.exec(contents);
  return m?.[1] ?? null;
}

/** Write the bumped version, preserving the rest of the file byte-for-byte. */
function writeDeclaredVersion(
  contents: string,
  ecosystem: Ecosystem,
  dep: string,
  version: string
): string | null {
  if (ecosystem === "npm") {
    try {
      const pkg = JSON.parse(contents) as Record<string, unknown>;
      let touched = false;
      for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
        const block = pkg[field] as Record<string, string> | undefined;
        if (block && typeof block[dep] === "string") {
          block[dep] = version;
          touched = true;
        }
      }
      if (!touched) return null;
      // Match the file's own trailing-newline convention.
      const trailing = contents.endsWith("\n") ? "\n" : "";
      return `${JSON.stringify(pkg, null, 2)}${trailing}`;
    } catch {
      return null;
    }
  }
  const re = new RegExp(
    `^(\\s*"?${dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*[:=]\\s*")([^"]+)(")`,
    "m"
  );
  if (!re.test(contents)) return null;
  return contents.replace(re, `$1${version}$3`);
}

/**
 * Bump the dependency's declared version in its manifest.
 *
 * `planItem` is the citation carrier (I2). When the manifest already declares the
 * target version, this is a no-op and `changed` is false — MajorTom never claims to
 * have done work it did not do.
 */
export function bumpManifest(params: {
  repoRoot: string;
  ecosystem: Ecosystem;
  dependency: string;
  toVersion: string;
  /** The plan item authorising the bump; omit for an uncited (H1) bump. */
  planItem?: PlanItem;
  /** false = compute the change but do not write (dry-run). */
  write: boolean;
}): BumpResult {
  const { repoRoot, ecosystem, dependency, toVersion, planItem, write } = params;
  const bump: ManifestBump = {
    file: "",
    from: "",
    to: toVersion,
    changed: false,
    itemId: null,
    citationRef: null,
  };

  for (const rel of manifestCandidates(ecosystem, repoRoot)) {
    let contents: string;
    try {
      contents = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue; // manifest not present for this candidate; try the next
    }

    const current = readDeclaredVersion(contents, ecosystem, dependency);
    if (current === null) continue;

    bump.file = rel;
    bump.from = current;
    if (current === toVersion) return { bump, written: false }; // already correct

    const next = writeDeclaredVersion(contents, ecosystem, dependency, toVersion);
    if (next === null || next === contents) return { bump, written: false };

    bump.changed = true;
    bump.itemId = planItem?.id ?? null;
    bump.citationRef = planItem
      ? `${planItem.citation.locator} — ${planItem.citation.sectionTitle}`
      : null;

    if (write) {
      writeFileSync(join(repoRoot, rel), next, "utf8");
      return { bump, written: true };
    }
    return { bump, written: false };
  }

  return { bump, written: false };
}

/**
 * §9.4's commit-message format for the manifest bump:
 *   `majortom: <planItemIds> - bump <dep> to <version>`
 */
export function manifestCommitMessage(bump: ManifestBump): string {
  const ids = bump.itemId ? [bump.itemId] : ["no-plan-item"];
  return `majortom: ${ids.join(",")} - bump ${bump.file} to ${bump.to}`;
}

// ---------------------------------------------------------------------------
// Reinstall
// ---------------------------------------------------------------------------

export interface InstallResult {
  ran: boolean;
  ok: boolean;
  exitCode: number | null;
  /** Truncated stderr/stdout — enough to diagnose, never a silent failure. */
  output: string;
  wallClockMs: number;
}

/**
 * A child-process env with inherited npm policy config removed.
 *
 * This host exports npm_config_allow_scripts, which makes npm ABORT a project-scoped
 * install with "EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped
 * installs". It is an environment problem, not a repo problem, so every child process
 * MajorTom spawns must be shielded from it. Clearing only npm_config_userconfig is not
 * enough — all npm_config_* keys have to go.
 */
export function scrubbedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_config_")) delete env[key];
  }
  return env;
}

/**
 * Reinstall the target repo's dependencies after a manifest bump.
 *
 * A bumped manifest is a DECLARATION; node_modules still holds the old major until an
 * install runs. Verifying before that measures the wrong thing, so this runs between
 * the bump and the verify stage.
 *
 * I1: this only mutates the target's own dependency tree, which is what the user asked
 * for by requesting a migration. It never touches git.
 *
 * Honesty: a non-zero exit is REPORTED, not thrown and not swallowed — the caller
 * decides, and the report can say the install failed.
 */
export async function installDependencies(params: {
  repoRoot: string;
  ecosystem: Ecosystem;
  enabled: boolean;
  /** Passed as an explicit install target so a stale lockfile is refreshed. */
  dependency?: string;
  toVersion?: string;
  timeoutMs?: number;
}): Promise<InstallResult> {
  const { repoRoot, ecosystem, enabled, dependency, toVersion, timeoutMs = 600_000 } = params;
  const started = Date.now();

  if (!enabled) {
    return { ran: false, ok: true, exitCode: null, output: "", wallClockMs: 0 };
  }

  // On Windows `npm` is a .cmd shim, so the spawn needs `shell: true` — but passing a
  // separate argv with shell:true is deprecated (DEP0190) and concatenates unescaped.
  // The command and its flags are therefore ONE fixed literal string. No user input is
  // ever interpolated: repoRoot goes in as `cwd`, never into the command line (I9).
  //
  // `npm install` alone will NOT pick up a bumped manifest when a package-lock.json
  // exists — the lockfile keeps the old resolved version. `--package-lock-only=false`
  // is not a thing, so the upgrade is requested explicitly per dependency. When there
  // is no lockfile this degrades to a plain install, which is correct.
  const isWindows = process.platform === "win32";
  const lockExists = existsSync(join(repoRoot, "package-lock.json"));
  const installer =
    isWindows && ecosystem === "npm"
      ? "npm"
      : ecosystem === "pip"
        ? "pip"
        : ecosystem === "go"
          ? "go"
          : "cargo";

  // I9: the command line goes through a shell on Windows, so the dependency spec MUST
  // be validated against npm's own name grammar. Anything that could chain a second
  // command (`;`, `&`, backticks, spaces, redirects) is rejected outright rather than
  // escaped — a dependency name has no legitimate use for those characters.
  const spec = dependency && toVersion ? `${dependency}@${toVersion}` : "";
  if (spec && !/^[A-Za-z0-9@^~._/-]+$/.test(spec)) {
    return {
      ran: true,
      ok: false,
      exitCode: null,
      output: `refusing to install: dependency spec ${JSON.stringify(spec)} contains characters outside npm's name grammar`,
      wallClockMs: Date.now() - started,
    };
  }
  const dependencyArg = spec;

  const commandLine =
    ecosystem === "npm" && lockExists && dependencyArg
      ? `${installer} install ${dependencyArg} --no-audit --no-fund`
      : `${installer} install${ecosystem === "npm" ? " --no-audit --no-fund" : ""}`;

  // Inherited npm policy vars (npm_config_allow_scripts and friends) make npm reject a
  // project-scoped install outright. Scrub EVERY npm_config_* we did not set — clearing
  // only `userconfig` is not enough, because this host exports npm_config_allow_scripts.
  const env = scrubbedEnv();

  return new Promise<InstallResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(commandLine, {
        cwd: repoRoot,
        shell: isWindows,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        ran: true,
        ok: false,
        exitCode: null,
        output: `failed to spawn \`${commandLine}\`: ${(e as Error).message}`,
        wallClockMs: Date.now() - started,
      });
      return;
    }

    let output = "";
    const collect = (chunk: Buffer | string) => {
      output += String(chunk);
      if (output.length > 4000) output = output.slice(0, 4000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      child.kill();
      output += `\n[timed out after ${timeoutMs}ms]`;
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        ok: false,
        exitCode: null,
        output: `${output}\n${e.message}`,
        wallClockMs: Date.now() - started,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        ok: code === 0,
        exitCode: code,
        output: output.trim(),
        wallClockMs: Date.now() - started,
      });
    });
  });
}
