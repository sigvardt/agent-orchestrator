import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeAccountCapacity,
  getEffectiveAccounts,
  resolveAccountForProject,
  selectAccountForProject,
  type AccountCapacityState,
  writeCapacityState,
} from "../../src/lib/capacity-store.js";
import type { AccountConfig, OrchestratorConfig, PluginRegistry, UsageSnapshot } from "@syntese/core";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AccountCapacityState> = {}): AccountCapacityState {
  return {
    version: 1,
    accountId: "test-account",
    consumed: 0,
    windowStartedAt: null,
    overageConsumed: 0,
    updatedAt: new Date().toISOString(),
    usageSnapshot: null,
    ...overrides,
  };
}

function makeClaudeUsageSnapshot(dials: UsageSnapshot["dials"]): UsageSnapshot {
  return {
    provider: "claude-code",
    plan: "Max",
    capturedAt: "2026-01-15T12:00:00Z",
    dials,
  };
}

function makeConfig(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    agent: "codex",
    model: "gpt-5.4-xhigh",
    baseQuota: { estimatedTotal: 100, windowHours: 5 },
    ...overrides,
  };
}

function makeOrchestratorConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    configPath: "/tmp/syntese.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
        agentConfig: {},
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    progressChecks: { enabled: false, intervalMinutes: 10, terminalLines: 50, signals: { errorPatterns: [], testPatterns: [], livePatterns: [] } },
    ...overrides,
  } as OrchestratorConfig;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("computeAccountCapacity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 100% remaining when nothing consumed", () => {
    const config = makeConfig();
    const state = makeState({ accountId: "test" });
    const result = computeAccountCapacity("test", config, state, 0);

    expect(result.baseQuota.percentRemaining).toBe(100);
    expect(result.baseQuota.consumed).toBe(0);
    expect(result.baseQuota.remaining).toBe(100);
    expect(result.status).toBe("available");
  });

  it("calculates remaining correctly after consumption", () => {
    const config = makeConfig();
    const state = makeState({
      accountId: "test",
      consumed: 25,
      windowStartedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
    });
    const result = computeAccountCapacity("test", config, state, 2);

    expect(result.baseQuota.consumed).toBe(25);
    expect(result.baseQuota.remaining).toBe(75);
    expect(result.baseQuota.percentRemaining).toBe(75);
    expect(result.activeSessions).toBe(2);
    expect(result.status).toBe("available");
  });

  it("returns fully-exhausted when quota consumed and no overage", () => {
    const config = makeConfig();
    const state = makeState({
      accountId: "test",
      consumed: 100,
      windowStartedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
    });
    const result = computeAccountCapacity("test", config, state, 0);

    expect(result.baseQuota.remaining).toBe(0);
    expect(result.baseQuota.percentRemaining).toBe(0);
    expect(result.status).toBe("fully-exhausted");
  });

  it("returns overage-only when quota exhausted but overage available", () => {
    const config = makeConfig({
      overage: { enabled: true, type: "credits", spendCap: 50 },
    });
    const state = makeState({
      accountId: "test",
      consumed: 100,
      windowStartedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
      overageConsumed: 10,
    });
    const result = computeAccountCapacity("test", config, state, 0);

    expect(result.status).toBe("overage-only");
    expect(result.overage).not.toBeNull();
    expect(result.overage?.consumed).toBe(10);
    expect(result.overage?.remaining).toBe(40);
  });

  it("resets effective consumed when window has expired", () => {
    const config = makeConfig({ baseQuota: { estimatedTotal: 100, windowHours: 5 } });
    // Window started 6 hours ago → expired
    const state = makeState({
      accountId: "test",
      consumed: 80,
      windowStartedAt: new Date("2026-01-15T06:00:00Z").toISOString(),
    });
    const result = computeAccountCapacity("test", config, state, 0);

    // Window expired, so effectiveConsumed is 0
    expect(result.baseQuota.consumed).toBe(0);
    expect(result.baseQuota.remaining).toBe(100);
    expect(result.status).toBe("available");
  });

  it("shows window reset time when window is active", () => {
    const config = makeConfig({ baseQuota: { estimatedTotal: 100, windowHours: 5 } });
    // Window started 2 hours ago → 3 hours remaining
    const state = makeState({
      accountId: "test",
      consumed: 10,
      windowStartedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
    });
    const result = computeAccountCapacity("test", config, state, 0);

    expect(result.baseQuota.windowResetIn).toBe("3h");
  });

  it("returns null for windowResetIn when no window started", () => {
    const config = makeConfig();
    const state = makeState({ accountId: "test", windowStartedAt: null });
    const result = computeAccountCapacity("test", config, state, 0);

    expect(result.baseQuota.windowResetIn).toBeNull();
  });

  it("uses 100% remaining when no estimatedTotal configured", () => {
    const config: AccountConfig = { agent: "codex" };
    const state = makeState({ accountId: "test", consumed: 5 });
    const result = computeAccountCapacity("test", config, state, 0);

    expect(result.baseQuota.estimatedTotal).toBe(0);
    expect(result.baseQuota.percentRemaining).toBe(100);
    expect(result.status).toBe("available");
  });

  it("keeps Sonnet capacity available when shared Claude pool is exhausted", () => {
    const config = makeConfig({ agent: "claude-code", baseQuota: { estimatedTotal: 100, windowHours: 5 } });
    const state = makeState({
      accountId: "test",
      consumed: 100,
      windowStartedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
      usageSnapshot: makeClaudeUsageSnapshot([
        {
          id: "claude-current-session",
          label: "Current session usage",
          kind: "percent_used",
          status: "available",
          value: 100,
          maxValue: 100,
          displayValue: "100%",
          resetsAt: "2026-01-15T15:00:00Z",
        },
        {
          id: "claude-weekly-all-models",
          label: "Weekly limits - All models",
          kind: "percent_used",
          status: "available",
          value: 100,
          maxValue: 100,
          displayValue: "100%",
          resetsAt: "2026-01-22T12:00:00Z",
        },
        {
          id: "claude-weekly-sonnet-only",
          label: "Weekly limits - Sonnet only",
          kind: "percent_used",
          status: "available",
          value: 20,
          maxValue: 100,
          displayValue: "20%",
          resetsAt: "2026-01-22T12:00:00Z",
        },
      ]),
    });

    const result = computeAccountCapacity("test", config, state, 0);

    expect(result.status).toBe("available");
    expect(result.routing?.byModel.sonnet.available).toBe(true);
    expect(result.routing?.byModel.sonnet.preferredPool).toBe("sonnet-only");
    expect(result.routing?.byModel.opus.available).toBe(false);
  });
});

