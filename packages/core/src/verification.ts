import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  MergeReadiness,
  ProjectConfig,
  Session,
  VerificationFailAction,
  VerificationResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const COMMAND_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;
const OUTPUT_SNIPPET_MAX_CHARS = 4_000;

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000;
export const UNKNOWN_VERIFICATION_HEAD = "__ao_unknown_head__";
export const VERIFICATION_BLOCKER_PREFIX = "Post-push verification:";

interface ExecFileError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export interface VerificationEvaluation {
  currentHead: string | null;
  result: VerificationResult | null;
  needsRun: boolean;
  blockMerge: boolean;
  blockers: string[];
}

export interface VerificationExecution {
  currentHead: string | null;
  result: VerificationResult;
  outputSnippet: string | null;
}

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let regex = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (char === "*") {
      const next = normalized[index + 1];
      const afterNext = normalized[index + 2];

      if (next === "*") {
        if (afterNext === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    regex += escapeRegex(char);
  }

  regex += "$";
  return new RegExp(regex);
}

function getStaticGlobBase(pattern: string): string {
  const normalized = normalizePath(pattern);
  const parts = normalized.split("/");
  const literalParts: string[] = [];

  for (const part of parts) {
    if (/[*?[]/.test(part)) {
      break;
    }
    literalParts.push(part);
  }

  return literalParts.join("/");
}

function walkRelativeFiles(rootPath: string, relativePath: string, results: string[]): void {
  const absolutePath = relativePath ? join(rootPath, relativePath) : rootPath;
  const entries = readdirSync(absolutePath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git") continue;

    const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkRelativeFiles(rootPath, nextRelativePath, results);
      continue;
    }

    if (entry.isFile() || entry.isSymbolicLink()) {
      results.push(normalizePath(nextRelativePath));
    }
  }
}

function listRelativeFilesFrom(rootPath: string, startRelativePath: string): string[] {
  const normalizedStart = normalizePath(startRelativePath);
  const absoluteStart = normalizedStart ? join(rootPath, normalizedStart) : rootPath;
  if (!existsSync(absoluteStart)) return [];

  const stats = statSync(absoluteStart);
  if (!stats.isDirectory()) {
    return [normalizedStart];
  }

  const results: string[] = [];
  walkRelativeFiles(rootPath, normalizedStart, results);
  return results;
}

function dedupeAndSort(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function matchPatterns(paths: string[], patterns: string[]): string[] {
  if (patterns.length === 0) return [];

  const compiledPatterns = patterns.map((pattern) => globToRegExp(pattern));
  return dedupeAndSort(
    paths.filter((path) => compiledPatterns.some((regex) => regex.test(path))),
  );
}

function collectWorkspaceMatches(rootPath: string, patterns: string[]): string[] {
  if (patterns.length === 0) return [];

  const candidates = new Set<string>();
  for (const pattern of patterns) {
    const base = getStaticGlobBase(pattern);
    for (const candidate of listRelativeFilesFrom(rootPath, base)) {
      candidates.add(candidate);
    }
  }

  return matchPatterns([...candidates], patterns);
}

function combineOutput(stdout: string, stderr: string): string | null {
  const sections = [
    stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
    stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
  ].filter(Boolean);

  if (sections.length === 0) return null;

  const combined = sections.join("\n\n");
  if (combined.length <= OUTPUT_SNIPPET_MAX_CHARS) {
    return combined;
  }

  return `${combined.slice(0, OUTPUT_SNIPPET_MAX_CHARS)}\n...[truncated]`;
}

function verificationFailAction(project: ProjectConfig): VerificationFailAction {
  return project.verification?.postPush?.failAction ?? "block-merge";
}

export function computeVerificationSignature(project: ProjectConfig): string | null {
  const postPush = project.verification?.postPush;
  if (!postPush) return null;

  return createHash("sha256")
    .update(
      JSON.stringify({
        command: postPush.command,
        timeout: postPush.timeout ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
        failAction: verificationFailAction(project),
        artifacts: postPush.artifacts ?? [],
        evidenceRequired: project.verification?.evidence?.required ?? false,
        evidencePatterns: project.verification?.evidence?.patterns ?? [],
      }),
    )
    .digest("hex");
}

export function readVerificationResult(
  metadata: Record<string, string>,
): VerificationResult | null {
  const head = metadata["verificationHead"];
  const signature = metadata["verificationSignature"];
  const status = metadata["verificationStatus"];
  const checkedAt = metadata["verificationCheckedAt"];
  const failAction = metadata["verificationFailAction"];

  if (
    !head ||
    !signature ||
    !checkedAt ||
    (status !== "passed" && status !== "failed") ||
    (failAction !== "block-merge" && failAction !== "warn" && failAction !== "notify")
  ) {
    return null;
  }

  const exitCodeRaw = metadata["verificationExitCode"];
  const exitCode =
    exitCodeRaw !== undefined && exitCodeRaw !== ""
      ? Number.parseInt(exitCodeRaw, 10)
      : undefined;

  return {
    head,
    signature,
    status,
    failAction,
    checkedAt,
    blockers: parseJsonArray(metadata["verificationBlockers"]),
    artifacts: parseJsonArray(metadata["verificationArtifacts"]),
    evidence: parseJsonArray(metadata["verificationEvidence"]),
    ...(Number.isFinite(exitCode) ? { exitCode } : {}),
  };
}

export function serializeVerificationResult(
  result: VerificationResult,
): Partial<Record<string, string>> {
  return {
    verificationHead: result.head,
    verificationSignature: result.signature,
    verificationStatus: result.status,
    verificationCheckedAt: result.checkedAt,
    verificationFailAction: result.failAction,
    verificationBlockers: JSON.stringify(result.blockers),
    verificationArtifacts: JSON.stringify(result.artifacts),
    verificationEvidence: JSON.stringify(result.evidence),
    verificationExitCode:
      typeof result.exitCode === "number" ? String(result.exitCode) : "",
  };
}

export async function getWorkspaceHead(workspacePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      timeout: 30_000,
      maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
    });
    const head = stdout.trim();
    return head ? head : null;
  } catch {
    return null;
  }
}

