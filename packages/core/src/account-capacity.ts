import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAccountCapacityFile } from "./paths.js";
import type {
  AccountBaseQuota,
  AccountCapacity,
  AccountCapacityStatus,
  AccountConfig,
  AccountModelFamily,
  AccountModelRouteAvailability,
  AccountOverage,
  AccountRoutePool,
  AccountRoutingCapacity,
  AccountRoutingGauge,
  Agent,
  OrchestratorConfig,
  PluginRegistry,
  Session,
  UsageDial,
  UsageSnapshot,
} from "./types.js";

const CAPACITY_STATE_VERSION = 2;

export interface AccountCapacityState {
  version: number;
  accountId: string;
  consumed: number;
  windowStartedAt: string | null;
  overageConsumed: number;
  updatedAt: string;
  usageSnapshot: UsageSnapshot | null;
}

function defaultState(accountId: string): AccountCapacityState {
  return {
    version: CAPACITY_STATE_VERSION,
    accountId,
    consumed: 0,
    windowStartedAt: null,
    overageConsumed: 0,
    updatedAt: new Date().toISOString(),
    usageSnapshot: null,
  };
}

function isUsageDialKind(value: unknown): value is UsageDial["kind"] {
  return value === "percent_used" || value === "percent_remaining" || value === "absolute";
}

function isUsageDialStatus(value: unknown): value is UsageDial["status"] {
  return value === "available" || value === "unavailable" || value === "unlimited";
}

function isUsageDial(value: unknown): value is UsageDial {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<UsageDial>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    isUsageDialKind(candidate.kind) &&
    isUsageDialStatus(candidate.status) &&
    typeof candidate.displayValue === "string"
  );
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<UsageSnapshot>;
  return (
    (candidate.provider === "codex" || candidate.provider === "claude-code") &&
    typeof candidate.capturedAt === "string" &&
    Array.isArray(candidate.dials) &&
    candidate.dials.every((dial) => isUsageDial(dial))
  );
}

function parseAccountCapacityState(value: unknown, accountId: string): AccountCapacityState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return defaultState(accountId);
  }

  const candidate = value as Partial<AccountCapacityState> & {
    usageSnapshot?: unknown;
  };

  return {
    version: typeof candidate.version === "number" ? candidate.version : CAPACITY_STATE_VERSION,
    accountId: typeof candidate.accountId === "string" ? candidate.accountId : accountId,
    consumed: typeof candidate.consumed === "number" ? candidate.consumed : 0,
    windowStartedAt:
      typeof candidate.windowStartedAt === "string" || candidate.windowStartedAt === null
        ? candidate.windowStartedAt
        : null,
    overageConsumed: typeof candidate.overageConsumed === "number" ? candidate.overageConsumed : 0,
    updatedAt:
      typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
    usageSnapshot: isUsageSnapshot(candidate.usageSnapshot) ? candidate.usageSnapshot : null,
  };
}

export async function readCapacityState(accountId: string): Promise<AccountCapacityState> {
  const filePath = getAccountCapacityFile(accountId);
  try {
    const raw = await readFile(filePath, "utf-8");
    return parseAccountCapacityState(JSON.parse(raw) as unknown, accountId);
  } catch {
    return defaultState(accountId);
  }
}

