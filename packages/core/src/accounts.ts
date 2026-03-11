import { getAccountDataDir } from "./paths.js";
import type { AccountConfig, OrchestratorConfig } from "./types.js";

export interface ResolvedAccount {
  accountId: string;
  account: AccountConfig;
}

export interface AccountCommand {
  command: string;
  args: string[];
}

export interface AccountEnvironmentOptions {
  useApiKeyFallback?: boolean;
}

const DEFAULT_QUOTA_WINDOW_HOURS = 5;

const CODEX_AUTH_ENV_KEYS = ["OPENAI_API_KEY"] as const;

const CLAUDE_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
] as const;

function clearEnvironment(keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, ""]));
}

function maybeSetFallbackEnv(
  env: Record<string, string>,
  keys: readonly string[],
  enabled: boolean,
): void {
  if (!enabled) {
    return;
  }

  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
}

export function getConfiguredAccounts(config: OrchestratorConfig): Record<string, AccountConfig> {
  return config.accounts ?? {};
}

/**
 * Get all account configs: explicit ones from config.accounts plus implicit
 * defaults derived from agent types used across projects.
 */
export function getEffectiveAccounts(config: OrchestratorConfig): Record<string, AccountConfig> {
  const explicit = getConfiguredAccounts(config);
  const agentsCovered = new Set(Object.values(explicit).map((account) => account.agent));

  const implicit: Record<string, AccountConfig> = {};
  for (const project of Object.values(config.projects)) {
    const agentName = project.agent ?? config.defaults.agent;
    if (agentsCovered.has(agentName)) {
      continue;
    }

    implicit[agentName] = { agent: agentName };
    agentsCovered.add(agentName);
  }

  return { ...implicit, ...explicit };
}

export function resolveAccount(
  config: OrchestratorConfig,
  options: { projectId: string; accountId?: string; agentName?: string },
): ResolvedAccount {
  const project = config.projects[options.projectId];
  if (!project) {
    throw new Error(`Unknown project: ${options.projectId}`);
  }

  const effectiveAgent = options.agentName ?? project.agent ?? config.defaults.agent;
  const explicitAccounts = getConfiguredAccounts(config);

  if (options.accountId) {
    const explicit = explicitAccounts[options.accountId];
    if (explicit) {
      if (explicit.agent !== effectiveAgent) {
        throw new Error(
          `Account '${options.accountId}' uses agent '${explicit.agent}', but this session uses '${effectiveAgent}'`,
        );
      }
      return { accountId: options.accountId, account: explicit };
    }

    if (options.accountId === effectiveAgent) {
      return {
        accountId: options.accountId,
        account: { agent: effectiveAgent },
      };
    }

    throw new Error(`Unknown account: ${options.accountId}`);
  }

  for (const [accountId, account] of Object.entries(explicitAccounts)) {
    if (account.agent === effectiveAgent) {
      return { accountId, account };
    }
  }

  return {
    accountId: effectiveAgent,
    account: { agent: effectiveAgent },
  };
}

export function resolveAccountForProject(
  config: OrchestratorConfig,
  projectId: string,
  accountId?: string,
  agentName?: string,
): string {
  return resolveAccount(config, { projectId, accountId, agentName }).accountId;
}

export function parseQuotaWindowHours(quotaWindow: string | undefined): number | null {
  if (!quotaWindow) {
    return null;
  }

  const match = /^\s*(\d+(?:\.\d+)?)\s*([mhd])\s*$/i.exec(quotaWindow);
  if (!match) {
    return null;
  }

  const value = Number.parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(value) || value <= 0 || !unit) {
    return null;
  }

  switch (unit) {
    case "m":
      return value / 60;
    case "h":
      return value;
    case "d":
      return value * 24;
    default:
      return null;
  }
}

export function getAccountWindowHours(account: AccountConfig): number {
  return (
    account.baseQuota?.windowHours ??
    parseQuotaWindowHours(account.limits?.quotaWindow) ??
    DEFAULT_QUOTA_WINDOW_HOURS
  );
}

export function getAccountOverageConfig(account: AccountConfig): {
  enabled: boolean;
  type: "credits" | "api-rates";
  spendCap: number;
} | null {
  if (account.overage) {
    return {
      enabled: account.overage.enabled,
      type: account.overage.type ?? "credits",
      spendCap: account.overage.spendCap ?? 0,
    };
  }

  if (account.limits?.overageEnabled) {
    return {
      enabled: true,
      type: account.limits.overageType ?? "credits",
      spendCap: account.limits.overageSpendCap ?? 0,
    };
  }

  return null;
}

export function getAccountEnvironment(
  accountId: string,
  account: AccountConfig,
  options: AccountEnvironmentOptions = {},
): Record<string, string> {
  const allowApiKeyFallback = options.useApiKeyFallback === true && account.limits?.apiKeyFallback === true;
  const accountDir = getAccountDataDir(accountId);

  switch (account.agent) {
    case "codex": {
      const env = {
        CODEX_HOME: accountDir,
        ...clearEnvironment(CODEX_AUTH_ENV_KEYS),
      };
      maybeSetFallbackEnv(env, CODEX_AUTH_ENV_KEYS, allowApiKeyFallback);
      return env;
    }
    case "claude-code": {
      const env = {
        CLAUDE_CONFIG_DIR: accountDir,
        ...clearEnvironment(CLAUDE_AUTH_ENV_KEYS),
      };
      maybeSetFallbackEnv(env, ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"], allowApiKeyFallback);
      return env;
    }
    default:
      return {};
  }
}

export function getAccountLoginCommand(account: AccountConfig): AccountCommand | null {
  switch (account.agent) {
    case "codex":
      return { command: "codex", args: ["login"] };
    case "claude-code":
      return { command: "claude", args: ["auth", "login"] };
    default:
      return null;
  }
}

export function getAccountStatusCommand(account: AccountConfig): AccountCommand | null {
  switch (account.agent) {
    case "codex":
      return { command: "codex", args: ["login", "status"] };
    case "claude-code":
      return { command: "claude", args: ["auth", "status", "--json"] };
    default:
      return null;
  }
}