describe("getEffectiveAccounts", () => {
  it("returns explicit accounts from config", () => {
    const config = makeOrchestratorConfig({
      accounts: {
        "codex-pro-1": { agent: "codex" },
        "claude-max-1": { agent: "claude-code" },
      },
    });
    const accounts = getEffectiveAccounts(config);

    expect(accounts["codex-pro-1"]).toBeDefined();
    expect(accounts["claude-max-1"]).toBeDefined();
  });

  it("derives implicit accounts from project agents", () => {
    const config = makeOrchestratorConfig(); // default agent is claude-code
    const accounts = getEffectiveAccounts(config);

    // Should have implicit "claude-code" account
    expect(accounts["claude-code"]).toBeDefined();
    expect(accounts["claude-code"]?.agent).toBe("claude-code");
  });

  it("does not duplicate agents already covered by explicit accounts", () => {
    const config = makeOrchestratorConfig({
      accounts: {
        "my-claude": { agent: "claude-code" },
      },
    });
    const accounts = getEffectiveAccounts(config);

    // "claude-code" should only appear as "my-claude", not also as "claude-code"
    expect(accounts["my-claude"]).toBeDefined();
    expect(accounts["claude-code"]).toBeUndefined();
  });
});

describe("resolveAccountForProject", () => {
  it("resolves to agent name when no explicit accounts", () => {
    const config = makeOrchestratorConfig();
    const accountId = resolveAccountForProject(config, "my-app");

    // Default agent is "claude-code" for my-app
    expect(accountId).toBe("claude-code");
  });

  it("resolves to first matching explicit account", () => {
    const config = makeOrchestratorConfig({
      accounts: {
        "codex-pro-1": { agent: "codex" },
        "claude-max-1": { agent: "claude-code" },
      },
    });
    const accountId = resolveAccountForProject(config, "my-app");

    // my-app uses default agent "claude-code" → "claude-max-1"
    expect(accountId).toBe("claude-max-1");
  });

  it("falls back to agent name when no explicit account matches", () => {
    const config = makeOrchestratorConfig({
      accounts: {
        "codex-pro-1": { agent: "codex" },
      },
    });
    const accountId = resolveAccountForProject(config, "my-app");

    // my-app uses "claude-code", no explicit claude-code account → fallback
    expect(accountId).toBe("claude-code");
  });
});

