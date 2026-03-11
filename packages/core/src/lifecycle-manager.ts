/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SESSION_STATUS,
  PR_STATE,
  CI_STATUS,
  isTerminalSession,
  resolveMergeMethod,
  type CIStatus,
  type LifecycleManager,
  type SessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type EventPriority,
  type SessionKillStep,
  type SessionKillStepResult,
  type ReviewComment,
  type AutomatedComment,
  type ProgressChecksConfig,
  type ProgressCheckSnapshot,
  type ProjectConfig as _ProjectConfig,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { deleteLocalBranch, forceRemoveGitWorktree } from "./session-manager.js";
import {
  applyVerificationToMergeability,
  evaluatePostPushVerification,
  formatVerificationFailureMessage,
  runPostPushVerification,
  serializeVerificationResult,
  type VerificationEvaluation,
  type VerificationExecution,
} from "./verification.js";
import {
  GLOBAL_PAUSE_UNTIL_KEY,
  GLOBAL_PAUSE_REASON_KEY,
  GLOBAL_PAUSE_SOURCE_KEY,
  parsePauseUntil,
} from "./global-pause.js";

const execFileAsync = promisify(execFile);

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 0;
  }
}

function parseRateLimitReset(output: string): Date | null {
  if (!/usage\s+limit\s+reached/i.test(output)) return null;

  const resetMatch = output.match(
    /limit\s+will\s+reset\s+at\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{1,2})/i,
  );
  if (resetMatch) {
    const [year, month, day] = resetMatch[1].split("-").map((part) => Number.parseInt(part, 10));
    const hour = Number.parseInt(resetMatch[2], 10);
    const minute = Number.parseInt(resetMatch[3], 10);
    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day) &&
      Number.isFinite(hour) &&
      Number.isFinite(minute)
    ) {
      const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }

  const durationMatch = output.match(
    /usage\s+limit\s+reached\s+for\s+(\d+)\s*(hour|hours|hr|h|minute|minutes|min|m)/i,
  );
  if (!durationMatch) return null;
  const value = Number.parseInt(durationMatch[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = durationMatch[2].toLowerCase();
  const millis = unit.startsWith("h") ? value * 3_600_000 : value * 60_000;
  return new Date(Date.now() + millis);
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type === "session.completed" || type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed")
  ) {
    return "action";
  }
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
    return "warning";
  }
  return "info";
}

const EVENT_IDEMPOTENCY_BUCKET_MS = 60_000;
const RECENT_EVENT_TTL_MS = 120_000;

interface EventIdempotencySeed {
  transition: string;
  oldStatus?: SessionStatus;
  newStatus?: SessionStatus;
  timestamp?: Date;
}

interface TransitionEventContext {
  idempotencyKey: string;
  transition: EventType;
  oldStatus: SessionStatus;
  newStatus: SessionStatus;
  timestamp: Date;
}

function getIdempotencyBucket(timestamp: Date): number {
  return Math.floor(timestamp.getTime() / EVENT_IDEMPOTENCY_BUCKET_MS);
}

function defaultIdempotencyTransition(type: EventType, data: Record<string, unknown>): string {
  if (Object.keys(data).length === 0) {
    return type;
  }

  return `${type}:${JSON.stringify(data)}`;
}

function createIdempotencyKey(opts: {
  sessionId: SessionId;
  transition: string;
  oldStatus?: SessionStatus;
  newStatus?: SessionStatus;
  timestamp: Date;
}): string {
  return createHash("sha256")
    .update(
      [
        opts.sessionId,
        opts.transition,
        opts.oldStatus ?? "",
        opts.newStatus ?? "",
        String(getIdempotencyBucket(opts.timestamp)),
      ].join(":"),
    )
    .digest("hex");
}

function createTransitionEventContext(
  sessionId: SessionId,
  transition: EventType,
  oldStatus: SessionStatus,
  newStatus: SessionStatus,
  timestamp = new Date(),
): TransitionEventContext {
  return {
    idempotencyKey: createIdempotencyKey({
      sessionId,
      transition,
      oldStatus,
      newStatus,
      timestamp,
    }),
    transition,
    oldStatus,
    newStatus,
    timestamp,
  };
}

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
    idempotencyKey?: string;
    idempotencySeed?: EventIdempotencySeed;
    timestamp?: Date;
  },
): OrchestratorEvent {
  const data = opts.data ?? {};
  const timestamp = opts.timestamp ?? opts.idempotencySeed?.timestamp ?? new Date();
  const transition = opts.idempotencySeed?.transition ?? defaultIdempotencyTransition(type, data);

  return {
    id: randomUUID(),
    idempotencyKey:
      opts.idempotencyKey ??
      createIdempotencyKey({
        sessionId: opts.sessionId,
        transition,
        oldStatus: opts.idempotencySeed?.oldStatus,
        newStatus: opts.idempotencySeed?.newStatus,
        timestamp,
      }),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp,
    message: opts.message,
    data,
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "working":
      return "session.working";
    case "completed":
      return "session.completed";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "idle":
      return "session.idle";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "session.idle":
      return "agent-idle";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "summary.all_complete":
      return "all-complete";
    default:
      return null;
  }
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  /** When set, only poll sessions belonging to this project. */
  projectId?: string;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
  lastReactionFiredAtMs: number;
  escalatedAtMs?: number;
}

interface LifecyclePollStats {
  pollId: string;
  startedAtMs: number;
  totalSessions: number;
  checkedSessions: number;
  activeSessions: number;
  transitions: number;
  errors: number;
  notificationsSent: number;
  notificationFailures: number;
}

type LifecycleLogLevel = "info" | "error";

function serializeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? undefined : serializeLogValue(value.cause);
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...(cause !== undefined ? { cause } : {}),
    };
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function serializeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializeLogValue(value)]),
  );
}

function logLifecycle(
  level: LifecycleLogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      scope: "lifecycle",
      level,
      event,
      ...serializeLogFields(fields),
    }),
  );
}

function incrementPollError(pollStats?: LifecyclePollStats): void {
  if (pollStats) {
    pollStats.errors += 1;
  }
}

function createPollStats(): LifecyclePollStats {
  return {
    pollId: randomUUID(),
    startedAtMs: Date.now(),
    totalSessions: 0,
    checkedSessions: 0,
    activeSessions: 0,
    transitions: 0,
    errors: 0,
    notificationsSent: 0,
    notificationFailures: 0,
  };
}

const GIT_PROGRESS_TIMEOUT_MS = 5_000;
const TMUX_ACTIVITY_TIMEOUT_MS = 5_000;
const PROGRESS_IDLE_THRESHOLD_MS = 60_000;

interface ProgressSignalHistory {
  errorPatterns: Set<string>;
  testCommandsSeen: Set<string>;
  liveCommandsSeen: Set<string>;
  lastOutputFingerprint: string | null;
  lastOutputAtMs: number | null;
}

interface CapturedTerminalOutput {
  text: string;
  truncated: boolean;
}

interface ProgressGitState {
  branch: string | null;
  commitsSinceSpawn: number;
  lastCommitAgeMinutes: number | null;
  dirtyFiles: string[];
  hasPushed: boolean;
}

type ProgressCheckpointKey = "firstCommit" | "firstPR";

interface ProgressCheckpointCandidate {
  key: ProgressCheckpointKey;
  threshold: string;
  thresholdMs: number;
  gitState: ProgressGitState | null;
}

const PROGRESS_CHECKPOINT_REACTION_KEY = "progress-checkpoints";
const PROGRESS_CHECKPOINT_RESET_AT_METADATA_KEY = "progressCheckpointResetAt";
const PROGRESS_CHECKPOINT_MISS_COUNT_METADATA_KEY = "progressCheckpointMissCount";
const PROGRESS_CHECKPOINT_FIRED_AT_METADATA_KEYS: Record<ProgressCheckpointKey, string> = {
  firstCommit: "progressCheckpointFirstCommitFiredAt",
  firstPR: "progressCheckpointFirstPRFiredAt",
};

function createProgressSignalHistory(): ProgressSignalHistory {
  return {
    errorPatterns: new Set<string>(),
    testCommandsSeen: new Set<string>(),
    liveCommandsSeen: new Set<string>(),
    lastOutputFingerprint: null,
    lastOutputAtMs: null,
  };
}

function parseInteger(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function toElapsedSeconds(sinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
}

function toElapsedMinutes(sinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
}

function resolveProgressChecksConfigForProject(
  config: OrchestratorConfig,
  projectId: string,
): ProgressChecksConfig | null {
  const project = config.projects[projectId];
  if (!project) return null;

  const projectOverride = project.progressChecks;
  const resolved: ProgressChecksConfig = {
    enabled: projectOverride?.enabled ?? config.progressChecks.enabled,
    intervalMinutes: projectOverride?.intervalMinutes ?? config.progressChecks.intervalMinutes,
    terminalLines: projectOverride?.terminalLines ?? config.progressChecks.terminalLines,
    notify: projectOverride?.notify ?? config.progressChecks.notify,
    signals: {
      errorPatterns:
        projectOverride?.signals?.errorPatterns ?? config.progressChecks.signals.errorPatterns,
      testPatterns:
        projectOverride?.signals?.testPatterns ?? config.progressChecks.signals.testPatterns,
      livePatterns:
        projectOverride?.signals?.livePatterns ?? config.progressChecks.signals.livePatterns,
    },
  };

  return resolved.enabled ? resolved : null;
}

function normalizeMatchLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function collectPatternMatches(text: string, patterns: string[]): string[] {
  const matches = new Set<string>();

  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, "gim");
      const match = regex.exec(text);
      if (match?.[0]) {
        matches.add(normalizeMatchLabel(match[0], pattern));
      }
      continue;
    } catch {
      // Fall back to literal substring matching below.
    }

    if (text.toLowerCase().includes(pattern.toLowerCase())) {
      matches.add(pattern);
    }
  }

  return [...matches];
}

function parseBudgetRemainingFromTerminal(text: string): number | undefined {
  const patterns = [
    /\b(\d+(?:\.\d+)?)%\s+(?:left|remaining)\b/i,
    /\b(?:left|remaining)\s*[:=]?\s*(\d+(?:\.\d+)?)%/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;

    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) {
      return clampPercent(parsed);
    }
  }

  return undefined;
}

function resolveSnapshotModel(session: Session, project: _ProjectConfig): string | null {
  const configuredModel = project.agentConfig?.model;
  if (typeof configuredModel === "string" && configuredModel.trim()) {
    return configuredModel.trim();
  }

  const summary = session.agentInfo?.summary;
  if (typeof summary !== "string") return null;

  const match = summary.match(/\(([^)]+)\)/);
  return match?.[1]?.trim() || null;
}

async function resolveBudgetRemainingPct(
  agent: Agent | null,
  session: Session,
  terminalOutput: string,
): Promise<number | undefined> {
  if (agent?.getUsageSnapshot) {
    try {
      const usage = await agent.getUsageSnapshot(session);
      if (usage) {
        const remainingDial = usage.dials.find(
          (dial) =>
            dial.status === "available" && dial.kind === "percent_remaining" && dial.value !== null,
        );
        if (remainingDial?.value !== null && remainingDial?.value !== undefined) {
          return clampPercent(remainingDial.value);
        }

        const usedDial = usage.dials.find(
          (dial) =>
            dial.status === "available" && dial.kind === "percent_used" && dial.value !== null,
        );
        if (usedDial?.value !== null && usedDial?.value !== undefined) {
          return clampPercent(100 - usedDial.value);
        }
      }
    } catch {
      // Fall back to terminal parsing below.
    }
  }

  return parseBudgetRemainingFromTerminal(terminalOutput);
}

