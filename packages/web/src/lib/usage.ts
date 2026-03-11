import {
  getSessionsDir,
  type Agent,
  type CostEstimate,
  type OrchestratorConfig,
  type PluginRegistry,
  type Session,
  type UsageDial,
  type UsageDialKind,
  type UsageProvider,
  type UsageSnapshot,
} from "@syntese/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DashboardUsageResponse,
  DashboardUsageSnapshot,
  DashboardUsageSource,
  SessionUsageResponse,
} from "@/lib/types";
import { resolveProject } from "@/lib/serialize";
import { recordUsageSnapshots, tryBuildEstimatedSnapshot } from "@/lib/usage-history";

interface UsageDialTemplate {
  id: string;
  kind: UsageDialKind;
  label: string;
}

interface SessionUsageSource {
  provider: UsageProvider | null;
  snapshot: UsageSnapshot | null;
  cost: CostEstimate | null;
  projectPath: string | null;
}

const PROVIDER_ORDER: UsageProvider[] = ["codex", "claude-code"];
const USAGE_CACHE_FILE_NAME = "usage-cache.json";
const USAGE_CACHE_VERSION = 1;

interface UsageCacheFile {
  version: number;
  updatedAt: string;
  snapshots: UsageSnapshot[];
}

const DIAL_TEMPLATES: Record<UsageProvider, UsageDialTemplate[]> = {
  codex: [
    { id: "codex-5h", label: "5 hour usage limit", kind: "percent_remaining" },
    { id: "codex-weekly", label: "Weekly usage limit", kind: "percent_remaining" },
    {
      id: "codex-spark-5h",
      label: "GPT-5.3-Codex-Spark 5 hour usage limit",
      kind: "percent_remaining",
    },
    {
      id: "codex-spark-weekly",
      label: "GPT-5.3-Codex-Spark Weekly usage limit",
      kind: "percent_remaining",
    },
    { id: "codex-code-review", label: "Code review", kind: "percent_remaining" },
    { id: "codex-credits", label: "Credits remaining", kind: "absolute" },
  ],
  "claude-code": [
    {
      id: "claude-current-session",
      label: "Current session usage",
      kind: "percent_used",
    },
    {
      id: "claude-weekly-all-models",
      label: "Weekly limits - All models",
      kind: "percent_used",
    },
  ],
};

function providerForAgentName(agentName: string | undefined): UsageProvider | null {
  switch (agentName) {
    case "codex":
      return "codex";
    case "claude-code":
      return "claude-code";
    default:
      return null;
  }
}

function makeUnavailableDial(template: UsageDialTemplate): UsageDial {
  return {
    id: template.id,
    label: template.label,
    kind: template.kind,
    status: "unavailable",
    value: null,
    maxValue: template.kind === "absolute" ? null : 100,
    displayValue: "--",
    resetsAt: null,
  };
}

function normalizeSessionSnapshot(
  provider: UsageProvider,
  snapshot: UsageSnapshot | null,
): UsageSnapshot {
  const dialMap = new Map(snapshot?.dials.map((dial) => [dial.id, dial]));

  return {
    provider,
    plan: snapshot?.plan ?? null,
    capturedAt: snapshot?.capturedAt ?? new Date().toISOString(),
    dials: DIAL_TEMPLATES[provider].map(
      (template) => dialMap.get(template.id) ?? makeUnavailableDial(template),
    ),
  };
}

function normalizeDashboardSnapshot(
  provider: UsageProvider,
  snapshot: UsageSnapshot | null,
  source: DashboardUsageSource,
): DashboardUsageSnapshot {
  const dialMap = new Map(snapshot?.dials.map((dial) => [dial.id, dial]));

  return {
    provider,
    plan: snapshot?.plan ?? null,
    capturedAt: snapshot?.capturedAt ?? null,
    source,
    dials: DIAL_TEMPLATES[provider].map(
      (template) => dialMap.get(template.id) ?? makeUnavailableDial(template),
    ),
  };
}