describe("selectAccountForProject", () => {
  const originalHome = process.env["HOME"];
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ao-capacity-"));
    process.env["HOME"] = tempHome;
  });

  afterEach(async () => {
    if (originalHome) {
      process.env["HOME"] = originalHome;
    } else {
      delete process.env["HOME"];
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  it("prefers the dedicated Sonnet pool for Sonnet models", async () => {
    const config = makeOrchestratorConfig({
      projects: {
        "my-app": {
          ...makeOrchestratorConfig().projects["my-app"],
          agent: "claude-code",
          agentConfig: { model: "claude-sonnet-4-20250514" },
        },
      },
      accounts: {
        "claude-max-1": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
        "claude-max-2": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
      },
    });

    await writeCapacityState(
      makeState({
        accountId: "claude-max-1",
        usageSnapshot: makeClaudeUsageSnapshot([
          {
            id: "claude-current-session",
            label: "Current session usage",
            kind: "percent_used",
            status: "available",
            value: 85,
            maxValue: 100,
            displayValue: "85%",
            resetsAt: "2026-01-15T15:00:00Z",
          },
          {
            id: "claude-weekly-all-models",
            label: "Weekly limits - All models",
            kind: "percent_used",
            status: "available",
            value: 85,
            maxValue: 100,
            displayValue: "85%",
            resetsAt: "2026-01-22T12:00:00Z",
          },
          {
            id: "claude-weekly-sonnet-only",
            label: "Weekly limits - Sonnet only",
            kind: "percent_used",
            status: "available",
            value: 10,
            maxValue: 100,
            displayValue: "10%",
            resetsAt: "2026-01-22T12:00:00Z",
          },
        ]),
      }),
    );

    await writeCapacityState(
      makeState({
        accountId: "claude-max-2",
        usageSnapshot: makeClaudeUsageSnapshot([
          {
            id: "claude-current-session",
            label: "Current session usage",
            kind: "percent_used",
            status: "available",
            value: 40,
            maxValue: 100,
            displayValue: "40%",
            resetsAt: "2026-01-15T15:00:00Z",
          },
          {
            id: "claude-weekly-all-models",
            label: "Weekly limits - All models",
            kind: "percent_used",
            status: "available",
            value: 40,
            maxValue: 100,
            displayValue: "40%",
            resetsAt: "2026-01-22T12:00:00Z",
          },
          {
            id: "claude-weekly-sonnet-only",
            label: "Weekly limits - Sonnet only",
            kind: "percent_used",
            status: "available",
            value: 90,
            maxValue: 100,
            displayValue: "90%",
            resetsAt: "2026-01-22T12:00:00Z",
          },
        ]),
      }),
    );

    const accountId = await selectAccountForProject(
      config,
      "my-app",
      {} as PluginRegistry,
      [],
    );

    expect(accountId).toBe("claude-max-1");
  });

  it("keeps Opus models on the healthiest shared pool", async () => {
    const config = makeOrchestratorConfig({
      projects: {
        "my-app": {
          ...makeOrchestratorConfig().projects["my-app"],
          agent: "claude-code",
          agentConfig: { model: "claude-opus-4-1" },
        },
      },
      accounts: {
        "claude-max-1": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
        "claude-max-2": {
          agent: "claude-code",
          baseQuota: { estimatedTotal: 100, windowHours: 5 },
        },
      },
    });

    await writeCapacityState(
      makeState({
        accountId: "claude-max-1",
        usageSnapshot: makeClaudeUsageSnapshot([
          {
            id: "claude-current-session",
            label: "Current session usage",
            kind: "percent_used",
            status: "available",
            value: 85,
            maxValue: 100,
            displayValue: "85%",
            resetsAt: "2026-01-15T15:00:00Z",
          },
          {
            id: "claude-weekly-all-models",
            label: "Weekly limits - All models",
            kind: "percent_used",
            status: "available",
            value: 85,
            maxValue: 100,
            displayValue: "85%",
            resetsAt: "2026-01-22T12:00:00Z",
          },
          {
            id: "claude-weekly-sonnet-only",
            label: "Weekly limits - Sonnet only",
            kind: "percent_used",
            status: "available",
            value: 10,
            maxValue: 100,
            displayValue: "10%",
            resetsAt: "2026-01-22T12:00:00Z",
          },
        ]),
      }),
    );

    await writeCapacityState(
      makeState({
        accountId: "claude-max-2",
        usageSnapshot: makeClaudeUsageSnapshot([
          {
            id: "claude-current-session",
            label: "Current session usage",
            kind: "percent_used",
            status: "available",
            value: 40,
            maxValue: 100,
            displayValue: "40%",
            resetsAt: "2026-01-15T15:00:00Z",
          },
          {
            id: "claude-weekly-all-models",
            label: "Weekly limits - All models",
            kind: "percent_used",
            status: "available",
            value: 40,
            maxValue: 100,
            displayValue: "40%",
            resetsAt: "2026-01-22T12:00:00Z",
          },
          {
            id: "claude-weekly-sonnet-only",
            label: "Weekly limits - Sonnet only",
            kind: "percent_used",
            status: "available",
            value: 90,
            maxValue: 100,
            displayValue: "90%",
            resetsAt: "2026-01-22T12:00:00Z",
          },
        ]),
      }),
    );

    const accountId = await selectAccountForProject(
      config,
      "my-app",
      {} as PluginRegistry,
      [],
    );

    expect(accountId).toBe("claude-max-2");
  });
});
