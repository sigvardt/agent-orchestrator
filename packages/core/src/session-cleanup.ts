import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GIT_CLEANUP_TIMEOUT_MS = 30_000;

function getExitCode(err: unknown): number | null {
  if (!(err instanceof Error) || !("code" in err)) return null;
  const code = err.code;
  return typeof code === "number" ? code : null;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function gitBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoPath,
      timeout: GIT_CLEANUP_TIMEOUT_MS,
    });
    return true;
  } catch (err: unknown) {
    if (getExitCode(err) === 1) {
      return false;
    }
    throw err;
  }
}

export async function isGitWorktreeRegistered(
  repoPath: string,
  workspacePath: string,
): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoPath,
    timeout: GIT_CLEANUP_TIMEOUT_MS,
  });

  const normalizedWorkspace = resolve(workspacePath);
  return stdout.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    return resolve(line.slice("worktree ".length)) === normalizedWorkspace;
  });
}

export async function forceRemoveGitWorktree(repoPath: string, workspacePath: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], {
      cwd: repoPath,
      timeout: GIT_CLEANUP_TIMEOUT_MS,
    });
  } catch {
    // Fall through — verify end state after prune + directory cleanup.
  }

  try {
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: repoPath,
      timeout: GIT_CLEANUP_TIMEOUT_MS,
    });
  } catch {
    // Best effort — verification below decides success/failure.
  }

  if (existsSync(workspacePath)) {
    rmSync(workspacePath, { recursive: true, force: true });
  }

  const stillExists = existsSync(workspacePath);
  const stillRegistered = await isGitWorktreeRegistered(repoPath, workspacePath);
  if (stillExists || stillRegistered) {
    throw new Error(
      [
        stillRegistered ? `git still lists worktree ${workspacePath}` : null,
        stillExists ? `directory still exists at ${workspacePath}` : null,
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
}

export async function deleteLocalBranch(
  repoPath: string,
  branch: string,
): Promise<"deleted" | "missing"> {
  if (!(await gitBranchExists(repoPath, branch))) {
    return "missing";
  }

  await execFileAsync("git", ["branch", "-D", branch], {
    cwd: repoPath,
    timeout: GIT_CLEANUP_TIMEOUT_MS,
  });

  if (await gitBranchExists(repoPath, branch)) {
    throw new Error(`branch ${branch} still exists after deletion attempt`);
  }

  return "deleted";
}

export interface GitCleanupVerification {
  ok: boolean;
  failures: string[];
}

export async function verifyGitSessionCleanup(options: {
  repoPath: string;
  workspacePath?: string | null;
  branch?: string | null;
  defaultBranch: string;
}): Promise<GitCleanupVerification> {
  const failures: string[] = [];

  if (options.workspacePath) {
    try {
      if (existsSync(options.workspacePath)) {
        failures.push(`workspace still exists at ${options.workspacePath}`);
      }
      if (await isGitWorktreeRegistered(options.repoPath, options.workspacePath)) {
        failures.push(`git still lists worktree ${options.workspacePath}`);
      }
    } catch (err: unknown) {
      failures.push(`failed to verify worktree cleanup: ${formatError(err)}`);
    }
  }

  if (options.branch && options.branch !== options.defaultBranch) {
    try {
      if (await gitBranchExists(options.repoPath, options.branch)) {
        failures.push(`local branch ${options.branch} still exists`);
      }
    } catch (err: unknown) {
      failures.push(`failed to verify branch cleanup: ${formatError(err)}`);
    }
  }

  return { ok: failures.length === 0, failures };
}