function parseSnapshotTime(snapshot: UsageSnapshot): number {
  const parsed = Date.parse(snapshot.capturedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function mergeSnapshots(provider: UsageProvider, snapshots: UsageSnapshot[]): UsageSnapshot | null {
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
    provider,
    plan: latestSnapshot.plan ?? null,
    capturedAt: latestSnapshot.capturedAt,
    dials: Array.from(dialEntries.values()).map(({ dial }) => dial),
  };
}

function resolveAgent(
  session: Session,
  config: OrchestratorConfig,
  registry: PluginRegistry,
): { agent: Agent | null; provider: UsageProvider | null; projectPath: string | null } {
  const project = resolveProject(session, config.projects);
  const agentName = session.metadata["agent"] ?? project?.agent ?? config.defaults.agent;
  const provider = providerForAgentName(agentName);

  try {
    return {
      agent: registry.get<Agent>("agent", agentName),
      provider,
      projectPath: project?.path ?? null,
    };
  } catch {
    return { agent: null, provider, projectPath: project?.path ?? null };
  }
}

async function loadSessionUsageSource(
  session: Session,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  opts?: { includeCost?: boolean },
): Promise<SessionUsageSource> {
  const { agent, provider, projectPath } = resolveAgent(session, config, registry);
  if (!agent || !provider) {
    return { provider: null, snapshot: null, cost: null, projectPath };
  }

  const snapshotPromise = agent.getUsageSnapshot
    ? agent.getUsageSnapshot(session).catch(() => null)
    : Promise.resolve<UsageSnapshot | null>(null);

  const costPromise =
    opts?.includeCost === true
      ? session.agentInfo?.cost
        ? Promise.resolve(session.agentInfo.cost)
        : agent
            .getSessionInfo(session)
            .then((info) => info?.cost ?? null)
            .catch(() => null)
      : Promise.resolve<CostEstimate | null>(null);

  const [snapshot, cost] = await Promise.all([snapshotPromise, costPromise]);
  return { provider, snapshot, cost, projectPath };
}

function isUsageProvider(value: unknown): value is UsageProvider {
  return value === "codex" || value === "claude-code";
}

function isUsageDial(value: unknown): value is UsageDial {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<UsageDial>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    (candidate.kind === "percent_used" ||
      candidate.kind === "percent_remaining" ||
      candidate.kind === "absolute") &&
    (candidate.status === "available" ||
      candidate.status === "unavailable" ||
      candidate.status === "unlimited") &&
    typeof candidate.displayValue === "string"
  );
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<UsageSnapshot>;
  return (
    isUsageProvider(candidate.provider) &&
    typeof candidate.capturedAt === "string" &&
    Array.isArray(candidate.dials) &&
    candidate.dials.every((dial) => isUsageDial(dial))
  );
}

function parseUsageCache(raw: string): UsageCacheFile | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const candidate = parsed as Partial<UsageCacheFile>;
    if (
      !Array.isArray(candidate.snapshots) ||
      !candidate.snapshots.every((snapshot) => isUsageSnapshot(snapshot))
    ) {
      return null;
    }

    return {
      version: typeof candidate.version === "number" ? candidate.version : 0,
      updatedAt:
        typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
      snapshots: candidate.snapshots,
    };
  } catch {
    return null;
  }
}

function getUsageCachePath(config: OrchestratorConfig, projectPath: string): string {
  return join(getSessionsDir(config.configPath, projectPath), USAGE_CACHE_FILE_NAME);
}

async function readProjectUsageCache(
  config: OrchestratorConfig,
  projectPath: string,
): Promise<UsageSnapshot[]> {
  try {
    const raw = await readFile(getUsageCachePath(config, projectPath), "utf-8");
    const parsed = parseUsageCache(raw);
    return parsed?.snapshots ?? [];
  } catch {
    return [];
  }
}

function mergeSnapshotListByProvider(snapshots: UsageSnapshot[]): UsageSnapshot[] {
  return PROVIDER_ORDER.flatMap((provider) => {
    const merged = mergeSnapshots(
      provider,
      snapshots.filter((snapshot) => snapshot.provider === provider),
    );
    return merged ? [merged] : [];
  });
}