async function listTrackedFilesAtHead(workspacePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
    cwd: workspacePath,
    timeout: 30_000,
    maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
  });

  return stdout
    .split(/\r?\n/u)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
}

function formatMergeBlocker(message: string): string {
  return `${VERIFICATION_BLOCKER_PREFIX} ${message}`;
}

export function isVerificationBlocker(blocker: string): boolean {
  return blocker.startsWith(VERIFICATION_BLOCKER_PREFIX);
}

export async function evaluatePostPushVerification(
  session: Session,
  project: ProjectConfig,
): Promise<VerificationEvaluation | null> {
  const postPush = project.verification?.postPush;
  if (!postPush) {
    return null;
  }

  const failAction = verificationFailAction(project);
  const result = readVerificationResult(session.metadata);
  const signature = computeVerificationSignature(project);

  if (!session.workspacePath) {
    const blockers =
      failAction === "block-merge" ? ["Verification workspace is unavailable"] : [];
    return {
      currentHead: null,
      result,
      needsRun: false,
      blockMerge: failAction === "block-merge",
      blockers,
    };
  }

  const currentHead = await getWorkspaceHead(session.workspacePath);
  if (!currentHead) {
    const blockers =
      failAction === "block-merge"
        ? ["Unable to determine the current worktree HEAD for verification"]
        : [];
    return {
      currentHead: null,
      result,
      needsRun: false,
      blockMerge: failAction === "block-merge",
      blockers,
    };
  }

  const needsRun =
    result === null || result.head !== currentHead || (signature !== null && result.signature !== signature);

  const blockers =
    failAction !== "block-merge"
      ? []
      : needsRun
        ? ["Verification has not run for the current HEAD"]
        : result?.status === "failed"
          ? result.blockers
          : [];

  return {
    currentHead,
    result,
    needsRun,
    blockMerge: failAction === "block-merge" && blockers.length > 0,
    blockers,
  };
}

export function applyVerificationToMergeability(
  mergeability: MergeReadiness,
  evaluation: VerificationEvaluation | null,
): MergeReadiness {
  if (!evaluation || !evaluation.blockMerge) {
    return mergeability;
  }

  return {
    ...mergeability,
    mergeable: false,
    blockers: dedupeAndSort([
      ...mergeability.blockers,
      ...evaluation.blockers.map((blocker) => formatMergeBlocker(blocker)),
    ]),
  };
}

