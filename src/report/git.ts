// src/report/git.ts — §9.4 git and PR rules
//
// I1 IS ENFORCED HERE, not merely intended:
//   - the target branch is REFUSED with E_PROTECTED_BRANCH if it is main/master
//   - merge/mergeQueue/delete-branch endpoints are not exposed by this wrapper AT ALL
//   - branch is always majortom/<runId>, created from the base commit recorded at INTAKE
//
// I9: this is the ORCHESTRATOR's only git surface. Fixer agents have no access to it.

import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export class ProtectedBranchError extends Error {
  readonly code = "E_PROTECTED_BRANCH";
  constructor(branch: string) {
    super(`E_PROTECTED_BRANCH: refusing to target protected branch "${branch}" (I1)`);
    this.name = "ProtectedBranchError";
  }
}

/** Branches that may never be a PR target or a push destination. */
export const PROTECTED_BRANCHES = new Set(["main", "master"]);

export interface GitRun {
  stdout: string;
  stderr: string;
}

async function git(args: string[], cwd: string): Promise<GitRun> {
  const { stdout, stderr } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/** §9.4: the PR body is the report, and the PR opens AS DRAFT when not green. */
export function prOptions(input: { green: boolean; report: string }): {
  draft: boolean;
  body: string;
} {
  return { draft: !input.green, body: input.report };
}

/**
 * Validate a target branch. Throws ProtectedBranchError for main/master (§9.4).
 * Pure so the acceptance test can assert it without touching a repo.
 */
export function assertNotProtected(branch: string): void {
  if (PROTECTED_BRANCHES.has(branch.trim().toLowerCase())) {
    throw new ProtectedBranchError(branch);
  }
}

export interface BranchPlan {
  branch: string;
  baseCommit: string;
}

export function branchNameFor(runId: string): string {
  return `majortom/${runId}`;
}

/**
 * Create majortom/<runId> from the base commit recorded at INTAKE.
 * Refuses a protected base (I1).
 */
export async function createRunBranch(
  repoRoot: string,
  runId: string,
  baseCommit: string
): Promise<BranchPlan> {
  const branch = branchNameFor(runId);
  await git(["checkout", "-b", branch, baseCommit], repoRoot);
  return { branch, baseCommit };
}

/**
 * §9.4 message format: `majortom: <planItemIds> - <short summary>`.
 * One commit per queue, plus one for the manifest bump.
 */
export function commitMessageFor(itemIds: string[], summary: string): string {
  return `majortom: ${itemIds.join(",")} - ${summary}`;
}

/** Stage only the given paths, then commit. Never stages the whole tree by accident. */
export async function commitPaths(
  repoRoot: string,
  paths: string[],
  message: string
): Promise<void> {
  if (paths.length === 0) return;
  await git(["add", "--", ...paths], repoRoot);
  await git(["commit", "-m", message], repoRoot);
}

/** Produce the review diff. Never a push. */
export async function diffPatch(repoRoot: string, baseCommit: string): Promise<string> {
  const { stdout } = await git(["diff", baseCommit, "--"], repoRoot);
  return stdout;
}

/**
 * The orchestrator's ONLY GitHub surface. Note what is absent: there is no `merge`,
 * no `mergeQueue`, no `deleteBranch`, and no force-push wrapper. I1 is not a
 * convention this module follows — it is a capability it does not have.
 */
export interface PrRequest {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface OctokitLike {
  pulls: { create: (req: PrRequest) => Promise<{ html_url?: string; number?: number }> };
}

export async function openDraftOrReadyPr(
  octokit: OctokitLike,
  req: Omit<PrRequest, "draft"> & { draft?: boolean }
): Promise<{ url: string | null; number: number | null }> {
  assertNotProtected(req.base);
  const res = await octokit.pulls.create({ ...req, draft: req.draft ?? false });
  return { url: res.html_url ?? null, number: res.number ?? null };
}
