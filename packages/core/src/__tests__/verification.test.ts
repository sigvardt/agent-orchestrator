import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyVerificationToMergeability,
  computeVerificationSignature,
  evaluatePostPushVerification,
  runPostPushVerification,
  serializeVerificationResult,
} from "../verification.js";
import type { ProjectConfig, Session } from "../types.js";

const tempDirs: string[] = [];

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function writeRepoFile(repoPath: string, relativePath: string, content: string): void {
  mkdirSync(dirname(join(repoPath, relativePath)), { recursive: true });
  writeFileSync(join(repoPath, relativePath), content);
}

function createCommittedRepo(name: string, files: Record<string, string> = {}): string {
  const repoPath = join(tmpdir(), `ao-verification-${name}-${Date.now()}`);
  tempDirs.push(repoPath);

  mkdirSync(repoPath, { recursive: true });
  runGit(repoPath, "init", "-b", "main");
  runGit(repoPath, "config", "user.email", "ao@example.com");
  runGit(repoPath, "config", "user.name", "AO Test");

  writeRepoFile(repoPath, "README.md", "# verification\n");
  for (const [relativePath, content] of Object.entries(files)) {
    writeRepoFile(repoPath, relativePath, content);
  }

  runGit(repoPath, "add", ".");
  runGit(repoPath, "commit", "-m", "init");
  return repoPath;
}

function makeProject(
  repoPath: string,
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
  return {
    name: "Test",
    repo: "acme/repo",
    path: repoPath,
    defaultBranch: "main",
    sessionPrefix: "app",
    verification: {
      postPush: {
        command: "printf 'verification ok\\n'",
        failAction: "block-merge",
        artifacts: ["reports/verify-*.json"],
      },
      evidence: {
        required: true,
        patterns: ["docs/.verify-evidence-*"],
      },
    },
    ...overrides,
  };
}

function makeSession(
  repoPath: string,
  metadata: Record<string, string> = {},
): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "approved",
    activity: "idle",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: repoPath,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("verification helpers", () => {
  it("captures committed evidence and local artifacts on a passing verification run", async () => {
    const repoPath = createCommittedRepo("passing", {
      "docs/.verify-evidence-live.md": "verified\n",
      "reports/verify-live.json": "{\"ok\":true}\n",
    });
    const project = makeProject(repoPath);

    const execution = await runPostPushVerification(makeSession(repoPath), project);

    expect(execution).not.toBeNull();
    expect(execution?.result.status).toBe("passed");
    expect(execution?.result.blockers).toEqual([]);
    expect(execution?.result.evidence).toEqual(["docs/.verify-evidence-live.md"]);
    expect(execution?.result.artifacts).toEqual(["reports/verify-live.json"]);
    expect(execution?.result.signature).toBe(computeVerificationSignature(project));
  });

  it("requires a rerun when the verification config signature changes", async () => {
    const repoPath = createCommittedRepo("signature", {
      "docs/.verify-evidence-live.md": "verified\n",
    });
    const project = makeProject(repoPath);
    const execution = await runPostPushVerification(makeSession(repoPath), project);
    expect(execution).not.toBeNull();

    const updatedProject = makeProject(repoPath, {
      verification: {
        postPush: {
          command: "printf 'verification changed\\n'",
          failAction: "block-merge",
          artifacts: ["reports/verify-*.json"],
        },
        evidence: {
          required: true,
          patterns: ["docs/.verify-evidence-*"],
        },
      },
    });

    const evaluation = await evaluatePostPushVerification(
      makeSession(repoPath, serializeVerificationResult(execution!.result) as Record<string, string>),
      updatedProject,
    );

    expect(evaluation?.needsRun).toBe(true);
    expect(evaluation?.blockMerge).toBe(true);
    expect(evaluation?.blockers).toContain("Verification has not run for the current HEAD");
  });

  it("adds a merge blocker when a block-merge verification result failed", async () => {
    const repoPath = createCommittedRepo("blocked");
    const project = makeProject(repoPath, {
      verification: {
        postPush: {
          command: "exit 1",
          failAction: "block-merge",
        },
      },
    });
    const execution = await runPostPushVerification(makeSession(repoPath), project);
    expect(execution).not.toBeNull();

    const evaluation = await evaluatePostPushVerification(
      makeSession(repoPath, serializeVerificationResult(execution!.result) as Record<string, string>),
      project,
    );
    const mergeability = applyVerificationToMergeability(
      {
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
      evaluation,
    );

    expect(execution?.result.status).toBe("failed");
    expect(mergeability.mergeable).toBe(false);
    expect(mergeability.blockers).toContain(
      "Post-push verification: Verification command exited with code 1",
    );
  });
});
