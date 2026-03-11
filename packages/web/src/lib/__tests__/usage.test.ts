import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSessionsDir,
  type Agent,
  type OrchestratorConfig,
  type PluginRegistry,
  type Session,
  type UsageSnapshot,
} from "@syntese/core";
import { getDashboardUsage } from "../usage";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "app",
    status: "working",
    activity: "active",
    branch: "feat/26",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/app-1",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2026-03-10T12:00:00.000Z"),
    lastActivityAt: new Date("2026-03-10T12:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

function makeConfig(configPath: string, projectPaths: Record<string, string>): OrchestratorConfig {
  return {
    configPath,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "codex",
      workspace: "worktree",
      notifiers: [],
    },
    projects: Object.fromEntries(
      Object.entries(projectPaths).map(([projectId, projectPath]) => [
        projectId,
        {
          name: projectId,
          repo: `acme/${projectId}`,
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: projectId,
        },
      ]),
    ),
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
  };
}

function makeRegistry(agent: Agent): PluginRegistry {
  return {
    get: vi.fn((_slot: string, name: string) => {
      if (name === "codex") {
        return agent;
      }
      throw new Error(`Unknown plugin: ${name}`);
    }),
  } as unknown as PluginRegistry;
}

async function writeUsageCache(
  config: OrchestratorConfig,
  projectPath: string,
  snapshots: UsageSnapshot[],
): Promise<void> {
  const sessionsDir = getSessionsDir(config.configPath, projectPath);
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "usage-cache.json"),
    JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-03-10T12:00:00.000Z",
        snapshots,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

describe("getDashboardUsage", () => {
  const originalHome = process.env["HOME"];
  let tempHome: string;
  let configPath: string;
  let config: OrchestratorConfig;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ao-usage-"));
    process.env["HOME"] = tempHome;

    const configDir = join(tempHome, "config");
    const appPath = join(tempHome, "repos", "app");
    const docsPath = join(tempHome, "repos", "docs");

    await mkdir(configDir, { recursive: true });
    await mkdir(appPath, { recursive: true });
    await mkdir(docsPath, { recursive: true });

    configPath = join(configDir, "syntese.yaml");
    await writeFile(configPath, "projects: {}\n", "utf-8");

    config = makeConfig(configPath, { app: appPath, docs: docsPath });
  });

  afterEach(async () => {
    if (originalHome) {
      process.env["HOME"] = originalHome;
    } else {
      delete process.env["HOME"];
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("persists live snapshots and falls back to cache when a provider has no active session", async () => {
    const codexSnapshot: UsageSnapshot = {
      provider: "codex",
      plan: "ChatGPT Pro",
      capturedAt: "2026-03-10T12:00:00.000Z",
      dials: [
        {
          id: "codex-5h",
          label: "5 hour usage limit",
          kind: "percent_remaining",
          status: "available",
          value: 84,
          maxValue: 100,
          displayValue: "84%",
          resetsAt: "2026-03-10T15:00:00.000Z",
        },
      ],
    };

    await writeUsageCache(config, config.projects["docs"]!.path, [
      {
        provider: "claude-code",
        plan: "Pro",
        capturedAt: "2026-03-10T10:00:00.000Z",
        dials: [
          {
            id: "claude-current-session",
            label: "Current session usage",
            kind: "percent_used",
            status: "available",
            value: 25,
            maxValue: 100,
            displayValue: "25%",
            resetsAt: "2026-03-10T15:00:00.000Z",
          },
        ],
      },
    ]);

    const agent = {
      getUsageSnapshot: vi.fn(async () => codexSnapshot),
    } as unknown as Agent;
    const registry = makeRegistry(agent);

    const liveResponse = await getDashboardUsage(
      [makeSession({ projectId: "app", metadata: { agent: "codex" } })],
      config,
      registry,
    );

    expect(liveResponse.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex",
          source: "live",
          capturedAt: "2026-03-10T12:00:00.000Z",
        }),
        expect.objectContaining({
          provider: "claude-code",
          source: "cached",
          capturedAt: "2026-03-10T10:00:00.000Z",
        }),
      ]),
    );

    const codexCachePath = join(
      getSessionsDir(config.configPath, config.projects["app"]!.path),
      "usage-cache.json",
    );
    const persistedCache = JSON.parse(await readFile(codexCachePath, "utf-8")) as {
      snapshots: UsageSnapshot[];
    };
    expect(persistedCache.snapshots[0]?.provider).toBe("codex");

    const cachedResponse = await getDashboardUsage([], config, registry);
    expect(cachedResponse.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "codex", source: "cached" }),
        expect.objectContaining({ provider: "claude-code", source: "cached" }),
      ]),
    );
  });

  it("returns empty snapshots when no live or cached data exists", async () => {
    const agent = {
      getUsageSnapshot: vi.fn(async () => null),
    } as unknown as Agent;

    const response = await getDashboardUsage([], config, makeRegistry(agent));

    expect(response.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "codex",
          source: "empty",
          capturedAt: null,
        }),
        expect.objectContaining({
          provider: "claude-code",
          source: "empty",
          capturedAt: null,
        }),
      ]),
    );
  });
});