export async function writeCapacityState(state: AccountCapacityState): Promise<void> {
  const filePath = getAccountCapacityFile(state.accountId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function incrementAccountConsumed(accountId: string): Promise<void> {
  const state = await readCapacityState(accountId);
  const now = new Date().toISOString();

  state.consumed += 1;
  state.updatedAt = now;
  if (!state.windowStartedAt) {
    state.windowStartedAt = now;
  }

  await writeCapacityState(state);
}

export async function calibrateAccountConsumed(
  accountId: string,
  externalConsumed: number,
): Promise<void> {
  const state = await readCapacityState(accountId);
  if (externalConsumed > state.consumed) {
    state.consumed = externalConsumed;
    state.updatedAt = new Date().toISOString();
    await writeCapacityState(state);
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function computeWindowResetIn(windowStartedAt: string | null, windowHours: number): string | null {
  if (!windowStartedAt) return null;
  const startMs = new Date(windowStartedAt).getTime();
  const windowMs = windowHours * 3600_000;
  const resetAt = startMs + windowMs;
  const remaining = resetAt - Date.now();
  if (remaining <= 0) return "now";
  return formatDuration(remaining);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function gaugeFromDial(dial: UsageDial | undefined): AccountRoutingGauge | null {
  if (!dial || dial.value === null) {
    return null;
  }

  let percentUsed: number | null = null;
  let percentRemaining: number | null = null;

  switch (dial.kind) {
    case "percent_used":
      percentUsed = clampPercent(dial.value);
      percentRemaining = clampPercent(100 - dial.value);
      break;
    case "percent_remaining":
      percentRemaining = clampPercent(dial.value);
      percentUsed = clampPercent(100 - dial.value);
      break;
    case "absolute":
      if (typeof dial.maxValue === "number" && dial.maxValue > 0) {
        percentUsed = clampPercent((dial.value / dial.maxValue) * 100);
        percentRemaining = clampPercent(100 - percentUsed);
      }
      break;
  }

  return {
    dialId: dial.id,
    label: dial.label,
    percentUsed,
    percentRemaining,
    resetsAt: dial.resetsAt ?? null,
  };
}

function gaugeHasRoom(gauge: AccountRoutingGauge | null): boolean {
  return gauge !== null && gauge.percentRemaining !== null && gauge.percentRemaining > 0;
}

function gaugeUsagePercent(gauge: AccountRoutingGauge | null): number {
  return gauge?.percentUsed ?? 100;
}

function buildRoute(
  available: boolean,
  preferredPool: AccountRoutePool | null,
  reason: string,
): AccountModelRouteAvailability {
  return { available, preferredPool, reason };
}

function buildClaudeRouting(
  baseQuota: AccountBaseQuota,
  overage: AccountOverage | null,
  snapshot: UsageSnapshot | null,
): AccountRoutingCapacity {
  const claudeSnapshot = snapshot?.provider === "claude-code" ? snapshot : null;
  const dialMap = new Map(claudeSnapshot?.dials.map((dial) => [dial.id, dial]));

  const currentSessionGauge = gaugeFromDial(dialMap.get("claude-current-session"));
  const sharedWeeklyGauge = gaugeFromDial(dialMap.get("claude-weekly-all-models"));
  const sonnetWeeklyGauge = gaugeFromDial(dialMap.get("claude-weekly-sonnet-only"));

  const shortWindowAvailable = currentSessionGauge ? gaugeHasRoom(currentSessionGauge) : true;
  const sharedQuotaAvailable = baseQuota.estimatedTotal === 0 || baseQuota.percentRemaining > 0;
  const sharedWeeklyAvailable = sharedWeeklyGauge
    ? gaugeHasRoom(sharedWeeklyGauge)
    : sharedQuotaAvailable;
  const sharedAvailable = shortWindowAvailable && sharedWeeklyAvailable;
  const sonnetDedicatedAvailable = gaugeHasRoom(sonnetWeeklyGauge);
  const overageAvailable = overage !== null && overage.enabled && overage.remaining > 0;

  const sonnetRoute = sonnetDedicatedAvailable
    ? buildRoute(true, "sonnet-only", "Uses dedicated Sonnet pool")
    : sharedAvailable
      ? buildRoute(true, "shared", "Uses shared Claude pool")
      : overageAvailable
        ? buildRoute(true, "overage", "Uses configured overage budget")
        : buildRoute(false, null, "Claude shared and Sonnet pools are exhausted");

  const sharedRoute = sharedAvailable
    ? buildRoute(true, "shared", "Uses shared Claude pool")
    : overageAvailable
      ? buildRoute(true, "overage", "Uses configured overage budget")
      : buildRoute(false, null, "Shared Claude pool is exhausted");

  return {
    currentSessionGauge,
    sharedWeeklyGauge,
    sonnetWeeklyGauge,
    byModel: {
      sonnet: sonnetRoute,
      opus: sharedRoute,
      haiku: sharedRoute,
      unknown: sharedRoute,
    },
  };
}

function computeStatus(
  percentRemaining: number,
  overage: AccountOverage | null,
  routing: AccountRoutingCapacity | null,
): AccountCapacityStatus {
  if (routing) {
    const routes = Object.values(routing.byModel).filter((route) => route.available);
    if (
      routes.some(
        (route) => route.preferredPool === "shared" || route.preferredPool === "sonnet-only",
      )
    ) {
      return "available";
    }
    if (routes.some((route) => route.preferredPool === "overage")) {
      return "overage-only";
    }
    return "fully-exhausted";
  }

  const hasQuota = percentRemaining > 0;
  const hasOverage = overage !== null && overage.enabled && overage.remaining > 0;

  if (hasQuota) return "available";
  if (!hasQuota && hasOverage) return "overage-only";
  if (!hasQuota && !hasOverage) return "fully-exhausted";
  return "quota-exhausted";
}

export function computeAccountCapacity(
  accountId: string,
  config: AccountConfig,
  state: AccountCapacityState,
  activeSessions: number,
): AccountCapacity {
  const windowHours = config.baseQuota?.windowHours ?? 5;
  const estimatedTotal = config.baseQuota?.estimatedTotal ?? 0;

  let effectiveConsumed = state.consumed;
  if (state.windowStartedAt) {
    const windowMs = windowHours * 3600_000;
    const elapsed = Date.now() - new Date(state.windowStartedAt).getTime();
    if (elapsed >= windowMs) {
      effectiveConsumed = 0;
    }
  }

  const remaining = Math.max(0, estimatedTotal - effectiveConsumed);
  const percentRemaining =
    estimatedTotal > 0 ? Math.round((remaining / estimatedTotal) * 100) : 100;

  const baseQuota = {
    estimatedTotal,
    consumed: effectiveConsumed,
    remaining,
    percentRemaining,
    windowResetIn: computeWindowResetIn(state.windowStartedAt, windowHours),
  };

  let overage: AccountOverage | null = null;
  if (config.overage?.enabled) {
    const spendCap = config.overage.spendCap ?? 0;
    const overageConsumed = state.overageConsumed;
    overage = {
      enabled: true,
      type: config.overage.type ?? "credits",
      consumed: overageConsumed,
      spendCap,
      remaining: Math.max(0, spendCap - overageConsumed),
    };
  }

  const routing =
    config.agent === "claude-code"
      ? buildClaudeRouting(baseQuota, overage, state.usageSnapshot)
      : null;
  const status = computeStatus(percentRemaining, overage, routing);

  return {
    accountId,
    agent: config.agent,
    model: config.model ?? null,
    baseQuota,
    overage,
    activeSessions,
    status,
    usageSnapshot: state.usageSnapshot,
    routing,
  };
}

export function getEffectiveAccounts(config: OrchestratorConfig): Record<string, AccountConfig> {
  const explicit = config.accounts ?? {};
  const agentsCovered = new Set(Object.values(explicit).map((account) => account.agent));

  const implicit: Record<string, AccountConfig> = {};
  for (const project of Object.values(config.projects)) {
    const agentName = project.agent ?? config.defaults.agent;
    if (!agentsCovered.has(agentName)) {
      implicit[agentName] = { agent: agentName };
      agentsCovered.add(agentName);
    }
  }

  return { ...implicit, ...explicit };
}

export function resolveAccountForProject(
  config: OrchestratorConfig,
  projectId: string,
  opts?: { agent?: string },
): string {
  const project = config.projects[projectId];
  const agentName = opts?.agent ?? project?.agent ?? config.defaults.agent;

  if (config.accounts) {
    for (const [accountId, accountConfig] of Object.entries(config.accounts)) {
      if (accountConfig.agent === agentName) {
        return accountId;
      }
    }
  }

  return agentName;
}

function isSessionCapacityActive(session: Session): boolean {
  return (
    session.activity !== "exited" &&
    !["cleanup", "done", "killed", "merged", "terminated"].includes(session.status)
  );
}

export function getActiveSessionsByAccount(
  config: OrchestratorConfig,
  sessions: Session[],
): Map<string, number> {
  const activeSessionsByAccount = new Map<string, number>();

  for (const session of sessions) {
    if (!isSessionCapacityActive(session)) {
      continue;
    }

    const agentName =
      session.metadata["agent"] ??
      config.projects[session.projectId]?.agent ??
      config.defaults.agent;
    const accountId =
      session.metadata["accountId"] ??
      resolveAccountForProject(config, session.projectId, { agent: agentName });
    activeSessionsByAccount.set(accountId, (activeSessionsByAccount.get(accountId) ?? 0) + 1);
  }

  return activeSessionsByAccount;
}

function parseSnapshotTime(snapshot: UsageSnapshot): number {
  const parsed = Date.parse(snapshot.capturedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function mergeUsageSnapshots(snapshots: UsageSnapshot[]): UsageSnapshot | null {
  if (snapshots.length === 0) return null;

  let latestSnapshot = snapshots[0];
  const dialEntries = new Map<string, { dial: UsageDial; timestamp: number }>();

  for (const snapshot of snapshots) {
    const timestamp = parseSnapshotTime(snapshot);
    if (timestamp >= parseSnapshotTime(latestSnapshot)) {
      latestSnapshot = snapshot;
    }

    for (const dial of snapshot.dials) {
      const existing = dialEntries.get(dial.id);
      if (!existing || timestamp >= existing.timestamp) {
        dialEntries.set(dial.id, { dial, timestamp });
      }
    }
  }

  return {
    provider: latestSnapshot.provider,
    plan: latestSnapshot.plan ?? null,
    capturedAt: latestSnapshot.capturedAt,
    dials: Array.from(dialEntries.values()).map(({ dial }) => dial),
  };
}

export async function persistAccountUsageSnapshot(
  accountId: string,
  snapshot: UsageSnapshot,
): Promise<void> {
  const state = await readCapacityState(accountId);
  const merged = mergeUsageSnapshots(
    [state.usageSnapshot, snapshot].filter((entry): entry is UsageSnapshot => entry !== null),
  );

  state.usageSnapshot = merged;
  state.updatedAt = new Date().toISOString();
  await writeCapacityState(state);
}

export async function refreshAccountUsageSnapshots(
  config: OrchestratorConfig,
  registry: PluginRegistry,
  sessions: Session[],
): Promise<void> {
  const snapshotsByAccount = new Map<string, UsageSnapshot[]>();

  await Promise.all(
    sessions.filter(isSessionCapacityActive).map(async (session) => {
      const agentName =
        session.metadata["agent"] ??
        config.projects[session.projectId]?.agent ??
        config.defaults.agent;

      let agent: Agent | null;
      try {
        agent = registry.get<Agent>("agent", agentName);
      } catch {
        return;
      }

      if (!agent || !agent.getUsageSnapshot) {
        return;
      }

      const snapshot = await agent.getUsageSnapshot(session).catch(() => null);
      if (!snapshot) {
        return;
      }

      const accountId =
        session.metadata["accountId"] ??
        resolveAccountForProject(config, session.projectId, { agent: agentName });
      const snapshots = snapshotsByAccount.get(accountId) ?? [];
      snapshots.push(snapshot);
      snapshotsByAccount.set(accountId, snapshots);
    }),
  );

  await Promise.all(
    Array.from(snapshotsByAccount.entries()).map(async ([accountId, snapshots]) => {
      const merged = mergeUsageSnapshots(snapshots);
      if (!merged) {
        return;
      }
      await persistAccountUsageSnapshot(accountId, merged);
    }),
  );
}

export function detectAccountModelFamily(model: string | null | undefined): AccountModelFamily {
  const normalized = model?.toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  return "unknown";
}

function detectRequestedModelFamily(
  agentName: string,
  model: string | null | undefined,
): AccountModelFamily {
  const family = detectAccountModelFamily(model);
  if (family !== "unknown") {
    return family;
  }
  return agentName === "claude-code" ? "sonnet" : "unknown";
}

function routeForModel(
  capacity: AccountCapacity,
  modelFamily: AccountModelFamily,
): AccountModelRouteAvailability {
  const route = capacity.routing?.byModel[modelFamily];
  if (route) {
    return route;
  }

  if (capacity.status === "available") {
    return buildRoute(true, "shared", "Uses configured account quota");
  }
  if (capacity.status === "overage-only") {
    return buildRoute(true, "overage", "Uses configured overage budget");
  }
  return buildRoute(false, null, "Account has no remaining quota");
}

export interface AutoRouteResult {
  accountId: string;
  agent: string;
  reason: string;
}

export interface AutoRouteRejection {
  reason: string;
  recoveryEstimates: Array<{ accountId: string; agent: string; resetIn: string | null }>;
}

interface AutoRouteRejectionDetail {
  accountId: string;
  agent: string;
  status: AccountCapacityStatus;
  resetIn: string | null;
}

export class AutoRouteNoCapacityError extends Error {
  readonly rejection: AutoRouteRejection;
  readonly details: AutoRouteRejectionDetail[];

  constructor(rejection: AutoRouteRejection, details: AutoRouteRejectionDetail[]) {
    super(formatAutoRouteRejectionMessage(rejection, details));
    this.name = "AutoRouteNoCapacityError";
    this.rejection = rejection;
    this.details = details;
  }
}

function formatAutoRouteRejectionMessage(
  rejection: AutoRouteRejection,
  details: AutoRouteRejectionDetail[],
): string {
  if (details.length === 0) {
    return `No capacity available for routing\n\n  ${rejection.reason}`;
  }

  const accountWidth = Math.max(
    "Account".length,
    ...details.map((entry) => entry.accountId.length),
  );
  const agentWidth = Math.max("Agent".length, ...details.map((entry) => entry.agent.length));
  const statusWidth = Math.max("Status".length, ...details.map((entry) => entry.status.length));
  const resetWidth = Math.max(
    "Resets In".length,
    ...details.map((entry) => (entry.resetIn ?? "-").length),
  );

  const header = [
    "  ",
    "Account".padEnd(accountWidth),
    "  ",
    "Agent".padEnd(agentWidth),
    "  ",
    "Status".padEnd(statusWidth),
    "  ",
    "Resets In".padEnd(resetWidth),
  ].join("");

  const rows = details.map((entry) =>
    [
      "  ",
      entry.accountId.padEnd(accountWidth),
      "  ",
      entry.agent.padEnd(agentWidth),
      "  ",
      entry.status.padEnd(statusWidth),
      "  ",
      (entry.resetIn ?? "-").padEnd(resetWidth),
    ].join(""),
  );

  return [
    "No capacity available for routing",
    "",
    header,
    ...rows,
    "",
    "  Tip: Try again when quotas reset, or adjust routing.extraUsagePolicy to 'aggressive' to use overage budgets.",
  ].join("\n");
}

export function scoreAccountForModel(
  capacity: AccountCapacity,
  modelFamily: AccountModelFamily,
): number {
  const route = routeForModel(capacity, modelFamily);
  if (!route.available || route.preferredPool === null) {
    return Number.NEGATIVE_INFINITY;
  }

  let poolBase = 0;
  let usagePenalty = 0;

  switch (route.preferredPool) {
    case "sonnet-only":
      poolBase = 300;
      usagePenalty = gaugeUsagePercent(capacity.routing?.sonnetWeeklyGauge ?? null);
      break;
    case "shared": {
      poolBase = 200;
      const sharedPenalties = [
        gaugeUsagePercent(capacity.routing?.currentSessionGauge ?? null),
        gaugeUsagePercent(capacity.routing?.sharedWeeklyGauge ?? null),
        100 - capacity.baseQuota.percentRemaining,
      ];
      usagePenalty = Math.max(...sharedPenalties);
      break;
    }
    case "overage":
      poolBase = 100;
      usagePenalty =
        capacity.overage && capacity.overage.spendCap > 0
          ? (capacity.overage.consumed / capacity.overage.spendCap) * 100
          : 100;
      break;
  }

  return poolBase - usagePenalty - capacity.activeSessions * 5;
}

function dedupeAgentOrder(seed: string[], allAgents: string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const agent of [...seed, ...allAgents]) {
    if (seen.has(agent)) {
      continue;
    }
    seen.add(agent);
    ordered.push(agent);
  }

  return ordered;
}

function getRoutingAgentOrder(
  config: OrchestratorConfig,
  allAgents: string[],
  opts?: { taskType?: string; prefer?: string },
): string[] {
  const configuredTaskRouting = config.routing?.taskRouting ?? {};
  const taskRoute =
    opts?.taskType && configuredTaskRouting[opts.taskType]
      ? configuredTaskRouting[opts.taskType]
      : (configuredTaskRouting.default ?? allAgents);
  const preferred = opts?.prefer ? [opts.prefer] : [];

  return dedupeAgentOrder([...preferred, ...taskRoute], allAgents);
}

function canUseCapacity(capacity: AccountCapacity, allowOverage: boolean): boolean {
  if (capacity.status === "available") {
    return true;
  }
  if (!allowOverage) {
    return false;
  }
  return capacity.status === "overage-only";
}

async function selectForAgent(
  agentName: string,
  activeSessionsByAccount: Map<string, number>,
  effectiveAccounts: Record<string, AccountConfig>,
  opts?: { model?: string; allowOverage?: boolean },
): Promise<{ accountId: string; score: number } | null> {
  const modelFamily = detectRequestedModelFamily(agentName, opts?.model ?? null);
  const capacities: AccountCapacity[] = [];

  for (const [accountId, accountConfig] of Object.entries(effectiveAccounts)) {
    if (accountConfig.agent !== agentName) {
      continue;
    }

    const state = await readCapacityState(accountId);
    capacities.push(
      computeAccountCapacity(
        accountId,
        accountConfig,
        state,
        activeSessionsByAccount.get(accountId) ?? 0,
      ),
    );
  }

  const scored = capacities
    .filter((capacity) => canUseCapacity(capacity, opts?.allowOverage ?? false))
    .map((capacity) => ({
      accountId: capacity.accountId,
      score: scoreAccountForModel(capacity, modelFamily),
      baseRemaining: capacity.baseQuota.remaining,
      overageRemaining: capacity.overage?.remaining ?? 0,
    }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.baseRemaining !== a.baseRemaining) {
        return b.baseRemaining - a.baseRemaining;
      }
      if (b.overageRemaining !== a.overageRemaining) {
        return b.overageRemaining - a.overageRemaining;
      }
      return a.accountId.localeCompare(b.accountId);
    });

  return scored[0] ?? null;
}

export async function autoSelectAccount(
  config: OrchestratorConfig,
  sessions: Session[],
  opts?: {
    taskType?: string;
    prefer?: string;
    model?: string;
  },
): Promise<AutoRouteResult> {
  const policy = config.routing?.extraUsagePolicy ?? "conservative";
  const effectiveAccounts = getEffectiveAccounts(config);
  const allAgents = Array.from(
    new Set(Object.values(effectiveAccounts).map((account) => account.agent)),
  );
  const agentOrder = getRoutingAgentOrder(config, allAgents, {
    taskType: opts?.taskType,
    prefer: opts?.prefer,
  });
  const activeSessionsByAccount = getActiveSessionsByAccount(config, sessions);
  const allowOverage = policy === "aggressive";

  for (const agentName of agentOrder) {
    const selection = await selectForAgent(agentName, activeSessionsByAccount, effectiveAccounts, {
      model: opts?.model,
      allowOverage,
    });
    if (selection) {
      return {
        accountId: selection.accountId,
        agent: agentName,
        reason:
          policy === "aggressive"
            ? `Selected ${selection.accountId} from ${agentName} using base-or-overage capacity`
            : `Selected ${selection.accountId} from ${agentName} using base quota capacity`,
      };
    }
  }

  if (policy === "conservative") {
    for (const agentName of agentOrder) {
      const selection = await selectForAgent(
        agentName,
        activeSessionsByAccount,
        effectiveAccounts,
        {
          model: opts?.model,
          allowOverage: true,
        },
      );
      if (selection) {
        return {
          accountId: selection.accountId,
          agent: agentName,
          reason: `Selected ${selection.accountId} from ${agentName} using fallback overage capacity`,
        };
      }
    }
  }

  const details: AutoRouteRejectionDetail[] = [];
  for (const [accountId, accountConfig] of Object.entries(effectiveAccounts)) {
    const state = await readCapacityState(accountId);
    const capacity = computeAccountCapacity(
      accountId,
      accountConfig,
      state,
      activeSessionsByAccount.get(accountId) ?? 0,
    );
    details.push({
      accountId,
      agent: accountConfig.agent,
      status: capacity.status,
      resetIn: capacity.baseQuota.windowResetIn,
    });
  }

  details.sort((a, b) => {
    const byAgent = a.agent.localeCompare(b.agent);
    if (byAgent !== 0) return byAgent;
    return a.accountId.localeCompare(b.accountId);
  });

  const rejection: AutoRouteRejection = {
    reason:
      policy === "never"
        ? "No account has base quota remaining and overage is disabled by routing policy"
        : "No account has remaining base quota or overage capacity",
    recoveryEstimates: details.map((entry) => ({
      accountId: entry.accountId,
      agent: entry.agent,
      resetIn: entry.resetIn,
    })),
  };

  throw new AutoRouteNoCapacityError(rejection, details);
}

export async function selectAccountForProject(
  config: OrchestratorConfig,
  projectId: string,
  registry: PluginRegistry,
  sessions: Session[],
  opts?: { agent?: string; model?: string },
): Promise<string> {
  const project = config.projects[projectId];
  const agentName = opts?.agent ?? project?.agent ?? config.defaults.agent;
  const explicitCandidates = Object.entries(config.accounts ?? {})
    .filter(([, accountConfig]) => accountConfig.agent === agentName)
    .map(([accountId]) => accountId);

  if (explicitCandidates.length === 0) {
    return agentName;
  }

  const [firstCandidate] = explicitCandidates;
  if (!firstCandidate) {
    return agentName;
  }

  if (explicitCandidates.length === 1) {
    return firstCandidate;
  }

  await refreshAccountUsageSnapshots(config, registry, sessions);

  const activeSessionsByAccount = getActiveSessionsByAccount(config, sessions);
  const modelFamily = detectRequestedModelFamily(
    agentName,
    opts?.model ?? project?.agentConfig?.model ?? null,
  );

  let bestAccountId = firstCandidate;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const accountId of explicitCandidates) {
    const accountConfig = config.accounts?.[accountId];
    if (!accountConfig) {
      continue;
    }

    const state = await readCapacityState(accountId);
    const capacity = computeAccountCapacity(
      accountId,
      accountConfig,
      state,
      activeSessionsByAccount.get(accountId) ?? 0,
    );
    const score = scoreAccountForModel(capacity, modelFamily);

    if (score > bestScore) {
      bestScore = score;
      bestAccountId = accountId;
    }
  }

  return bestAccountId;
}
