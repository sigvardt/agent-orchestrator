import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateConfig } from "../config.js";
import { autoSelectAccount, AutoRouteNoCapacityError } from "../account-capacity.js";
import { createSessionManager } from "../session-manager.js";
import { getAccountCapacityFile, getAccountDataDir, getSessionsDir } from "../paths.js";
import { readMetadataRaw } from "../metadata.js";
import type {
  Agent,
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  RuntimeHandle,
} from "../types.js";

function makeConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  const tmpPath = join(tmpdir(), `ao-auto-routing-${randomUUID()}`, "syntese.yaml");
  return {
    configPath: tmpPath,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "mock-runtime",
      agent: "codex",
      workspace: "mock-workspace",
      notifiers: ["desktop"],
    },
    projects: {
      app: {
        name: "App",
        repo: "org/app",
        path: join(tmpdir(), `ao-auto-routing-repo-${randomUUID()}`),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
        tracker: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    progressChecks: {
      enabled: false,
      intervalMinutes: 10,
      terminalLines: 50,
      signals: {
        errorPatterns: [],
        testPatterns: [],
        livePatterns: [],
      },
    },
    ...overrides,
  };
}

function writeCapacityState(accountId: string, consumed: number, overageConsumed = 0): void {
  const filePath = getAccountCapacityFile(accountId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        version: 2,
        accountId,
        consumed,
        overageConsumed,
        windowStartedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        usageSnapshot: null,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("auto-routing config", () => {
  it("parses routing config and applies field defaults", () => {
    const validated = validateConfig({
      projects: {
        app: {
          path: "/tmp/app",
          repo: "org/app",
          defaultBranch: "main",
        },
      },
      routing: {
        mode: "auto",
      },
    });

    expect(validated.routing).toEqual({
      mode: "auto",
      extraUsagePolicy: "conservative",
      taskRouting: {},
    });
  });

  it("keeps backward compatibility when routing is omitted", () => {
    const validated = validateConfig({
      projects: {
        app: {
          path: "/tmp/app",
          repo: "org/app",
          defaultBranch: "main",
        },
      },
    });

    expect(validated.routing).toBeUndefined();
  });
});

describe("autoSelectAccount", () => {
  const touchedAccounts = new Set<string>();

  beforeEach(() => {
    touchedAccounts.clear();
  });

  afterEach(() => {
    for (const accountId of touchedAccounts) {
      rmSync(getAccountDataDir(accountId), { recursive: true, force: true });
    }
  });

  it("picks the highest capacity account within one agent", async () => {
    const config = makeConfig({
      routing: { mode: "auto", extraUsagePolicy: "conservative", taskRouting: {} },
      accounts: {
        "codex-a": {
          agent: "codex",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
        "codex-b": {
          agent: "codex",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
      },
    });

    touchedAccounts.add("codex-a");
    touchedAccounts.add("codex-b");
    writeCapacityState("codex-a", 80);
    writeCapacityState("codex-b", 20);

    const selected = await autoSelectAccount(config, [], { prefer: "codex" });
    expect(selected.accountId).toBe("codex-b");
    expect(selected.agent).toBe("codex");
  });

  it("respects task routing order and prefer override", async () => {
    const config = makeConfig({
      routing: {
        mode: "auto",
        extraUsagePolicy: "conservative",
        taskRouting: {
          frontend: ["claude-code", "codex"],
        },
      },
      accounts: {
        "claude-1": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
        "codex-1": {
          agent: "codex",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
      },
    });

    touchedAccounts.add("claude-1");
    touchedAccounts.add("codex-1");
    writeCapacityState("claude-1", 40);
    writeCapacityState("codex-1", 10);

    const byTaskType = await autoSelectAccount(config, [], { taskType: "frontend" });
    expect(byTaskType.agent).toBe("claude-code");

    const byPrefer = await autoSelectAccount(config, [], {
      taskType: "frontend",
      prefer: "codex",
    });
    expect(byPrefer.agent).toBe("codex");
  });

  it("conservative falls through to other agent base quota before overage", async () => {
    const config = makeConfig({
      routing: {
        mode: "auto",
        extraUsagePolicy: "conservative",
        taskRouting: { default: ["codex", "claude-code"] },
      },
      accounts: {
        "codex-1": {
          agent: "codex",
          baseQuota: { estimatedTotal: 10, windowHours: 5 },
          overage: { enabled: true, type: "credits", spendCap: 10 },
        },
        "claude-1": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
      },
    });

    touchedAccounts.add("codex-1");
    touchedAccounts.add("claude-1");
    writeCapacityState("codex-1", 10);
    writeCapacityState("claude-1", 20);

    const selected = await autoSelectAccount(config, [], { prefer: "codex" });
    expect(selected.accountId).toBe("claude-1");
    expect(selected.agent).toBe("claude-code");
  });

  it("conservative uses overage as fallback when no base quota remains", async () => {
    const config = makeConfig({
      routing: {
        mode: "auto",
        extraUsagePolicy: "conservative",
        taskRouting: { default: ["codex"] },
      },
      accounts: {
        "codex-1": {
          agent: "codex",
          baseQuota: { estimatedTotal: 10, windowHours: 5 },
          overage: { enabled: true, type: "credits", spendCap: 20 },
        },
      },
    });

    touchedAccounts.add("codex-1");
    writeCapacityState("codex-1", 10, 1);

    const selected = await autoSelectAccount(config, []);
    expect(selected.accountId).toBe("codex-1");
    expect(selected.reason).toContain("fallback overage");
  });

  it("aggressive allows overage immediately", async () => {
    const config = makeConfig({
      routing: {
        mode: "auto",
        extraUsagePolicy: "aggressive",
        taskRouting: { default: ["codex", "claude-code"] },
      },
      accounts: {
        "codex-1": {
          agent: "codex",
          baseQuota: { estimatedTotal: 10, windowHours: 5 },
          overage: { enabled: true, type: "credits", spendCap: 20 },
        },
        "claude-1": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
      },
    });

    touchedAccounts.add("codex-1");
    touchedAccounts.add("claude-1");
    writeCapacityState("codex-1", 10, 1);
    writeCapacityState("claude-1", 50);

    const selected = await autoSelectAccount(config, []);
    expect(selected.accountId).toBe("codex-1");
  });

  it("never policy rejects when only overage remains", async () => {
    const config = makeConfig({
      routing: {
        mode: "auto",
        extraUsagePolicy: "never",
        taskRouting: { default: ["codex"] },
      },
      accounts: {
        "codex-1": {
          agent: "codex",
          baseQuota: { estimatedTotal: 10, windowHours: 5 },
          overage: { enabled: true, type: "credits", spendCap: 20 },
        },
      },
    });

    touchedAccounts.add("codex-1");
    writeCapacityState("codex-1", 10, 1);

    await expect(autoSelectAccount(config, [])).rejects.toBeInstanceOf(AutoRouteNoCapacityError);
  });

  it("throws with structured recovery estimates when no capacity exists", async () => {
    const config = makeConfig({
      routing: {
        mode: "auto",
        extraUsagePolicy: "conservative",
        taskRouting: { default: ["codex", "claude-code"] },
      },
      accounts: {
        "codex-1": {
          agent: "codex",
          baseQuota: { estimatedTotal: 1, windowHours: 5 },
          overage: { enabled: false, type: "credits", spendCap: 0 },
        },
        "claude-1": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 1, windowHours: 5 },
          overage: { enabled: false, type: "credits", spendCap: 0 },
        },
      },
    });

    touchedAccounts.add("codex-1");
    touchedAccounts.add("claude-1");
    writeCapacityState("codex-1", 1);
    writeCapacityState("claude-1", 1);

    try {
      await autoSelectAccount(config, []);
      expect.fail("Expected autoSelectAccount to throw when all accounts are exhausted");
    } catch (err) {
      expect(err).toBeInstanceOf(AutoRouteNoCapacityError);
      if (err instanceof AutoRouteNoCapacityError) {
        expect(err.rejection.recoveryEstimates).toHaveLength(2);
        expect(err.message).toContain("No capacity available for routing");
      }
    }
  });

  it("falls through across agent types when preferred agent is exhausted", async () => {
    const config = makeConfig({
      routing: {
        mode: "auto",
        extraUsagePolicy: "conservative",
        taskRouting: { default: ["codex", "claude-code"] },
      },
      accounts: {
        "codex-1": {
          agent: "codex",
          baseQuota: { estimatedTotal: 1, windowHours: 5 },
          overage: { enabled: false, type: "credits", spendCap: 0 },
        },
        "claude-1": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
      },
    });

    touchedAccounts.add("codex-1");
    touchedAccounts.add("claude-1");
    writeCapacityState("codex-1", 1);
    writeCapacityState("claude-1", 5);

    const selected = await autoSelectAccount(config, []);
    expect(selected.agent).toBe("claude-code");
    expect(selected.accountId).toBe("claude-1");
  });
});

describe("session-manager integration with auto routing", () => {
  let tmpRoot: string;
  let config: OrchestratorConfig;
  let mockRuntime: Runtime;
  let codexAgent: Agent;
  let claudeAgent: Agent;
  let registry: PluginRegistry;
  let originalPath: string | undefined;

  function makeHandle(id: string): RuntimeHandle {
    return { id, runtimeName: "mock-runtime", data: {} };
  }

  beforeEach(() => {
    originalPath = process.env.PATH;
    tmpRoot = join(tmpdir(), `ao-auto-routing-integration-${randomUUID()}`);
    mkdirSync(tmpRoot, { recursive: true });
    const configPath = join(tmpRoot, "syntese.yaml");
    writeFileSync(configPath, "projects: {}\n", "utf-8");
    mkdirSync(join(tmpRoot, "repo"), { recursive: true });

    const mockBin = join(tmpRoot, "mock-bin");
    mkdirSync(mockBin, { recursive: true });
    writeFileSync(
      join(mockBin, "codex"),
      '#!/usr/bin/env bash\nif [[ "$1" == "login" && "$2" == "status" ]]; then\n  printf "Logged in as test\\n"\n  exit 0\nfi\nexit 1\n',
      "utf-8",
    );
    writeFileSync(
      join(mockBin, "claude"),
      '#!/usr/bin/env bash\nif [[ "$1" == "auth" && "$2" == "status" && "$3" == "--json" ]]; then\n  printf "{\\"loggedIn\\":true}\\n"\n  exit 0\nfi\nexit 1\n',
      "utf-8",
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    chmodSync(join(mockBin, "codex"), 0o755);
    chmodSync(join(mockBin, "claude"), 0o755);

    config = makeConfig({
      configPath,
      defaults: {
        runtime: "mock-runtime",
        agent: "codex",
        workspace: "mock-workspace",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "App",
          repo: "org/app",
          path: join(tmpRoot, "repo"),
          defaultBranch: "main",
          sessionPrefix: "app",
          agent: "codex",
          scm: { plugin: "github" },
          tracker: { plugin: "github" },
        },
      },
      routing: {
        mode: "auto",
        extraUsagePolicy: "conservative",
        taskRouting: { default: ["codex", "claude-code"] },
      },
      accounts: {
        "codex-1": {
          agent: "codex",
          baseQuota: { estimatedTotal: 1, windowHours: 5 },
          overage: { enabled: false, type: "credits", spendCap: 0 },
        },
        "claude-1": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
      },
    });

    writeCapacityState("codex-1", 1);
    writeCapacityState("claude-1", 5);

    mockRuntime = {
      name: "mock-runtime",
      create: vi.fn().mockResolvedValue(makeHandle("rt-1")),
      destroy: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getOutput: vi.fn().mockResolvedValue(""),
      isAlive: vi.fn().mockResolvedValue(true),
    };

    codexAgent = {
      name: "codex",
      processName: "codex",
      getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
      getEnvironment: vi.fn().mockReturnValue({}),
      detectActivity: vi.fn().mockReturnValue("active"),
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockResolvedValue(null),
    };

    claudeAgent = {
      name: "claude-code",
      processName: "claude",
      getLaunchCommand: vi.fn().mockReturnValue("claude --start"),
      getEnvironment: vi.fn().mockReturnValue({}),
      detectActivity: vi.fn().mockReturnValue("active"),
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockResolvedValue(null),
    };

    registry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") {
          return {
            name: "mock-workspace",
            create: vi.fn().mockResolvedValue({
              path: join(tmpRoot, "repo-wt"),
              branch: "feat/test",
              sessionId: "app-1",
              projectId: "app",
            }),
            destroy: vi.fn().mockResolvedValue(undefined),
            list: vi.fn().mockResolvedValue([]),
          };
        }
        if (slot === "agent") {
          if (name === "codex") return codexAgent;
          if (name === "claude-code") return claudeAgent;
        }
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(getAccountDataDir("codex-1"), { recursive: true, force: true });
    rmSync(getAccountDataDir("claude-1"), { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("switches agent when auto-routing selects a different agent type", async () => {
    const sm = createSessionManager({ config, registry });
    await sm.spawn({ projectId: "app", taskType: "frontend" });

    expect(codexAgent.getLaunchCommand).not.toHaveBeenCalled();
    expect(claudeAgent.getLaunchCommand).toHaveBeenCalled();

    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    const meta = readMetadataRaw(sessionsDir, "app-1");
    expect(meta?.["agent"]).toBe("claude-code");
    expect(meta?.["accountId"]).toBe("claude-1");
  });
});
