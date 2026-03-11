import { afterEach, describe, expect, it } from "vitest";
import {
  getAccountEnvironment,
  parseQuotaWindowHours,
  resolveAccount,
  type OrchestratorConfig,
} from "../index.js";

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    configPath: "/tmp/syntese.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      app: {
        name: "App",
        repo: "org/app",
        path: "/tmp/app",
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    progressChecks: {
      enabled: false,
      intervalMinutes: 10,
      terminalLines: 50,
      signals: { errorPatterns: [], testPatterns: [], livePatterns: [] },
    },
    ...overrides,
  };
}

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalClaudeApiKey = process.env.CLAUDE_API_KEY;

afterEach(() => {
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }

  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  }

  if (originalClaudeApiKey === undefined) {
    delete process.env.CLAUDE_API_KEY;
  } else {
    process.env.CLAUDE_API_KEY = originalClaudeApiKey;
  }
});

describe("parseQuotaWindowHours", () => {
  it("parses hour, minute, and day windows", () => {
    expect(parseQuotaWindowHours("5h")).toBe(5);
    expect(parseQuotaWindowHours("90m")).toBe(1.5);
    expect(parseQuotaWindowHours("2d")).toBe(48);
  });

  it("returns null for invalid input", () => {
    expect(parseQuotaWindowHours(undefined)).toBeNull();
    expect(parseQuotaWindowHours("soon")).toBeNull();
  });
});

describe("resolveAccount", () => {
  it("returns the selected explicit account", () => {
    const config = makeConfig({
      accounts: {
        "codex-pro-1": { agent: "codex" },
      },
    });

    const resolved = resolveAccount(config, {
      projectId: "app",
      accountId: "codex-pro-1",
      agentName: "codex",
    });

    expect(resolved.accountId).toBe("codex-pro-1");
    expect(resolved.account.agent).toBe("codex");
  });

  it("falls back to an implicit account when none are configured", () => {
    const config = makeConfig();
    const resolved = resolveAccount(config, { projectId: "app" });

    expect(resolved.accountId).toBe("claude-code");
    expect(resolved.account).toEqual({ agent: "claude-code" });
  });

  it("rejects an explicit account whose agent mismatches the session agent", () => {
    const config = makeConfig({
      accounts: {
        "codex-pro-1": { agent: "codex" },
      },
    });

    expect(() =>
      resolveAccount(config, {
        projectId: "app",
        accountId: "codex-pro-1",
        agentName: "claude-code",
      }),
    ).toThrow(/uses agent 'codex'/);
  });
});

describe("getAccountEnvironment", () => {
  it("uses CODEX_HOME and clears OPENAI_API_KEY by default", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";

    const env = getAccountEnvironment("codex-pro-1", { agent: "codex" });

    expect(env.CODEX_HOME).toContain("accounts/codex-pro-1");
    expect(env.OPENAI_API_KEY).toBe("");
  });

  it("allows OPENAI_API_KEY fallback when enabled", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";

    const env = getAccountEnvironment(
      "codex-pro-1",
      { agent: "codex", limits: { apiKeyFallback: true } },
      { useApiKeyFallback: true },
    );

    expect(env.OPENAI_API_KEY).toBe("test-openai-key");
  });

  it("uses CLAUDE_CONFIG_DIR and clears Anthropic auth env vars", () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.CLAUDE_API_KEY = "test-claude-key";

    const env = getAccountEnvironment("claude-max-1", { agent: "claude-code" });

    expect(env.CLAUDE_CONFIG_DIR).toContain("accounts/claude-max-1");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.CLAUDE_API_KEY).toBe("");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  });

  it("allows Claude API-key fallback when enabled", () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.CLAUDE_API_KEY = "test-claude-key";

    const env = getAccountEnvironment(
      "claude-max-1",
      { agent: "claude-code", limits: { apiKeyFallback: true } },
      { useApiKeyFallback: true },
    );

    expect(env.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
    expect(env.CLAUDE_API_KEY).toBe("test-claude-key");
  });
});