async function captureTerminalOutput(
  runtime: Runtime | null,
  handle: Session["runtimeHandle"],
  lines: number,
): Promise<CapturedTerminalOutput> {
  if (!runtime || !handle) {
    return { text: "", truncated: false };
  }

  try {
    const output = await runtime.getOutput(handle, lines + 1);
    const rawLines = output === "" ? [] : output.split("\n");
    const truncated = rawLines.length > lines;
    const visibleLines = truncated ? rawLines.slice(-lines) : rawLines;
    return {
      text: visibleLines.join("\n"),
      truncated,
    };
  } catch {
    return { text: "", truncated: false };
  }
}

async function runGitProgressCommand(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_PROGRESS_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

function parseDirtyFiles(output: string | null): string[] {
  if (!output) return [];

  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3).trim();
      const renamed = path.includes(" -> ") ? (path.split(" -> ").at(-1) ?? path) : path;
      return renamed;
    });
}

async function collectGitState(session: Session, nowMs: number): Promise<ProgressGitState> {
  const workspacePath = session.workspacePath;
  if (!workspacePath) {
    return {
      branch: session.branch,
      commitsSinceSpawn: 0,
      lastCommitAgeMinutes: null,
      dirtyFiles: [],
      hasPushed: Boolean(session.pr),
    };
  }

  const createdAtIso = session.createdAt.toISOString();
  const [branchOutput, commitCountOutput, lastCommitOutput, dirtyOutput, upstreamOutput] =
    await Promise.all([
      runGitProgressCommand(["branch", "--show-current"], workspacePath),
      runGitProgressCommand(
        ["rev-list", "--count", `--since=${createdAtIso}`, "HEAD"],
        workspacePath,
      ),
      runGitProgressCommand(["log", "-1", "--format=%ct"], workspacePath),
      runGitProgressCommand(["status", "--porcelain", "--untracked-files=all"], workspacePath),
      runGitProgressCommand(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        workspacePath,
      ),
    ]);

  const lastCommitSeconds = lastCommitOutput ? Number.parseInt(lastCommitOutput, 10) : Number.NaN;

  return {
    branch: branchOutput?.trim() || session.branch,
    commitsSinceSpawn: commitCountOutput
      ? Math.max(0, Number.parseInt(commitCountOutput, 10) || 0)
      : 0,
    lastCommitAgeMinutes: Number.isFinite(lastCommitSeconds)
      ? toElapsedMinutes(lastCommitSeconds * 1000, nowMs)
      : null,
    dirtyFiles: parseDirtyFiles(dirtyOutput),
    hasPushed: Boolean(upstreamOutput?.trim()) || Boolean(session.pr),
  };
}

async function getLastOutputAtMs(session: Session): Promise<number | null> {
  if (!session.runtimeHandle || session.runtimeHandle.runtimeName !== "tmux") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["display-message", "-t", session.runtimeHandle.id, "-p", "#{session_activity}"],
      { timeout: TMUX_ACTIVITY_TIMEOUT_MS },
    );
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed * 1000 : null;
  } catch {
    return null;
  }
}

function createProgressSnapshotIdempotencyKey(
  sessionId: SessionId,
  snapshotNumber: number,
): string {
  return createHash("sha256")
    .update([sessionId, "progress-check", String(snapshotNumber)].join(":"))
    .digest("hex");
}

function createProgressCheckpointIdempotencyKey(
  sessionId: SessionId,
  checkpointKey: ProgressCheckpointKey,
): string {
  return createHash("sha256")
    .update([sessionId, "progress-checkpoint", checkpointKey].join(":"))
    .digest("hex");
}

const OPEN_PR_STATUS_POLL_INTERVAL_MS = 60_000;
const WAITING_CI_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CI_REACTION_REFIRE_INTERVAL_MS = 120_000;
const DEFAULT_REACTION_REFIRE_INTERVAL_MS = 300_000;
const MAX_ORPHAN_RECOVERY_ATTEMPTS = 3;

interface OpenPREvaluation {
  status: SessionStatus;
  ciStatus: CIStatus;
}