export async function runPostPushVerification(
  session: Session,
  project: ProjectConfig,
): Promise<VerificationExecution | null> {
  const postPush = project.verification?.postPush;
  const signature = computeVerificationSignature(project);
  if (!postPush || !signature) {
    return null;
  }

  const failAction = verificationFailAction(project);
  const checkedAt = new Date().toISOString();
  const currentHead = session.workspacePath ? await getWorkspaceHead(session.workspacePath) : null;
  const head = currentHead ?? UNKNOWN_VERIFICATION_HEAD;
  const blockers: string[] = [];
  let outputSnippet: string | null = null;
  let exitCode: number | undefined;

  if (!session.workspacePath) {
    blockers.push("Verification workspace is unavailable");
    return {
      currentHead,
      outputSnippet,
      result: {
        head,
        signature,
        status: "failed",
        failAction,
        checkedAt,
        blockers,
        artifacts: [],
        evidence: [],
      },
    };
  }

  const shell = process.env["SHELL"] || "/bin/sh";
  const timeoutMs = postPush.timeout ?? DEFAULT_VERIFICATION_TIMEOUT_MS;

  try {
    const { stdout, stderr } = await execFileAsync(shell, ["-lc", postPush.command], {
      cwd: session.workspacePath,
      timeout: timeoutMs,
      maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
    });
    outputSnippet = combineOutput(stdout, stderr);
  } catch (error) {
    const execError = error as ExecFileError;
    const stdout = Buffer.isBuffer(execError.stdout)
      ? execError.stdout.toString("utf-8")
      : (execError.stdout ?? "");
    const stderr = Buffer.isBuffer(execError.stderr)
      ? execError.stderr.toString("utf-8")
      : (execError.stderr ?? "");
    outputSnippet = combineOutput(stdout, stderr);

    if (typeof execError.code === "number") {
      exitCode = execError.code;
    }

    if (/timed out/i.test(execError.message)) {
      blockers.push(`Verification command timed out after ${Math.ceil(timeoutMs / 1000)}s`);
    } else if (typeof execError.code === "number") {
      blockers.push(`Verification command exited with code ${execError.code}`);
    } else {
      blockers.push(`Verification command failed: ${execError.message}`);
    }
  }

  const artifacts = collectWorkspaceMatches(session.workspacePath, postPush.artifacts ?? []);
  let evidence: string[] = [];

  const evidenceRequired = project.verification?.evidence?.required ?? false;
  const evidencePatterns = project.verification?.evidence?.patterns ?? [];

  if (evidenceRequired) {
    if (evidencePatterns.length === 0) {
      blockers.push("Verification evidence is required but no evidence patterns were configured");
    } else {
      try {
        evidence = matchPatterns(await listTrackedFilesAtHead(session.workspacePath), evidencePatterns);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        blockers.push(`Failed to inspect committed verification evidence: ${message}`);
      }

      if (evidence.length === 0) {
        blockers.push(
          `Missing committed verification evidence matching ${evidencePatterns.join(", ")}`,
        );
      }
    }
  }

  return {
    currentHead,
    outputSnippet,
    result: {
      head,
      signature,
      status: blockers.length === 0 ? "passed" : "failed",
      failAction,
      checkedAt,
      blockers,
      artifacts,
      evidence,
      ...(typeof exitCode === "number" ? { exitCode } : {}),
    },
  };
}

export function formatVerificationFailureMessage(
  project: ProjectConfig,
  execution: VerificationExecution,
): string {
  const command = project.verification?.postPush?.command ?? "";
  const shortHead =
    execution.result.head === UNKNOWN_VERIFICATION_HEAD
      ? "unknown"
      : execution.result.head.slice(0, 12);
  const lines = [
    "Post-push verification failed.",
    "",
    `Commit: \`${shortHead}\``,
    `Command: \`${command}\``,
    "",
    "Blockers:",
    ...execution.result.blockers.map((blocker) => `- ${blocker}`),
  ];

  if (execution.result.evidence.length > 0) {
    lines.push("", "Committed evidence:", ...execution.result.evidence.map((path) => `- ${path}`));
  }

  if (execution.result.artifacts.length > 0) {
    lines.push("", "Artifacts:", ...execution.result.artifacts.map((path) => `- ${path}`));
  }

  if (execution.outputSnippet) {
    lines.push("", "Output:", "```text", execution.outputSnippet, "```");
  }

  return lines.join("\n");
}