async function persistProjectUsageCache(
  config: OrchestratorConfig,
  projectPath: string,
  liveSnapshots: UsageSnapshot[],
): Promise<void> {
  if (liveSnapshots.length === 0) {
    return;
  }

  const existingSnapshots = await readProjectUsageCache(config, projectPath);
  const nextByProvider = new Map<UsageProvider, UsageSnapshot>();

  for (const snapshot of mergeSnapshotListByProvider(existingSnapshots)) {
    nextByProvider.set(snapshot.provider, snapshot);
  }

  for (const snapshot of mergeSnapshotListByProvider(liveSnapshots)) {
    nextByProvider.set(snapshot.provider, snapshot);
  }

  const cachePath = getUsageCachePath(config, projectPath);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(
    cachePath,
    JSON.stringify(
      {
        version: USAGE_CACHE_VERSION,
        updatedAt: new Date().toISOString(),
        snapshots: PROVIDER_ORDER.flatMap((provider) => {
          const snapshot = nextByProvider.get(provider);
          return snapshot ? [snapshot] : [];
        }),
      } satisfies UsageCacheFile,
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

async function persistLiveUsageCaches(
  config: OrchestratorConfig,
  sessionUsage: SessionUsageSource[],
): Promise<void> {
  const liveSnapshotsByProject = new Map<string, UsageSnapshot[]>();

  for (const entry of sessionUsage) {
    if (!entry.projectPath || !entry.snapshot) {
      continue;
    }

    const projectSnapshots = liveSnapshotsByProject.get(entry.projectPath) ?? [];
    projectSnapshots.push(entry.snapshot);
    liveSnapshotsByProject.set(entry.projectPath, projectSnapshots);
  }

  await Promise.all(
    Array.from(liveSnapshotsByProject.entries()).map(([projectPath, snapshots]) =>
      persistProjectUsageCache(config, projectPath, snapshots),
    ),
  );
}

async function loadCachedUsageSnapshots(
  config: OrchestratorConfig,
): Promise<Map<UsageProvider, UsageSnapshot[]>> {
  const snapshotsByProvider = new Map<UsageProvider, UsageSnapshot[]>();

  await Promise.all(
    Object.values(config.projects).map(async (project) => {
      const cachedSnapshots = await readProjectUsageCache(config, project.path);
      for (const snapshot of cachedSnapshots) {
        const providerSnapshots = snapshotsByProvider.get(snapshot.provider) ?? [];
        providerSnapshots.push(snapshot);
        snapshotsByProvider.set(snapshot.provider, providerSnapshots);
      }
    }),
  );

  return snapshotsByProvider;
}

export async function getDashboardUsage(
  sessions: Session[],
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<DashboardUsageResponse> {
  const workerSessions = sessions.filter(
    (session) => !session.id.endsWith("-orchestrator") && session.activity !== "exited",
  );
  const sessionUsage = await Promise.all(
    workerSessions.map((session) => loadSessionUsageSource(session, config, registry)),
  );

  // Persist live snapshots to cache and record them in the usage history.
  await persistLiveUsageCaches(config, sessionUsage);
  const liveSnapshots = sessionUsage
    .map((entry) => entry.snapshot)
    .filter((s): s is UsageSnapshot => s !== null);
  void recordUsageSnapshots(liveSnapshots).catch(() => undefined);

  const cachedSnapshots = await loadCachedUsageSnapshots(config);

  const mergedSnapshots = await Promise.all(
    PROVIDER_ORDER.map(async (provider) => {
      const providerSnapshots = sessionUsage
        .filter((entry): entry is SessionUsageSource & { provider: UsageProvider } => {
          return entry.provider === provider;
        })
        .map((entry) => entry.snapshot)
        .filter((snapshot): snapshot is UsageSnapshot => snapshot !== null);

      const liveSnapshot = mergeSnapshots(provider, providerSnapshots);
      if (liveSnapshot) {
        return normalizeDashboardSnapshot(provider, liveSnapshot, "live");
      }

      const cachedProviderSnapshots = cachedSnapshots.get(provider) ?? [];
      const cachedSnapshot = mergeSnapshots(provider, cachedProviderSnapshots);
      if (cachedSnapshot) {
        // Attempt to upgrade cached snapshot to an estimated one.
        const estimatedSnapshot = await tryBuildEstimatedSnapshot(cachedSnapshot).catch(
          () => null,
        );
        if (estimatedSnapshot) {
          return normalizeDashboardSnapshot(provider, estimatedSnapshot, "estimated");
        }
        return normalizeDashboardSnapshot(provider, cachedSnapshot, "cached");
      }

      return normalizeDashboardSnapshot(provider, null, "empty");
    }),
  );

  return {
    updatedAt: new Date().toISOString(),
    snapshots: mergedSnapshots,
  };
}

export async function getSessionUsage(
  session: Session,
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<SessionUsageResponse> {
  const source = await loadSessionUsageSource(session, config, registry, { includeCost: true });

  return {
    sessionId: session.id,
    provider: source.provider,
    cost: source.cost,
    snapshot: source.provider ? normalizeSessionSnapshot(source.provider, source.snapshot) : null,
  };
}