interface OrphanRecoveryAction {
  reactionKey: "ci-failed" | "changes-requested" | "bugbot-comments";
  reactionConfig: ReactionConfig;
  baseMessage: string;
  trigger: string;
  pendingComments?: ReviewComment[];
  automatedComments?: AutomatedComment[];
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOpenPRStatusPollDue(session: Session): boolean {
  const lastPollAtMs = parseTimestampMs(session.metadata["lastPrStatusPollAt"]);
  if (lastPollAtMs === null) return true;
  return Date.now() - lastPollAtMs >= OPEN_PR_STATUS_POLL_INTERVAL_MS;
}

function isWaitingForCiVerdict(ciStatus: CIStatus): boolean {
  return ciStatus === CI_STATUS.NONE || ciStatus === CI_STATUS.PENDING;
}

function shouldKeepPollingExitedPRSession(
  session: Session,
  currentStatus: SessionStatus,
  allowPrAutoDetect: boolean,
): boolean {
  if (!session.pr) {
    return (
      allowPrAutoDetect &&
      (currentStatus === SESSION_STATUS.WORKING || currentStatus === SESSION_STATUS.DONE)
    );
  }

  switch (currentStatus) {
    case SESSION_STATUS.WORKING:
    case SESSION_STATUS.PR_OPEN:
    case SESSION_STATUS.WAITING_CI:
    case SESSION_STATUS.CI_FAILED:
    case SESSION_STATUS.REVIEW_PENDING:
    case SESSION_STATUS.CHANGES_REQUESTED:
    case SESSION_STATUS.APPROVED:
    case SESSION_STATUS.MERGEABLE:
      return true;
    default:
      return false;
  }
}

function isWaitingCiTimedOut(session: Session): boolean {
  const waitingCiSinceMs = parseTimestampMs(session.metadata["waitingCiSince"]);
  if (waitingCiSinceMs === null) {
    return false;
  }

  return Date.now() - waitingCiSinceMs >= WAITING_CI_TIMEOUT_MS;
}

function shouldOverridePreservedPRStatus(status: SessionStatus): boolean {
  return (
    status === SESSION_STATUS.MERGED ||
    status === SESSION_STATUS.KILLED ||
    status === SESSION_STATUS.CI_FAILED ||
    status === SESSION_STATUS.CHANGES_REQUESTED ||
    status === SESSION_STATUS.MERGEABLE
  );
}

function isOrphanRecoveryCandidate(session: Session, status = session.status): boolean {
  return (
    session.pr !== null &&
    status !== SESSION_STATUS.MERGED &&
    isTerminalSession({ status, activity: session.activity })
  );
}

function parseMetadataCount(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getOrphanRecoveryRootSessionId(session: Session): string {
  return session.metadata["orphanRecoveryRootSessionId"] ?? session.id;
}

function formatCommentLocation(path?: string, line?: number): string {
  if (!path) return "(location unavailable)";
  if (typeof line === "number") {
    return `${path}:${line}`;
  }
  return path;
}

function summarizeReviewComments(comments: ReviewComment[]): string[] {
  const visibleComments = comments.slice(0, 5).map((comment) => {
    const body = comment.body.replace(/\s+/g, " ").trim();
    return `- ${formatCommentLocation(comment.path, comment.line)}: ${body} (${comment.url})`;
  });

  if (comments.length > visibleComments.length) {
    visibleComments.push(`- ...and ${comments.length - visibleComments.length} more comment(s)`);
  }

  return visibleComments;
}

function summarizeAutomatedComments(comments: AutomatedComment[]): string[] {
  const visibleComments = comments.slice(0, 5).map((comment) => {
    const body = comment.body.replace(/\s+/g, " ").trim();
    return `- [${comment.severity}] ${formatCommentLocation(comment.path, comment.line)}: ${body} (${comment.url})`;
  });

  if (comments.length > visibleComments.length) {
    visibleComments.push(
      `- ...and ${comments.length - visibleComments.length} more automated finding(s)`,
    );
  }

  return visibleComments;
}

function getPersistentReactionKey(status: SessionStatus): string | null {
  switch (status) {
    case SESSION_STATUS.CI_FAILED:
      return "ci-failed";
    case SESSION_STATUS.CHANGES_REQUESTED:
      return "changes-requested";
    case SESSION_STATUS.STUCK:
      return "agent-stuck";
    default:
      return null;
  }
}

function getReactionRefireIntervalMs(reactionKey: string, reactionConfig: ReactionConfig): number {
  if (typeof reactionConfig.refireIntervalMs === "number") {
    return reactionConfig.refireIntervalMs;
  }

  if (reactionKey === "ci-failed") {
    return DEFAULT_CI_REACTION_REFIRE_INTERVAL_MS;
  }

  return DEFAULT_REACTION_REFIRE_INTERVAL_MS;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upsertKillStep(
  steps: Map<SessionKillStep, SessionKillStepResult>,
  result: SessionKillStepResult,
): void {
  steps.set(result.step, result);
}

function listKillSteps(
  steps: Map<SessionKillStep, SessionKillStepResult>,
): SessionKillStepResult[] {
  return [...steps.values()];
}

function isSessionCleanupComplete(steps: Map<SessionKillStep, SessionKillStepResult>): boolean {
  const metadata = steps.get("metadata");
  if (!metadata || metadata.status !== "success") {
    return false;
  }

  return !listKillSteps(steps).some(
    (step) => step.status === "failed" && step.step !== "runtime" && step.step !== "opencode",
  );
}

function buildStatusMetadataUpdates(
  session: Session,
  fromStatus: SessionStatus | undefined,
  toStatus: SessionStatus,
): Partial<Record<string, string>> {
  const updates: Partial<Record<string, string>> = { status: toStatus };

  if (toStatus === SESSION_STATUS.WAITING_CI) {
    updates["waitingCiSince"] = session.metadata["waitingCiSince"] ?? new Date().toISOString();
    updates["waitingCiTimedOutAt"] = "";
    return updates;
  }

  if (fromStatus === SESSION_STATUS.WAITING_CI) {
    updates["waitingCiSince"] = "";
    updates["waitingCiTimedOutAt"] =
      toStatus === SESSION_STATUS.DONE ? new Date().toISOString() : "";
    return updates;
  }

  if (toStatus !== SESSION_STATUS.DONE && session.metadata["waitingCiTimedOutAt"]) {
    updates["waitingCiTimedOutAt"] = "";
  }

  return updates;
}

const INACTIVE_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  SESSION_STATUS.KILLED,
  SESSION_STATUS.DONE,
  SESSION_STATUS.MERGED,
  SESSION_STATUS.TERMINATED,
  SESSION_STATUS.CLEANUP,
]);

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, projectId: scopedProjectId } = deps;

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  const progressSignalHistory = new Map<SessionId, ProgressSignalHistory>();
  const recentEventIdempotencyKeys = new Map<string, number>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  function pruneRecentEventIdempotencyKeys(nowMs = Date.now()): void {
    for (const [key, expiresAtMs] of recentEventIdempotencyKeys.entries()) {
      if (expiresAtMs <= nowMs) {
        recentEventIdempotencyKeys.delete(key);
      }
    }
  }

  function getOrCreateReactionTracker(sessionId: SessionId, reactionKey: string): ReactionTracker {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = {
        attempts: 0,
        firstTriggered: new Date(),
        lastReactionFiredAtMs: 0,
      };
      reactionTrackers.set(trackerKey, tracker);
    }

    return tracker;
  }

  async function buildSendToAgentMessage(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    pollStats?: LifecyclePollStats,
    session?: Session,
  ): Promise<string | null> {
    if (reactionConfig.message) {
      return reactionConfig.message;
    }

    if (reactionKey !== "ci-failed") {
      return null;
    }

    const fallbackMessage =
      "CI has failed on your PR. Please check the CI logs, fix the issue, and push.";
    const currentSession = session ?? (await sessionManager.get(sessionId));

    if (!currentSession?.pr) {
      return fallbackMessage;
    }

    const project = config.projects[currentSession.projectId] ?? config.projects[projectId];
    if (!project?.scm) {
      return fallbackMessage;
    }

    const scm = registry.get<SCM>("scm", project.scm.plugin);
    if (!scm?.getCIFailureLogs) {
      return fallbackMessage;
    }

    try {
      const logs = await scm.getCIFailureLogs(currentSession.pr);
      if (!logs) {
        return fallbackMessage;
      }

      return `CI failed on your PR. Here are the failure logs:\n\n${logs}\n\nPlease fix the failing test(s) and push.`;
    } catch (error) {
      incrementPollError(pollStats);
      logLifecycle("error", "reaction.ci_logs.failed", {
        pollId: pollStats?.pollId,
        projectId: currentSession.projectId,
        sessionId,
        reactionKey,
        pr: currentSession.pr,
        error,
      });
      return fallbackMessage;
    }
  }

  function resolveProgressCheckpointBaseAtMs(session: Session): number {
    const resetAtMs = parseTimestampMs(session.metadata[PROGRESS_CHECKPOINT_RESET_AT_METADATA_KEY]);
    if (resetAtMs === null) {
      return session.createdAt.getTime();
    }

    return Math.max(session.createdAt.getTime(), resetAtMs);
  }

  function resolveProgressCheckpointPriority(
    priority: EventPriority | undefined,
    missCount: number,
  ): EventPriority {
    if (missCount >= 2) {
      return "urgent";
    }

    return priority ?? "warning";
  }

  function buildProgressCheckpointNotificationMessage(
    session: Session,
    checkpoint: ProgressCheckpointCandidate,
  ): string {
    switch (checkpoint.key) {
      case "firstCommit":
        return `${session.id}: missed firstCommit checkpoint after ${checkpoint.threshold} without any commits`;
      case "firstPR":
        return `${session.id}: missed firstPR checkpoint after ${checkpoint.threshold} without opening a PR`;
      default:
        return `${session.id}: missed progress checkpoint`;
    }
  }

  function buildProgressCheckpointAgentMessage(
    reactionConfig: ReactionConfig,
    checkpoint: ProgressCheckpointCandidate,
  ): string {
    const configuredMessage = reactionConfig.checkpointMessage ?? reactionConfig.message;
    if (configuredMessage) {
      return configuredMessage;
    }

    switch (checkpoint.key) {
      case "firstCommit":
        return `You've been working for ${checkpoint.threshold} without making any commits. Please commit your current progress, push it, and open a draft PR if the work is ready for review.`;
      case "firstPR":
        return `You've been working for ${checkpoint.threshold} without opening a PR. Please push your current progress and open a draft PR now.`;
      default:
        return "Please push your current progress and open a draft PR.";
    }
  }

  function buildOrphanRecoveryPrompt(
    session: Session,
    action: OrphanRecoveryAction,
    recoveryAttempt: number,
  ): string {
    if (!session.pr) {
      return action.baseMessage;
    }

    const previousSummary = (session.agentInfo?.summary ?? session.metadata["summary"] ?? "")
      .replace(/\s+/g, " ")
      .trim();

    const lines = [
      "You are taking over an orphaned PR because the previous Syntese session exited unexpectedly.",
      `Previous session: ${session.id}`,
      `Recovery attempt: ${recoveryAttempt}`,
      `Trigger: ${action.trigger}`,
      `PR: #${session.pr.number} ${session.pr.url}`,
      `Branch: ${session.pr.branch || session.branch || "(unknown)"}`,
      session.issueId ? `Issue: ${session.issueId}` : null,
      previousSummary ? `Previous summary: ${previousSummary}` : null,
    ].filter((line): line is string => Boolean(line));

    if (action.pendingComments && action.pendingComments.length > 0) {
      lines.push("", "Pending review comments:");
      lines.push(...summarizeReviewComments(action.pendingComments));
    }

    if (action.automatedComments && action.automatedComments.length > 0) {
      lines.push("", "Automated review findings:");
      lines.push(...summarizeAutomatedComments(action.automatedComments));
    }

    lines.push("", action.baseMessage);
    return lines.join("\n");
  }

  async function selectOrphanRecoveryAction(
    session: Session,
    scm: SCM,
    pollStats?: LifecyclePollStats,
  ): Promise<OrphanRecoveryAction | null> {
    if (!session.pr) {
      return null;
    }

    const prState = await scm.getPRState(session.pr);
    if (prState !== PR_STATE.OPEN) {
      return null;
    }

    const ciReactionConfig = getSendToAgentRecoveryConfig(session, "ci-failed");
    if (ciReactionConfig) {
      const ciStatus = await scm.getCISummary(session.pr);
      if (ciStatus === CI_STATUS.FAILING) {
        const baseMessage = await buildSendToAgentMessage(
          session.id,
          session.projectId,
          "ci-failed",
          ciReactionConfig,
          pollStats,
          session,
        );
        if (baseMessage) {
          return {
            reactionKey: "ci-failed",
            reactionConfig: ciReactionConfig,
            baseMessage,
            trigger: "CI failed on the PR after the previous session exited.",
          };
        }
      }
    }

    const reviewReactionConfig = getSendToAgentRecoveryConfig(session, "changes-requested");
    if (reviewReactionConfig) {
      const pendingComments = await scm.getPendingComments(session.pr);
      if (pendingComments.length > 0) {
        const baseMessage = await buildSendToAgentMessage(
          session.id,
          session.projectId,
          "changes-requested",
          reviewReactionConfig,
          pollStats,
          session,
        );
        if (baseMessage) {
          return {
            reactionKey: "changes-requested",
            reactionConfig: reviewReactionConfig,
            baseMessage,
            trigger: "Unresolved human review comments were found on the orphaned PR.",
            pendingComments,
          };
        }
      }

      const reviewDecision = await scm.getReviewDecision(session.pr);
      if (reviewDecision === "changes_requested") {
        const baseMessage = await buildSendToAgentMessage(
          session.id,
          session.projectId,
          "changes-requested",
          reviewReactionConfig,
          pollStats,
          session,
        );
        if (baseMessage) {
          return {
            reactionKey: "changes-requested",
            reactionConfig: reviewReactionConfig,
            baseMessage,
            trigger: "Changes were requested on the PR after the previous session exited.",
          };
        }
      }
    }

    const automatedReactionConfig = getSendToAgentRecoveryConfig(session, "bugbot-comments");
    if (automatedReactionConfig) {
      const automatedComments = await scm.getAutomatedComments(session.pr);
      if (automatedComments.length > 0) {
        const baseMessage = await buildSendToAgentMessage(
          session.id,
          session.projectId,
          "bugbot-comments",
          automatedReactionConfig,
          pollStats,
          session,
        );
        if (baseMessage) {
          return {
            reactionKey: "bugbot-comments",
            reactionConfig: automatedReactionConfig,
            baseMessage,
            trigger: "Automated review findings were posted after the previous session exited.",
            automatedComments,
          };
        }
      }
    }

    return null;
  }

  async function maybeRecoverOrphanedPR(
    session: Session,
    status: SessionStatus,
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    if (!isOrphanRecoveryCandidate(session, status) || !session.pr) {
      return;
    }
    const project = config.projects[session.projectId];
    if (!project?.scm) {
      return;
    }

    const scm = registry.get<SCM>("scm", project.scm.plugin);
    if (!scm) {
      return;
    }

    const action = await selectOrphanRecoveryAction(session, scm, pollStats);
    if (!action) {
      return;
    }

    const attemptCount = parseMetadataCount(session.metadata["orphanRecoveryAttemptCount"]);
    const refireIntervalMs = getReactionRefireIntervalMs(action.reactionKey, action.reactionConfig);
    const lastAttemptAtMs = parseTimestampMs(session.metadata["orphanRecoveryLastAttemptAt"]);
    if (lastAttemptAtMs !== null && Date.now() - lastAttemptAtMs < refireIntervalMs) {
      return;
    }

    if (attemptCount >= MAX_ORPHAN_RECOVERY_ATTEMPTS) {
      if (!session.metadata["orphanRecoveryEscalatedAt"]) {
        const escalatedAt = new Date().toISOString();
        updateSessionMetadata(session, {
          orphanRecoveryEscalatedAt: escalatedAt,
        });
        const event = createEvent("reaction.escalated", {
          sessionId: session.id,
          projectId: session.projectId,
          priority: "urgent",
          message: `Orphan PR recovery hit the retry limit for PR #${session.pr.number}`,
          data: {
            reactionKey: action.reactionKey,
            prNumber: session.pr.number,
            prUrl: session.pr.url,
            attempts: attemptCount,
            maxAttempts: MAX_ORPHAN_RECOVERY_ATTEMPTS,
          },
        });
        await notifyHuman(event, "urgent", pollStats);
      }
      return;
    }

    const nextAttempt = attemptCount + 1;
    const nowIso = new Date().toISOString();
    const orphanRecoveryRootSessionId = getOrphanRecoveryRootSessionId(session);
    updateSessionMetadata(session, {
      orphanRecoveryAttemptCount: String(nextAttempt),
      orphanRecoveryLastAttemptAt: nowIso,
      orphanRecoveryLastReactionKey: action.reactionKey,
      orphanRecoveryRootSessionId,
      orphanRecoveryEscalatedAt: "",
    });

    const recoveryPrompt = buildOrphanRecoveryPrompt(session, action, nextAttempt);
    const recoveryBranch = session.branch ?? session.pr.branch;
    if (!recoveryBranch) {
      return;
    }

    const recoveryAgent = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
    let recoverySession: Session | null = null;
    let prClaimed = false;

    logLifecycle("info", "orphan_recovery.started", {
      pollId: pollStats?.pollId,
      projectId: session.projectId,
      sessionId: session.id,
      reactionKey: action.reactionKey,
      prNumber: session.pr.number,
      recoveryAttempt: nextAttempt,
      branch: recoveryBranch,
    });

    try {
      recoverySession = await sessionManager.spawn({
        projectId: session.projectId,
        issueId: session.issueId ?? undefined,
        branch: recoveryBranch,
        agent: recoveryAgent,
      });

      const claimResult = await sessionManager.claimPR(
        recoverySession.id,
        String(session.pr.number),
        {
          takeover: true,
        },
      );
      prClaimed = true;

      session.pr = null;
      updateSessionMetadata(session, {
        pr: "",
        prAutoDetect: "off",
        replacedBy: recoverySession.id,
        replacedAt: nowIso,
      });

      recoverySession.pr = claimResult.pr;
      recoverySession.branch = claimResult.pr.branch;
      updateSessionMetadata(recoverySession, {
        supersedes: session.id,
        handoffReason: "orphan-pr-recovery",
        handoffAt: nowIso,
        orphanRecoveryAttemptCount: String(nextAttempt),
        orphanRecoveryLastAttemptAt: nowIso,
        orphanRecoveryLastReactionKey: action.reactionKey,
        orphanRecoveryRootSessionId,
        orphanRecoveryEscalatedAt: "",
      });

      await sessionManager.send(recoverySession.id, recoveryPrompt);

      const event = createEvent("reaction.triggered", {
        sessionId: recoverySession.id,
        projectId: session.projectId,
        priority: "action",
        message: `Spawned recovery session ${recoverySession.id} for orphaned PR #${claimResult.pr.number}`,
        data: {
          reactionKey: action.reactionKey,
          orphanedSessionId: session.id,
          recoverySessionId: recoverySession.id,
          prNumber: claimResult.pr.number,
          prUrl: claimResult.pr.url,
          recoveryAttempt: nextAttempt,
        },
      });
      await notifyHuman(event, "action", pollStats);

      logLifecycle("info", "orphan_recovery.completed", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        recoverySessionId: recoverySession.id,
        reactionKey: action.reactionKey,
        prNumber: claimResult.pr.number,
        recoveryAttempt: nextAttempt,
      });
    } catch (error) {
      incrementPollError(pollStats);
      logLifecycle("error", "orphan_recovery.failed", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        recoverySessionId: recoverySession?.id,
        reactionKey: action.reactionKey,
        prNumber: session.pr?.number,
        recoveryAttempt: nextAttempt,
        error,
      });

      if (recoverySession && !prClaimed) {
        try {
          await sessionManager.kill(recoverySession.id);
        } catch (cleanupError) {
          incrementPollError(pollStats);
          logLifecycle("error", "orphan_recovery.cleanup_failed", {
            pollId: pollStats?.pollId,
            projectId: session.projectId,
            sessionId: session.id,
            recoverySessionId: recoverySession.id,
            error: cleanupError,
          });
        }
      }
    }
  }

  function isOrchestratorSession(session: Session): boolean {
    return session.metadata["role"] === "orchestrator" || session.id.endsWith("-orchestrator");
  }

  function setProjectPause(project: _ProjectConfig, sourceSessionId: string, until: Date): void {
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const orchestratorId = `${project.sessionPrefix}-orchestrator`;
    const message = `Model rate limit detected from ${sourceSessionId}`;
    updateMetadata(sessionsDir, orchestratorId, {
      [GLOBAL_PAUSE_UNTIL_KEY]: until.toISOString(),
      [GLOBAL_PAUSE_REASON_KEY]: message,
      [GLOBAL_PAUSE_SOURCE_KEY]: sourceSessionId,
    });
  }

  function clearProjectPause(project: _ProjectConfig): void {
    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const orchestratorId = `${project.sessionPrefix}-orchestrator`;
    updateMetadata(sessionsDir, orchestratorId, {
      [GLOBAL_PAUSE_UNTIL_KEY]: "",
      [GLOBAL_PAUSE_REASON_KEY]: "",
      [GLOBAL_PAUSE_SOURCE_KEY]: "",
    });
  }

  async function detectAndApplyRateLimitPause(
    session: Session,
    project: _ProjectConfig,
    runtime: Runtime,
  ): Promise<void> {
    if (!session.runtimeHandle) return;
    try {
      const output = await runtime.getOutput(session.runtimeHandle, 60);
      if (!output) return;
      const resetAt = parseRateLimitReset(output);
      if (!resetAt) return;
      if (resetAt.getTime() <= Date.now()) return;

      const orchestratorId = `${project.sessionPrefix}-orchestrator`;
      const orchestratorSession = await sessionManager.get(orchestratorId);
      if (orchestratorSession) {
        const existingUntil = parsePauseUntil(orchestratorSession.metadata[GLOBAL_PAUSE_UNTIL_KEY]);
        const existingSource = orchestratorSession.metadata[GLOBAL_PAUSE_SOURCE_KEY];

        if (
          existingUntil &&
          existingUntil.getTime() > Date.now() &&
          existingSource === session.id
        ) {
          return;
        }

        if (
          existingUntil &&
          existingUntil.getTime() > Date.now() &&
          existingUntil.getTime() >= resetAt.getTime()
        ) {
          return;
        }
      }

      setProjectPause(project, session.id, resetAt);
    } catch {
      return;
    }
  }

  async function maybeRefirePersistentReaction(
    session: Session,
    status: SessionStatus,
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    const reactionKey = getPersistentReactionKey(status);
    if (!reactionKey) {
      return;
    }

    const reactionConfig = getReactionConfigForSession(session, reactionKey);
    if (!reactionConfig?.action) {
      return;
    }

    if (reactionConfig.auto === false && reactionConfig.action !== "notify") {
      return;
    }

    const tracker = reactionTrackers.get(`${session.id}:${reactionKey}`);
    if (!tracker || tracker.escalatedAtMs !== undefined) {
      return;
    }

    const refireIntervalMs = getReactionRefireIntervalMs(reactionKey, reactionConfig);
    if (Date.now() - tracker.lastReactionFiredAtMs < refireIntervalMs) {
      return;
    }

    await executeReaction(
      session.id,
      session.projectId,
      reactionKey,
      reactionConfig,
      pollStats,
      session,
    );
  }

  async function notifyVerificationFailure(
    session: Session,
    execution: VerificationExecution,
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project) return;

    const message = `Post-push verification failed for ${session.id}`;
    const event = createEvent("verification.failed", {
      sessionId: session.id,
      projectId: session.projectId,
      message,
      data: {
        prNumber: session.pr?.number,
        prUrl: session.pr?.url,
        head: execution.result.head,
        blockers: execution.result.blockers,
        artifacts: execution.result.artifacts,
        evidence: execution.result.evidence,
        failAction: execution.result.failAction,
      },
    });
    await notifyHuman(event, "warning", pollStats);
  }

  async function handleVerificationFailureAction(
    session: Session,
    execution: VerificationExecution,
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    if (execution.result.status !== "failed") {
      return;
    }

    const project = config.projects[session.projectId];
    if (!project) {
      return;
    }

    if (execution.result.failAction === "notify") {
      await notifyVerificationFailure(session, execution, pollStats);
      return;
    }

    if (execution.result.failAction !== "warn") {
      return;
    }

    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    const commentBody = formatVerificationFailureMessage(project, execution);

    if (!session.pr || !scm?.commentPR) {
      incrementPollError(pollStats);
      logLifecycle("error", "verification.warn.unavailable", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        hasPR: Boolean(session.pr),
        hasCommentSupport: Boolean(scm?.commentPR),
      });
      await notifyVerificationFailure(session, execution, pollStats);
      return;
    }

    try {
      await scm.commentPR(session.pr, commentBody);
      logLifecycle("info", "verification.warn.commented", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        prNumber: session.pr.number,
      });
    } catch (error) {
      incrementPollError(pollStats);
      logLifecycle("error", "verification.warn.comment_failed", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        prNumber: session.pr.number,
        error,
      });
      await notifyVerificationFailure(session, execution, pollStats);
    }
  }

  function getAgentStuckReactionConfig(session: Session): ReactionConfig | null {
    return getReactionConfigForSession(session, "agent-stuck");
  }

  /** Check if idle time exceeds the agent-stuck threshold. */
  function isIdleBeyondThreshold(session: Session, idleTimestamp: Date): boolean {
    const thresholdStr = getAgentStuckReactionConfig(session)?.threshold;
    if (typeof thresholdStr !== "string") return false;
    const stuckThresholdMs = parseDuration(thresholdStr);
    if (stuckThresholdMs <= 0) return false;
    const idleMs = Date.now() - idleTimestamp.getTime();
    return idleMs > stuckThresholdMs;
  }

  /** Check if session age exceeds the agent-stuck max runtime without a PR. */
  function isBeyondMaxRuntime(session: Session): boolean {
    const maxRuntimeStr = getAgentStuckReactionConfig(session)?.maxRuntime;
    if (typeof maxRuntimeStr !== "string") return false;
    const maxRuntimeMs = parseDuration(maxRuntimeStr);
    if (maxRuntimeMs <= 0) return false;

    const createdAtMs = session.createdAt.getTime();
    if (!Number.isFinite(createdAtMs)) return false;

    return Date.now() - createdAtMs > maxRuntimeMs;
  }

  async function evaluateOpenPR(
    session: Session,
    scm: SCM,
    verificationEvaluation?: VerificationEvaluation | null,
  ): Promise<OpenPREvaluation> {
    if (!session.pr) {
      return {
        status: SESSION_STATUS.WORKING,
        ciStatus: CI_STATUS.NONE,
      };
    }

    const prState = await scm.getPRState(session.pr);
    if (prState === PR_STATE.MERGED) {
      return {
        status: SESSION_STATUS.MERGED,
        ciStatus: CI_STATUS.NONE,
      };
    }
    if (prState === PR_STATE.CLOSED) {
      return {
        status: SESSION_STATUS.KILLED,
        ciStatus: CI_STATUS.NONE,
      };
    }

    const ciStatus = await scm.getCISummary(session.pr);
    if (ciStatus === CI_STATUS.FAILING) {
      return {
        status: SESSION_STATUS.CI_FAILED,
        ciStatus,
      };
    }

    const reviewDecision = await scm.getReviewDecision(session.pr);
    if (reviewDecision === "changes_requested") {
      return {
        status: SESSION_STATUS.CHANGES_REQUESTED,
        ciStatus,
      };
    }

    if (reviewDecision === "approved" || reviewDecision === "none") {
      const mergeReady = applyVerificationToMergeability(
        await scm.getMergeability(session.pr),
        verificationEvaluation ?? null,
      );
      if (mergeReady.mergeable) {
        return {
          status: SESSION_STATUS.MERGEABLE,
          ciStatus,
        };
      }

      if (reviewDecision === "approved") {
        return {
          status: SESSION_STATUS.APPROVED,
          ciStatus,
        };
      }
    }

    if (reviewDecision === "pending") {
      return {
        status: SESSION_STATUS.REVIEW_PENDING,
        ciStatus,
      };
    }

    return {
      status: SESSION_STATUS.PR_OPEN,
      ciStatus,
    };
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(
    session: Session,
    currentStatus: SessionStatus,
    pollStats?: LifecyclePollStats,
  ): Promise<SessionStatus> {
    if (
      currentStatus === SESSION_STATUS.DONE &&
      typeof session.metadata["waitingCiTimedOutAt"] === "string"
    ) {
      return SESSION_STATUS.DONE;
    }

    const project = config.projects[session.projectId];
    if (!project) return currentStatus;

    const agentName = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    const scmPlugin = project.scm?.plugin ?? "unknown";
    const allowPrAutoDetect =
      scm !== null && Boolean(session.branch) && session.metadata["prAutoDetect"] !== "off";

    // Track activity state across steps so stuck detection can run after PR checks
    let detectedIdleTimestamp: Date | null = null;
    let detectedCompletionState: "ready" | "idle" | null = null;
    let preserveCurrentStatus = false;
    let agentExitedWithOpenPR = false;
    let retryExitedSessionAfterPrLookupError = false;

    const runtime = session.runtimeHandle
      ? registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime)
      : null;

    // 1. Check if runtime is alive
    if (session.runtimeHandle && runtime) {
      const alive = await runtime.isAlive(session.runtimeHandle).catch((error: unknown) => {
        incrementPollError(pollStats);
        logLifecycle("error", "runtime.health_check.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          runtimeName: project.runtime ?? config.defaults.runtime,
          error,
        });
        return true;
      });
      if (!alive) {
        if (shouldKeepPollingExitedPRSession(session, currentStatus, allowPrAutoDetect)) {
          agentExitedWithOpenPR = true;
        } else {
          return "killed";
        }
      }

      await detectAndApplyRateLimitPause(session, project, runtime);
    }

    // 2. Check agent activity — prefer JSONL-based detection (runtime-agnostic)
    if (agent && session.runtimeHandle) {
      try {
        // Try JSONL-based activity detection first (reads agent's session files directly)
        const activityState = await agent.getActivityState(session, config.readyThresholdMs);
        if (activityState) {
          if (activityState.state === "waiting_input") return "needs_input";
          if (activityState.state === "exited") {
            if (shouldKeepPollingExitedPRSession(session, currentStatus, allowPrAutoDetect)) {
              agentExitedWithOpenPR = true;
            } else {
              return "killed";
            }
          }

          if (activityState.state === "ready" || activityState.state === "idle") {
            detectedCompletionState = activityState.state;
          }

          // Stuck/completion detection runs after PR auto-detection so sessions
          // with branch-backed PRs can still be promoted into PR states first.
          if (
            (activityState.state === "idle" || activityState.state === "blocked") &&
            activityState.timestamp
          ) {
            detectedIdleTimestamp = activityState.timestamp;
          }

          // active/ready/idle/blocked — proceed to PR checks below
        } else {
          // getActivityState returned null — fall back to terminal output parsing
          const runtime = registry.get<Runtime>(
            "runtime",
            project.runtime ?? config.defaults.runtime,
          );
          const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
          if (terminalOutput) {
            const activity = agent.detectActivity(terminalOutput);
            if (activity === "waiting_input") return "needs_input";

            const processAlive = await agent.isProcessRunning(session.runtimeHandle);
            if (!processAlive) {
              if (shouldKeepPollingExitedPRSession(session, currentStatus, allowPrAutoDetect)) {
                agentExitedWithOpenPR = true;
              } else {
                return "killed";
              }
            }
          }
        }
      } catch (error) {
        incrementPollError(pollStats);
        logLifecycle("error", "agent.activity_check.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          agentName,
          error,
        });
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          currentStatus === SESSION_STATUS.STUCK ||
          currentStatus === SESSION_STATUS.NEEDS_INPUT
        ) {
          if (!session.pr) {
            return currentStatus;
          }

          preserveCurrentStatus = true;
        }
      }
    }

    // 3. Auto-detect PR by branch if metadata.pr is missing.
    //    This is critical for agents without auto-hook systems (Codex, Aider,
    //    OpenCode) that can't reliably write pr=<url> to metadata on their own.
    if (!session.pr && scm && session.branch && session.metadata["prAutoDetect"] !== "off") {
      try {
        const detectedPR = await scm.detectPR(session, project);
        if (detectedPR) {
          session.pr = detectedPR;
          // Persist PR URL so subsequent polls don't need to re-query.
          // Don't write status here — step 4 below will determine the
          // correct status (merged, ci_failed, etc.) on this same cycle.
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
        }
      } catch (error) {
        incrementPollError(pollStats);
        logLifecycle("error", "scm.pr_detect.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          scm: scmPlugin,
          branch: session.branch,
          error,
        });
        if (agentExitedWithOpenPR) {
          retryExitedSessionAfterPrLookupError = true;
        }
        // SCM detection failed — will retry next poll
      }
    }

    // 4. Check PR state if PR exists
    if (session.pr && scm) {
      let verificationEvaluation = await evaluatePostPushVerification(session, project);
      try {
        if (verificationEvaluation?.needsRun) {
          const execution = await runPostPushVerification(session, project);
          if (execution) {
            updateSessionMetadata(session, serializeVerificationResult(execution.result));
            logLifecycle("info", "verification.completed", {
              pollId: pollStats?.pollId,
              projectId: session.projectId,
              sessionId: session.id,
              prNumber: session.pr.number,
              head: execution.result.head,
              status: execution.result.status,
              failAction: execution.result.failAction,
              blockers: execution.result.blockers,
              artifacts: execution.result.artifacts,
              evidence: execution.result.evidence,
            });

            await handleVerificationFailureAction(session, execution, pollStats);
            verificationEvaluation = await evaluatePostPushVerification(session, project);
          }
        }
      } catch (error) {
        incrementPollError(pollStats);
        logLifecycle("error", "verification.run.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          prNumber: session.pr.number,
          error,
        });
      }

      if (!isOpenPRStatusPollDue(session)) {
        if (verificationEvaluation?.blockMerge && currentStatus === SESSION_STATUS.MERGEABLE) {
          return SESSION_STATUS.APPROVED;
        }

        if (
          detectedIdleTimestamp &&
          isIdleBeyondThreshold(session, detectedIdleTimestamp) &&
          currentStatus === SESSION_STATUS.PR_OPEN
        ) {
          return SESSION_STATUS.STUCK;
        }

        return currentStatus;
      }

      try {
        const openPREvaluation = await evaluateOpenPR(session, scm, verificationEvaluation);
        updateSessionMetadata(session, {
          lastPrStatusPollAt: new Date().toISOString(),
          lastPrCiStatus: openPREvaluation.ciStatus,
        });

        if (agentExitedWithOpenPR && isWaitingForCiVerdict(openPREvaluation.ciStatus)) {
          if (currentStatus === SESSION_STATUS.WAITING_CI && isWaitingCiTimedOut(session)) {
            return SESSION_STATUS.DONE;
          }

          return SESSION_STATUS.WAITING_CI;
        }

        if (shouldOverridePreservedPRStatus(openPREvaluation.status)) {
          return openPREvaluation.status;
        }

        if (preserveCurrentStatus) {
          return currentStatus;
        }

        if (openPREvaluation.status === SESSION_STATUS.APPROVED) {
          return SESSION_STATUS.APPROVED;
        }

        if (openPREvaluation.status === SESSION_STATUS.REVIEW_PENDING) {
          return SESSION_STATUS.REVIEW_PENDING;
        }

        // 4b. Post-PR stuck detection: agent has a PR open but is idle beyond
        // threshold. This catches the case where step 2's stuck check was
        // bypassed (getActivityState returned null) or the idle timestamp
        // wasn't available during step 2 but the session has been at pr_open
        // for a long time. Without this, sessions get stuck at "pr_open" forever.
        if (detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
          return SESSION_STATUS.STUCK;
        }

        return openPREvaluation.status;
      } catch (error) {
        incrementPollError(pollStats);
        logLifecycle("error", "scm.pr_check.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          scm: scmPlugin,
          pr: session.pr,
          error,
        });
        if (preserveCurrentStatus) {
          return currentStatus;
        }
      }
    }

    if (agentExitedWithOpenPR && !session.pr) {
      return retryExitedSessionAfterPrLookupError ? currentStatus : SESSION_STATUS.KILLED;
    }

    if (preserveCurrentStatus) {
      return currentStatus;
    }

    if (!session.pr && isBeyondMaxRuntime(session)) {
      return SESSION_STATUS.STUCK;
    }

    // 5. Agents can finish a turn without exiting. When they become ready/idle and
    // no PR state takes precedence, surface that as a non-terminal completed state.
    if (!session.pr && detectedCompletionState) {
      if (
        currentStatus === SESSION_STATUS.COMPLETED &&
        detectedIdleTimestamp &&
        isIdleBeyondThreshold(session, detectedIdleTimestamp)
      ) {
        return SESSION_STATUS.STUCK;
      }

      return SESSION_STATUS.COMPLETED;
    }

    // 6. Post-all stuck detection: if we detected idle in step 2 but had no PR,
    // still check stuck threshold. This handles agents that stay inactive after
    // completion detection was already emitted.
    if (detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
      return "stuck";
    }

    // 7. Default: if agent is active again, it's working
    if (
      currentStatus === SESSION_STATUS.SPAWNING ||
      currentStatus === SESSION_STATUS.COMPLETED ||
      currentStatus === SESSION_STATUS.STUCK ||
      currentStatus === SESSION_STATUS.NEEDS_INPUT
    ) {
      return SESSION_STATUS.WORKING;
    }
    return currentStatus;
  }

  async function cleanupMergedSession(
    session: Session,
    reactionKey: string,
    mergeMethod: string,
    pollStats?: LifecyclePollStats,
  ): Promise<{
    success: boolean;
    message: string;
    steps: SessionKillStepResult[];
    fallbackApplied: boolean;
  }> {
    const project = config.projects[session.projectId];
    if (!project) {
      return {
        success: false,
        message: `Unknown project ${session.projectId}`,
        steps: [],
        fallbackApplied: false,
      };
    }

    const steps = new Map<SessionKillStep, SessionKillStepResult>();
    const usesGitWorktreeCleanup = (project.workspace ?? config.defaults.workspace) === "worktree";
    let fallbackApplied = false;
    let killError: string | null = null;

    try {
      await sessionManager.kill(session.id, {
        onStep: (result) => upsertKillStep(steps, result),
      });
    } catch (error) {
      killError = formatErrorMessage(error);
      logLifecycle("error", "reaction.auto_merge.cleanup.kill_failed", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        reactionKey,
        error,
        cleanupSteps: listKillSteps(steps),
      });
    }

    const worktreeStep = steps.get("worktree");
    if (
      usesGitWorktreeCleanup &&
      session.workspacePath &&
      worktreeStep?.status !== "success" &&
      worktreeStep?.status !== "skipped"
    ) {
      try {
        await forceRemoveGitWorktree(project.path, session.workspacePath);
        fallbackApplied = true;
        upsertKillStep(steps, {
          step: "worktree",
          status: "success",
          message: `Removed worktree ${session.workspacePath} via auto-merge fallback`,
        });
        logLifecycle("info", "reaction.auto_merge.cleanup.worktree_fallback.completed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          reactionKey,
          worktree: session.workspacePath,
        });
      } catch (error) {
        upsertKillStep(steps, {
          step: "worktree",
          status: "failed",
          message: [
            worktreeStep?.message,
            `Auto-merge fallback failed: ${formatErrorMessage(error)}`,
          ]
            .filter(Boolean)
            .join("; "),
        });
        logLifecycle("error", "reaction.auto_merge.cleanup.worktree_fallback.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          reactionKey,
          worktree: session.workspacePath,
          error,
        });
      }
    }

    const branchStep = steps.get("branch");
    if (
      usesGitWorktreeCleanup &&
      session.branch &&
      session.branch !== project.defaultBranch &&
      branchStep?.status !== "success" &&
      branchStep?.status !== "skipped"
    ) {
      try {
        const branchResult = await deleteLocalBranch(project.path, session.branch);
        fallbackApplied = true;
        upsertKillStep(steps, {
          step: "branch",
          status: "success",
          message:
            branchResult === "deleted"
              ? `Deleted local branch ${session.branch} via auto-merge fallback`
              : `Local branch ${session.branch} already absent via auto-merge fallback`,
        });
        logLifecycle("info", "reaction.auto_merge.cleanup.branch_fallback.completed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          reactionKey,
          branch: session.branch,
          branchResult,
        });
      } catch (error) {
        upsertKillStep(steps, {
          step: "branch",
          status: "failed",
          message: [branchStep?.message, `Auto-merge fallback failed: ${formatErrorMessage(error)}`]
            .filter(Boolean)
            .join("; "),
        });
        logLifecycle("error", "reaction.auto_merge.cleanup.branch_fallback.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          reactionKey,
          branch: session.branch,
          error,
        });
      }
    }

    const finalSteps = listKillSteps(steps);
    if (isSessionCleanupComplete(steps)) {
      states.delete(session.id);
      logLifecycle("info", "reaction.auto_merge.cleanup.completed", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        reactionKey,
        mergeMethod,
        fallbackApplied,
        cleanupSteps: finalSteps,
      });
      return {
        success: true,
        message: killError
          ? `Merged PR and completed session cleanup after recovery: ${killError}`
          : "Merged PR and completed session cleanup",
        steps: finalSteps,
        fallbackApplied,
      };
    }

    const blockingFailureMessage = finalSteps
      .filter(
        (step) => step.status === "failed" && step.step !== "runtime" && step.step !== "opencode",
      )
      .map((step) => `${step.step}: ${step.message}`)
      .join("; ");

    return {
      success: false,
      message: (killError ?? blockingFailureMessage) || "Session cleanup incomplete",
      steps: finalSteps,
      fallbackApplied,
    };
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    pollStats?: LifecyclePollStats,
    session?: Session,
    transitionContext?: TransitionEventContext,
  ): Promise<ReactionResult> {
    const tracker = getOrCreateReactionTracker(sessionId, reactionKey);
    const nowMs = Date.now();

    // Increment attempts before checking escalation
    tracker.attempts++;
    tracker.lastReactionFiredAtMs = nowMs;

    // Check if we should escalate
    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      tracker.escalatedAtMs = nowMs;

      // Escalate to human
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
        idempotencyKey: transitionContext?.idempotencyKey,
      });
      logLifecycle("info", "reaction.escalated", {
        pollId: pollStats?.pollId,
        projectId,
        sessionId,
        reactionKey,
        attempts: tracker.attempts,
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent", pollStats);
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    // Execute the reaction action
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        const message = await buildSendToAgentMessage(
          sessionId,
          projectId,
          reactionKey,
          reactionConfig,
          pollStats,
          session,
        );

        if (message) {
          try {
            await sessionManager.send(sessionId, message);
            logLifecycle("info", "reaction.sent_to_agent", {
              pollId: pollStats?.pollId,
              projectId,
              sessionId,
              reactionKey,
              action,
            });

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message,
              escalated: false,
            };
          } catch (error) {
            incrementPollError(pollStats);
            logLifecycle("error", "reaction.send_to_agent.failed", {
              pollId: pollStats?.pollId,
              projectId,
              sessionId,
              reactionKey,
              action,
              error,
            });
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "notify": {
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
          idempotencyKey: transitionContext?.idempotencyKey,
        });
        await notifyHuman(event, reactionConfig.priority ?? "info", pollStats);
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "auto-merge": {
        const project = config.projects[projectId];
        const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
        const mergeMethod = resolveMergeMethod(project?.scm);

        if (!session?.pr || !project || !scm) {
          incrementPollError(pollStats);
          logLifecycle("error", "reaction.auto_merge.unavailable", {
            pollId: pollStats?.pollId,
            projectId,
            sessionId,
            reactionKey,
            hasProject: Boolean(project),
            hasPR: Boolean(session?.pr),
            hasSCM: Boolean(scm),
            mergeMethod,
          });
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Auto-merge could not run for reaction '${reactionKey}'. Manual intervention required.`,
            data: { reactionKey, mergeMethod },
            idempotencyKey: transitionContext?.idempotencyKey,
          });
          await notifyHuman(event, "urgent", pollStats);
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            message: "Auto-merge unavailable",
            escalated: true,
          };
        }

        const mergeability = applyVerificationToMergeability(
          await scm.getMergeability(session.pr),
          await evaluatePostPushVerification(session, project),
        );
        if (!mergeability.mergeable) {
          logLifecycle("info", "reaction.auto_merge.blocked", {
            pollId: pollStats?.pollId,
            projectId,
            sessionId,
            reactionKey,
            prNumber: session.pr.number,
            mergeMethod,
            blockers: mergeability.blockers,
          });
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Auto-merge skipped for PR #${session.pr.number}: ${mergeability.blockers.join("; ")}`,
            data: {
              reactionKey,
              prNumber: session.pr.number,
              prUrl: session.pr.url,
              mergeMethod,
              blockers: mergeability.blockers,
            },
            idempotencyKey: transitionContext?.idempotencyKey,
          });
          await notifyHuman(event, "warning", pollStats);
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            message: mergeability.blockers.join("; "),
            escalated: true,
          };
        }

        try {
          await scm.mergePR(session.pr, mergeMethod);
        } catch (error) {
          incrementPollError(pollStats);
          logLifecycle("error", "reaction.auto_merge.failed", {
            pollId: pollStats?.pollId,
            projectId,
            sessionId,
            reactionKey,
            prNumber: session.pr.number,
            mergeMethod,
            error,
          });
          const message = error instanceof Error ? error.message : String(error);
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Auto-merge failed for PR #${session.pr.number}. Manual intervention required.`,
            data: {
              reactionKey,
              prNumber: session.pr.number,
              prUrl: session.pr.url,
              mergeMethod,
              error: message,
            },
            idempotencyKey: transitionContext?.idempotencyKey,
          });
          await notifyHuman(event, "urgent", pollStats);
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            message,
            escalated: true,
          };
        }

        clearReactionTracker(session.id, reactionKey);
        logLifecycle("info", "reaction.auto_merge.completed", {
          pollId: pollStats?.pollId,
          projectId,
          sessionId,
          reactionKey,
          prNumber: session.pr.number,
          mergeMethod,
        });
        const mergedEvent = createEvent("merge.completed", {
          sessionId,
          projectId,
          message: `${sessionId}: auto-merged PR #${session.pr.number}`,
          data: {
            reactionKey,
            prNumber: session.pr.number,
            prUrl: session.pr.url,
            mergeMethod,
          },
          idempotencyKey: transitionContext?.idempotencyKey,
        });
        await notifyHuman(mergedEvent, inferPriority(mergedEvent.type), pollStats);

        const cleanup = await cleanupMergedSession(session, reactionKey, mergeMethod, pollStats);
        if (!cleanup.success) {
          incrementPollError(pollStats);
          logLifecycle("error", "reaction.auto_merge.cleanup.incomplete", {
            pollId: pollStats?.pollId,
            projectId,
            sessionId,
            reactionKey,
            prNumber: session.pr.number,
            mergeMethod,
            fallbackApplied: cleanup.fallbackApplied,
            cleanupSteps: cleanup.steps,
            cleanupError: cleanup.message,
          });
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Auto-merge cleanup failed after PR #${session.pr.number} merged. Manual intervention required.`,
            data: {
              reactionKey,
              prNumber: session.pr.number,
              prUrl: session.pr.url,
              mergeMethod,
              cleanupSteps: cleanup.steps,
              fallbackApplied: cleanup.fallbackApplied,
              error: cleanup.message,
            },
            idempotencyKey: transitionContext?.idempotencyKey,
          });
          await notifyHuman(event, "urgent", pollStats);
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            message: cleanup.message,
            escalated: true,
          };
        }

        const completedEvent = createEvent("session.completed", {
          sessionId,
          projectId,
          message: `${sessionId}: session cleanup completed after auto-merge of PR #${session.pr.number}`,
          data: {
            reactionKey,
            prNumber: session.pr.number,
            prUrl: session.pr.url,
            mergeMethod,
            cleanupSteps: cleanup.steps,
            fallbackApplied: cleanup.fallbackApplied,
          },
          idempotencyKey: transitionContext?.idempotencyKey,
        });
        await notifyHuman(completedEvent, inferPriority(completedEvent.type), pollStats);
        return {
          reactionType: reactionKey,
          success: true,
          action: "auto-merge",
          message: `Merged PR #${session.pr.number} with ${mergeMethod} and cleaned up session`,
          escalated: false,
        };
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  function clearReactionTracker(sessionId: SessionId, reactionKey: string): void {
    reactionTrackers.delete(`${sessionId}:${reactionKey}`);
  }

  function getReactionConfigForSession(
    session: Session,
    reactionKey: string,
  ): ReactionConfig | null {
    const project = config.projects[session.projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    const reactionConfig = projectReaction
      ? { ...globalReaction, ...projectReaction }
      : globalReaction;
    return reactionConfig ? (reactionConfig as ReactionConfig) : null;
  }

  function getSendToAgentRecoveryConfig(
    session: Session,
    reactionKey: OrphanRecoveryAction["reactionKey"],
  ): ReactionConfig | null {
    const reactionConfig = getReactionConfigForSession(session, reactionKey);
    if (!reactionConfig) return null;
    if (reactionConfig.action !== "send-to-agent") return null;
    if (reactionConfig.auto === false) return null;
    return reactionConfig;
  }

  function getProgressCheckpointConfigForSession(session: Session): ReactionConfig | null {
    const reactionConfig = getReactionConfigForSession(session, PROGRESS_CHECKPOINT_REACTION_KEY);
    if (!reactionConfig) {
      return null;
    }

    const firstCommitThreshold =
      typeof reactionConfig.firstCommit === "string" ? reactionConfig.firstCommit : null;
    const firstPrThreshold = typeof reactionConfig.firstPR === "string" ? reactionConfig.firstPR : null;
    const firstCommitMs = firstCommitThreshold ? parseDuration(firstCommitThreshold) : 0;
    const firstPrMs = firstPrThreshold ? parseDuration(firstPrThreshold) : 0;

    if (firstCommitMs <= 0 && firstPrMs <= 0) {
      return null;
    }

    return reactionConfig;
  }

  async function fireProgressCheckpoint(
    session: Session,
    reactionConfig: ReactionConfig,
    checkpoint: ProgressCheckpointCandidate,
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const missCount = parseInteger(session.metadata[PROGRESS_CHECKPOINT_MISS_COUNT_METADATA_KEY]) + 1;
    const priority = resolveProgressCheckpointPriority(reactionConfig.priority, missCount);
    const checkpointBaseAtMs = resolveProgressCheckpointBaseAtMs(session);
    const firedAtKey = PROGRESS_CHECKPOINT_FIRED_AT_METADATA_KEYS[checkpoint.key];

    updateSessionMetadata(session, {
      [firedAtKey]: nowIso,
      [PROGRESS_CHECKPOINT_MISS_COUNT_METADATA_KEY]: String(missCount),
    });

    logLifecycle("info", "progress_checkpoint.triggered", {
      pollId: pollStats?.pollId,
      projectId: session.projectId,
      sessionId: session.id,
      checkpoint: checkpoint.key,
      threshold: checkpoint.threshold,
      missCount,
      priority,
    });

    const event = createEvent("reaction.triggered", {
      sessionId: session.id,
      projectId: session.projectId,
      message: buildProgressCheckpointNotificationMessage(session, checkpoint),
      data: {
        reactionKey: PROGRESS_CHECKPOINT_REACTION_KEY,
        checkpoint: checkpoint.key,
        threshold: checkpoint.threshold,
        missCount,
        checkpointPriority: priority,
        checkpointBaseAt: new Date(checkpointBaseAtMs).toISOString(),
        checkpointAgeMinutes: toElapsedMinutes(checkpointBaseAtMs, nowMs),
        sessionAgeMinutes: toElapsedMinutes(session.createdAt.getTime(), nowMs),
        commitsSinceSpawn: checkpoint.gitState?.commitsSinceSpawn ?? 0,
        branch: checkpoint.gitState?.branch ?? session.branch,
        hasPR: Boolean(session.pr),
        prNumber: session.pr?.number,
      },
      idempotencyKey: createProgressCheckpointIdempotencyKey(session.id, checkpoint.key),
      timestamp: now,
    });

    if (reactionConfig.action === "send-to-agent" && reactionConfig.auto !== false) {
      const message = buildProgressCheckpointAgentMessage(reactionConfig, checkpoint);

      try {
        await sessionManager.send(session.id, message);
        logLifecycle("info", "progress_checkpoint.sent_to_agent", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          checkpoint: checkpoint.key,
          missCount,
        });
        return;
      } catch (error) {
        incrementPollError(pollStats);
        logLifecycle("error", "progress_checkpoint.send_to_agent.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          checkpoint: checkpoint.key,
          missCount,
          error,
        });
      }
    }

    await notifyHuman(event, priority, pollStats);
  }

  async function maybeFireProgressCheckpoint(
    session: Session,
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    if (isOrchestratorSession(session)) {
      return;
    }

    if (INACTIVE_SESSION_STATUSES.has(getEffectiveSessionStatus(session))) {
      return;
    }

    const reactionConfig = getProgressCheckpointConfigForSession(session);
    if (!reactionConfig) {
      return;
    }

    const nowMs = Date.now();
    const checkpointAgeMs = nowMs - resolveProgressCheckpointBaseAtMs(session);
    const candidates: ProgressCheckpointCandidate[] = [];
    let gitState: ProgressGitState | null = null;

    const firstCommitThreshold =
      typeof reactionConfig.firstCommit === "string" ? reactionConfig.firstCommit : null;
    const firstPrThreshold =
      typeof reactionConfig.firstPR === "string" ? reactionConfig.firstPR : null;
    const firstCommitMs = firstCommitThreshold ? parseDuration(firstCommitThreshold) : 0;
    const firstPrMs = firstPrThreshold ? parseDuration(firstPrThreshold) : 0;

    if (
      firstCommitMs > 0 &&
      checkpointAgeMs >= firstCommitMs &&
      !session.pr &&
      !session.metadata[PROGRESS_CHECKPOINT_FIRED_AT_METADATA_KEYS.firstCommit]
    ) {
      gitState = await collectGitState(session, nowMs);
      if (gitState.commitsSinceSpawn === 0) {
        candidates.push({
          key: "firstCommit",
          threshold: firstCommitThreshold ?? "",
          thresholdMs: firstCommitMs,
          gitState,
        });
      }
    }

    if (
      firstPrMs > 0 &&
      checkpointAgeMs >= firstPrMs &&
      !session.pr &&
      !session.metadata[PROGRESS_CHECKPOINT_FIRED_AT_METADATA_KEYS.firstPR]
    ) {
      candidates.push({
        key: "firstPR",
        threshold: firstPrThreshold ?? "",
        thresholdMs: firstPrMs,
        gitState,
      });
    }

    if (candidates.length === 0) {
      return;
    }

    candidates.sort((left, right) => {
      if (left.thresholdMs !== right.thresholdMs) {
        return left.thresholdMs - right.thresholdMs;
      }

      if (left.key === right.key) {
        return 0;
      }

      return left.key === "firstCommit" ? -1 : 1;
    });

    await fireProgressCheckpoint(session, reactionConfig, candidates[0], pollStats);
  }

  function updateSessionMetadata(session: Session, updates: Partial<Record<string, string>>): void {
    const project = config.projects[session.projectId];
    if (!project) return;

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, updates);

    const cleaned = Object.fromEntries(
      Object.entries(session.metadata).filter(([key]) => {
        const update = updates[key];
        return update === undefined || update !== "";
      }),
    );
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === "") continue;
      cleaned[key] = value;
    }
    session.metadata = cleaned;
  }

  function getEffectiveSessionStatus(session: Session): SessionStatus {
    const tracked = states.get(session.id);
    return tracked ?? (session.metadata["status"] as SessionStatus | undefined) ?? session.status;
  }

  function isProgressSnapshotDue(session: Session): boolean {
    const progressChecks = resolveProgressChecksConfigForProject(config, session.projectId);
    if (!progressChecks) return false;
    if (INACTIVE_SESSION_STATUSES.has(getEffectiveSessionStatus(session))) return false;

    const intervalMs = progressChecks.intervalMinutes * 60_000;
    const nowMs = Date.now();
    const lastSnapshotAtMs = parseTimestampMs(session.metadata["lastProgressSnapshotAt"]);
    if (lastSnapshotAtMs !== null) {
      return nowMs - lastSnapshotAtMs >= intervalMs;
    }

    return nowMs - session.createdAt.getTime() >= intervalMs;
  }

  async function buildProgressSnapshot(
    session: Session,
    progressChecks: ProgressChecksConfig,
    agentName: string,
    runtime: Runtime | null,
    agent: Agent | null,
    snapshotNumber: number,
  ): Promise<ProgressCheckSnapshot> {
    const nowMs = Date.now();
    const history = progressSignalHistory.get(session.id) ?? createProgressSignalHistory();
    const project = config.projects[session.projectId];
    const terminal = await captureTerminalOutput(
      runtime,
      session.runtimeHandle,
      progressChecks.terminalLines,
    );
    const matchedErrorPatterns = collectPatternMatches(
      terminal.text,
      progressChecks.signals.errorPatterns,
    );
    const matchedTestCommands = collectPatternMatches(
      terminal.text,
      progressChecks.signals.testPatterns,
    );
    const matchedLiveCommands = collectPatternMatches(
      terminal.text,
      progressChecks.signals.livePatterns,
    );

    for (const match of matchedErrorPatterns) history.errorPatterns.add(match);
    for (const match of matchedTestCommands) history.testCommandsSeen.add(match);
    for (const match of matchedLiveCommands) history.liveCommandsSeen.add(match);

    const terminalFingerprint = createHash("sha1").update(terminal.text).digest("hex");
    const tmuxLastOutputAtMs = await getLastOutputAtMs(session);
    const lastOutputAtMs =
      tmuxLastOutputAtMs ??
      (history.lastOutputFingerprint !== terminalFingerprint
        ? nowMs
        : (history.lastOutputAtMs ?? session.lastActivityAt.getTime()));

    history.lastOutputFingerprint = terminalFingerprint;
    history.lastOutputAtMs = lastOutputAtMs;
    progressSignalHistory.set(session.id, history);

    const idleSeconds = toElapsedSeconds(lastOutputAtMs, nowMs);
    const gitState = await collectGitState(session, nowMs);
    const budgetRemainingPct = await resolveBudgetRemainingPct(agent, session, terminal.text);

    return {
      event: "progress-check",
      session: session.id,
      project: session.projectId,
      issue: session.issueId,
      agent: agentName,
      model: project ? resolveSnapshotModel(session, project) : null,
      timing: {
        age_minutes: toElapsedMinutes(session.createdAt.getTime(), nowMs),
        ...(budgetRemainingPct !== undefined ? { budget_remaining_pct: budgetRemainingPct } : {}),
        last_output_seconds_ago: idleSeconds,
        snapshot_number: snapshotNumber,
      },
      git: {
        branch: gitState.branch,
        commits_since_spawn: gitState.commitsSinceSpawn,
        last_commit_age_minutes: gitState.lastCommitAgeMinutes,
        dirty_files: gitState.dirtyFiles,
        has_pr: Boolean(session.pr),
      },
      signals: {
        idle: idleSeconds >= PROGRESS_IDLE_THRESHOLD_MS / 1000,
        idle_seconds: idleSeconds,
        error_patterns: [...history.errorPatterns],
        test_commands_seen: [...history.testCommandsSeen],
        live_commands_seen: [...history.liveCommandsSeen],
        has_pushed: gitState.hasPushed,
      },
      terminal: {
        last_lines: terminal.text,
        truncated: terminal.truncated,
      },
    };
  }

  async function emitProgressSnapshot(
    session: Session,
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    const project = config.projects[session.projectId];
    const progressChecks = resolveProgressChecksConfigForProject(config, session.projectId);
    if (!project || !progressChecks) return;
    if (INACTIVE_SESSION_STATUSES.has(getEffectiveSessionStatus(session))) return;

    const agentName = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
    const runtimeName =
      session.runtimeHandle?.runtimeName ?? project.runtime ?? config.defaults.runtime;
    const runtime = registry.get<Runtime>("runtime", runtimeName);
    const agent = registry.get<Agent>("agent", agentName);
    const snapshotNumber = parseInteger(session.metadata["progressSnapshotCount"]) + 1;
    const snapshot = await buildProgressSnapshot(
      session,
      progressChecks,
      agentName,
      runtime,
      agent,
      snapshotNumber,
    );
    const nowIso = new Date().toISOString();

    updateSessionMetadata(session, {
      lastProgressSnapshotAt: nowIso,
      progressSnapshotCount: String(snapshotNumber),
    });

    const event = createEvent("progress-check", {
      sessionId: session.id,
      projectId: session.projectId,
      message: `${session.id}: progress snapshot #${snapshotNumber}`,
      data: snapshot as unknown as Record<string, unknown>,
      idempotencyKey: createProgressSnapshotIdempotencyKey(session.id, snapshotNumber),
    });

    logLifecycle("info", "progress.snapshot.created", {
      pollId: pollStats?.pollId,
      projectId: session.projectId,
      sessionId: session.id,
      snapshotNumber,
      agent: agentName,
    });

    await notifyHuman(event, "info", pollStats, progressChecks.notify);
  }

  async function emitDueProgressSnapshots(
    sessions: Session[],
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    const dueSessions = sessions.filter((session) => isProgressSnapshotDue(session));
    if (dueSessions.length === 0) return;

    const results = await Promise.allSettled(
      dueSessions.map((session) => emitProgressSnapshot(session, pollStats)),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      incrementPollError(pollStats);
      logLifecycle("error", "progress.snapshot.failed", {
        pollId: pollStats?.pollId,
        projectId: dueSessions[index]?.projectId,
        sessionId: dueSessions[index]?.id,
        error: result.reason,
      });
    }
  }

  function makeFingerprint(ids: string[]): string {
    return [...ids].sort().join(",");
  }

  async function maybeDispatchReviewBacklog(
    session: Session,
    oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: { key: string; result: ReactionResult | null },
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const humanReactionKey = "changes-requested";
    const automatedReactionKey = "bugbot-comments";

    if (newStatus === "merged" || newStatus === "killed") {
      clearReactionTracker(session.id, humanReactionKey);
      clearReactionTracker(session.id, automatedReactionKey);
      updateSessionMetadata(session, {
        lastPendingReviewFingerprint: "",
        lastPendingReviewDispatchHash: "",
        lastPendingReviewDispatchAt: "",
        lastAutomatedReviewFingerprint: "",
        lastAutomatedReviewDispatchHash: "",
        lastAutomatedReviewDispatchAt: "",
        lastPrStatusPollAt: "",
        lastPrCiStatus: "",
        waitingCiSince: "",
        waitingCiTimedOutAt: "",
      });
      return;
    }

    const [pendingResult, automatedResult] = await Promise.allSettled([
      scm.getPendingComments(session.pr),
      scm.getAutomatedComments(session.pr),
    ]);

    // null means "failed to fetch" — preserve existing metadata.
    // [] means "confirmed no comments" — safe to clear.
    if (pendingResult.status === "rejected") {
      incrementPollError(pollStats);
      logLifecycle("error", "review.pending_comments.failed", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        pr: session.pr,
        error: pendingResult.reason,
      });
    }
    if (automatedResult.status === "rejected") {
      incrementPollError(pollStats);
      logLifecycle("error", "review.automated_comments.failed", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        pr: session.pr,
        error: automatedResult.reason,
      });
    }

    const pendingComments =
      pendingResult.status === "fulfilled" && Array.isArray(pendingResult.value)
        ? pendingResult.value
        : null;
    const automatedComments =
      automatedResult.status === "fulfilled" && Array.isArray(automatedResult.value)
        ? automatedResult.value
        : null;

    // --- Pending (human) review comments ---
    // null = SCM fetch failed; skip processing to preserve existing metadata.
    if (pendingComments !== null) {
      const pendingFingerprint = makeFingerprint(pendingComments.map((comment) => comment.id));
      const lastPendingFingerprint = session.metadata["lastPendingReviewFingerprint"] ?? "";
      const lastPendingDispatchHash = session.metadata["lastPendingReviewDispatchHash"] ?? "";

      if (
        pendingFingerprint !== lastPendingFingerprint &&
        transitionReaction?.key !== humanReactionKey
      ) {
        clearReactionTracker(session.id, humanReactionKey);
      }
      if (pendingFingerprint !== lastPendingFingerprint) {
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: pendingFingerprint,
        });
      }

      if (!pendingFingerprint) {
        clearReactionTracker(session.id, humanReactionKey);
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: "",
          lastPendingReviewDispatchHash: "",
          lastPendingReviewDispatchAt: "",
        });
      } else if (
        transitionReaction?.key === humanReactionKey &&
        transitionReaction.result?.success
      ) {
        if (lastPendingDispatchHash !== pendingFingerprint) {
          updateSessionMetadata(session, {
            lastPendingReviewDispatchHash: pendingFingerprint,
            lastPendingReviewDispatchAt: new Date().toISOString(),
          });
        }
      } else if (
        !(oldStatus !== newStatus && newStatus === "changes_requested") &&
        pendingFingerprint !== lastPendingDispatchHash
      ) {
        const reactionConfig = getReactionConfigForSession(session, humanReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const result = await executeReaction(
            session.id,
            session.projectId,
            humanReactionKey,
            reactionConfig,
            pollStats,
            session,
          );
          if (result.success) {
            updateSessionMetadata(session, {
              lastPendingReviewDispatchHash: pendingFingerprint,
              lastPendingReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    // --- Automated (bot) review comments ---
    if (automatedComments !== null) {
      const automatedFingerprint = makeFingerprint(automatedComments.map((comment) => comment.id));
      const lastAutomatedFingerprint = session.metadata["lastAutomatedReviewFingerprint"] ?? "";
      const lastAutomatedDispatchHash = session.metadata["lastAutomatedReviewDispatchHash"] ?? "";

      if (automatedFingerprint !== lastAutomatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: automatedFingerprint,
        });
      }

      if (!automatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: "",
          lastAutomatedReviewDispatchHash: "",
          lastAutomatedReviewDispatchAt: "",
        });
      } else if (automatedFingerprint !== lastAutomatedDispatchHash) {
        const reactionConfig = getReactionConfigForSession(session, automatedReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const result = await executeReaction(
            session.id,
            session.projectId,
            automatedReactionKey,
            reactionConfig,
            pollStats,
            session,
          );
          if (result.success) {
            updateSessionMetadata(session, {
              lastAutomatedReviewDispatchHash: automatedFingerprint,
              lastAutomatedReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(
    event: OrchestratorEvent,
    priority: EventPriority,
    pollStats?: LifecyclePollStats,
    notifierNamesOverride?: string[],
  ): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames =
      notifierNamesOverride && notifierNamesOverride.length > 0
        ? notifierNamesOverride
        : (config.notificationRouting[priority] ?? config.defaults.notifiers);

    if (notifierNames.length === 0) {
      logLifecycle("info", "notification.skipped", {
        pollId: pollStats?.pollId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        priority,
        eventType: event.type,
        reason: "no_notifiers_configured",
      });
      return;
    }

    const nowMs = Date.now();
    pruneRecentEventIdempotencyKeys(nowMs);
    const existingTtl = recentEventIdempotencyKeys.get(event.idempotencyKey);
    if (existingTtl !== undefined && existingTtl > nowMs) {
      logLifecycle("info", "notification.deduplicated", {
        pollId: pollStats?.pollId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        priority,
        eventType: event.type,
        idempotencyKey: event.idempotencyKey,
      });
      return;
    }
    recentEventIdempotencyKeys.set(event.idempotencyKey, nowMs + RECENT_EVENT_TTL_MS);

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (!notifier) {
        incrementPollError(pollStats);
        if (pollStats) {
          pollStats.notificationFailures += 1;
        }
        logLifecycle("error", "notification.missing_notifier", {
          pollId: pollStats?.pollId,
          projectId: event.projectId,
          sessionId: event.sessionId,
          notifier: name,
          priority,
          eventType: event.type,
        });
        continue;
      }

      try {
        await notifier.notify(eventWithPriority);
        if (pollStats) {
          pollStats.notificationsSent += 1;
        }
        logLifecycle("info", "notification.sent", {
          pollId: pollStats?.pollId,
          projectId: event.projectId,
          sessionId: event.sessionId,
          notifier: name,
          priority,
          eventType: event.type,
          idempotencyKey: event.idempotencyKey,
        });
      } catch (error) {
        incrementPollError(pollStats);
        if (pollStats) {
          pollStats.notificationFailures += 1;
        }
        logLifecycle("error", "notification.failed", {
          pollId: pollStats?.pollId,
          projectId: event.projectId,
          sessionId: event.sessionId,
          notifier: name,
          priority,
          eventType: event.type,
          idempotencyKey: event.idempotencyKey,
          error,
        });
      }
    }
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session, pollStats?: LifecyclePollStats): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    let newStatus = await determineStatus(session, oldStatus, pollStats);
    let transitionReaction: { key: string; result: ReactionResult | null } | undefined;

    if (newStatus !== oldStatus) {
      if (pollStats) {
        pollStats.transitions += 1;
      }

      const eventType = statusToEventType(oldStatus, newStatus);
      const reactionKey = eventType ? eventToReactionKey(eventType) : null;
      logLifecycle("info", "session.transition", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        oldStatus,
        newStatus,
        eventType,
        reactionKey,
      });

      // State transition detected
      states.set(session.id, newStatus);
      updateSessionMetadata(session, buildStatusMetadataUpdates(session, oldStatus, newStatus));

      // Reset allCompleteEmitted when any session becomes active again
      if (newStatus !== "merged" && newStatus !== "killed") {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          clearReactionTracker(session.id, oldReactionKey);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      if (eventType) {
        const transitionContext = createTransitionEventContext(
          session.id,
          eventType,
          oldStatus,
          newStatus,
        );
        let reactionHandledNotify = false;

        if (reactionKey) {
          const reactionConfig = getReactionConfigForSession(session, reactionKey);

          if (reactionConfig && reactionConfig.action) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const reactionResult = await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
                pollStats,
                session,
                transitionContext,
              );
              transitionReaction = { key: reactionKey, result: reactionResult };

              if (reactionResult.resultingStatus && reactionResult.resultingStatus !== newStatus) {
                const reactionFromStatus = newStatus;
                const finalStatus = reactionResult.resultingStatus;
                const finalEventType = statusToEventType(newStatus, finalStatus);
                const finalReactionKey = finalEventType ? eventToReactionKey(finalEventType) : null;

                if (pollStats) {
                  pollStats.transitions += 1;
                }

                logLifecycle("info", "session.transition", {
                  pollId: pollStats?.pollId,
                  projectId: session.projectId,
                  sessionId: session.id,
                  oldStatus: newStatus,
                  newStatus: finalStatus,
                  eventType: finalEventType,
                  reactionKey: finalReactionKey,
                  triggeredBy: reactionKey,
                });

                newStatus = finalStatus;
                states.set(session.id, finalStatus);
                updateSessionMetadata(
                  session,
                  buildStatusMetadataUpdates(session, reactionFromStatus, finalStatus),
                );
              }

              // Only suppress the transition notification if the reaction actually
              // handled the event or escalated it to humans. Failed send-to-agent
              // attempts should fall back to the normal human notification path.
              reactionHandledNotify = reactionResult.success || reactionResult.escalated;
            }
          }
        }

        // For transitions not already notified by a reaction, notify humans.
        // All priorities (including "info") are routed through notificationRouting
        // so the config controls which notifiers receive each priority level.
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          const event = createEvent(eventType, {
            sessionId: session.id,
            projectId: session.projectId,
            message: `${session.id}: ${oldStatus} → ${newStatus}`,
            data: { oldStatus, newStatus },
            idempotencyKey: transitionContext.idempotencyKey,
            timestamp: transitionContext.timestamp,
          });
          await notifyHuman(event, priority, pollStats);
        }
      }

      if (oldStatus === SESSION_STATUS.WAITING_CI && newStatus === SESSION_STATUS.DONE) {
        const event = createEvent("session.completed", {
          sessionId: session.id,
          projectId: session.projectId,
          message: `${session.id}: CI did not report within 30 minutes; marking session done`,
          data: { oldStatus, newStatus, reason: "waiting_ci_timeout" },
        });
        await notifyHuman(event, "warning", pollStats);
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
    }

    if (!states.has(session.id)) {
      return;
    }

    const shouldSkipReviewBacklog =
      newStatus === oldStatus && isOrphanRecoveryCandidate(session, newStatus);
    if (!shouldSkipReviewBacklog) {
      await maybeDispatchReviewBacklog(
        session,
        oldStatus,
        newStatus,
        transitionReaction,
        pollStats,
      );
    }

    if (newStatus === oldStatus) {
      await maybeRefirePersistentReaction(session, newStatus, pollStats);
    }

    await maybeFireProgressCheckpoint(session, pollStats);

    await maybeRecoverOrphanedPR(session, newStatus, pollStats);
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) {
      logLifecycle("info", "poll.skipped", {
        projectId: scopedProjectId ?? "all",
        reason: "previous_poll_still_running",
      });
      return;
    }
    polling = true;
    const pollStats = createPollStats();
    pruneRecentEventIdempotencyKeys();

    logLifecycle("info", "poll.start", {
      pollId: pollStats.pollId,
      projectId: scopedProjectId ?? "all",
    });

    try {
      const sessions = await sessionManager.list(scopedProjectId);

      const pausedProjects = new Map<string, Date>();
      for (const session of sessions) {
        if (!isOrchestratorSession(session)) continue;
        const until = parsePauseUntil(session.metadata[GLOBAL_PAUSE_UNTIL_KEY]);
        if (!until) continue;
        if (until.getTime() <= Date.now()) {
          const project = config.projects[session.projectId];
          if (project) {
            clearProjectPause(project);
          }
          continue;
        }
        pausedProjects.set(session.projectId, until);
      }

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (pausedProjects.has(s.projectId) && !isOrchestratorSession(s)) {
          return false;
        }
        if (!INACTIVE_SESSION_STATUSES.has(s.status)) return true;
        const tracked = states.get(s.id);
        return (tracked !== undefined && tracked !== s.status) || isOrphanRecoveryCandidate(s);
      });

      const activeSessions = sessions.filter((s) => !INACTIVE_SESSION_STATUSES.has(s.status));
      pollStats.totalSessions = sessions.length;
      pollStats.checkedSessions = sessionsToCheck.length;
      pollStats.activeSessions = activeSessions.length;

      logLifecycle("info", "poll.sessions_loaded", {
        pollId: pollStats.pollId,
        projectId: scopedProjectId ?? "all",
        totalSessions: pollStats.totalSessions,
        checkedSessions: pollStats.checkedSessions,
        activeSessions: pollStats.activeSessions,
      });

      // Poll all sessions concurrently
      const results = await Promise.allSettled(
        sessionsToCheck.map((s) => checkSession(s, pollStats)),
      );
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          incrementPollError(pollStats);
          logLifecycle("error", "poll.session_failed", {
            pollId: pollStats.pollId,
            projectId: sessionsToCheck[index]?.projectId,
            sessionId: sessionsToCheck[index]?.id,
            error: result.reason,
          });
        }
      }

      await emitDueProgressSnapshots(sessions, pollStats);

      // Prune stale entries from states and reactionTrackers for sessions
      // that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }
      for (const sessionId of progressSignalHistory.keys()) {
        if (!currentSessionIds.has(sessionId)) {
          progressSignalHistory.delete(sessionId);
        }
      }

      // Check if all sessions are complete (trigger reaction only once)
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction(
                "system",
                "all",
                reactionKey,
                reactionConfig as ReactionConfig,
                pollStats,
              );
            }
          }
        }
      }
    } catch (err) {
      incrementPollError(pollStats);
      logLifecycle("error", "poll.failed", {
        pollId: pollStats.pollId,
        projectId: scopedProjectId ?? "all",
        error: err,
      });
    } finally {
      logLifecycle("info", "poll.end", {
        pollId: pollStats.pollId,
        projectId: scopedProjectId ?? "all",
        totalSessions: pollStats.totalSessions,
        checkedSessions: pollStats.checkedSessions,
        activeSessions: pollStats.activeSessions,
        transitions: pollStats.transitions,
        errors: pollStats.errors,
        notificationsSent: pollStats.notificationsSent,
        notificationFailures: pollStats.notificationFailures,
        durationMs: Date.now() - pollStats.startedAtMs,
      });
      polling = false;
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await checkSession(session);
    },
  };
}
