/**
 * Configuration loader — reads syntese.yaml (or legacy agent-orchestrator.yaml)
 * and validates with Zod.
 *
 * Minimal config that just works:
 *   projects:
 *     my-app:
 *       repo: org/repo
 *       path: ~/my-app
 *
 * Everything else has sensible defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PRIMARY_CLI_COMMAND } from "./cli-command.js";
import type { OrchestratorConfig } from "./types.js";
import { parseQuotaWindowHours } from "./accounts.js";
import { generateSessionPrefix } from "./paths.js";
import { listBuiltinPluginNames } from "./plugin-registry.js";

const CONFIG_FILENAMES = [
  "syntese.yaml",
  "syntese.yml",
  "agent-orchestrator.yaml",
  "agent-orchestrator.yml",
];

const HOME_CONFIG_PATHS = [
  resolve(homedir(), ".syntese.yaml"),
  resolve(homedir(), ".syntese.yml"),
  resolve(homedir(), ".config", "syntese", "config.yaml"),
  resolve(homedir(), ".agent-orchestrator.yaml"),
  resolve(homedir(), ".agent-orchestrator.yml"),
  resolve(homedir(), ".config", "agent-orchestrator", "config.yaml"),
];

const MISSING_CONFIG_ERROR =
  `No syntese.yaml found (legacy agent-orchestrator.yaml is also supported). Run \`${PRIMARY_CLI_COMMAND} init\` to create one.`;

const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KNOWN_ACCOUNT_AGENTS = new Set(listBuiltinPluginNames("agent"));

/**
 * Warn for shellEnvironmentPolicy.exclude entries that do not look like
 * conventional shell variable identifiers.
 */
function warnInvalidShellEnvironmentPolicy(config: OrchestratorConfig): void {
  const excluded = config.shellEnvironmentPolicy?.exclude ?? [];
  if (excluded.length === 0) return;

  const invalid = excluded.filter((entry) => !ENV_VAR_NAME_PATTERN.test(entry));
  if (invalid.length === 0) return;

  process.emitWarning(
    `shellEnvironmentPolicy.exclude contains non-standard env var names: ${invalid.join(", ")}. ` +
      "Expected shell variable names like FOO or BAR_BAZ. These entries are still applied as raw unset targets.",
    {
      code: "SYNTESE_SHELL_ENV_POLICY_INVALID_EXCLUDE",
      type: "SynteseConfigWarning",
    },
  );
}

function inferScmPlugin(project: {
  repo: string;
  scm?: Record<string, unknown>;
  tracker?: Record<string, unknown>;
}): "github" | "gitlab" {
  const scmPlugin = project.scm?.["plugin"];
  if (scmPlugin === "gitlab") {
    return "gitlab";
  }

  const scmHost = project.scm?.["host"];
  if (typeof scmHost === "string" && scmHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  const trackerPlugin = project.tracker?.["plugin"];
  if (trackerPlugin === "gitlab") {
    return "gitlab";
  }

  const trackerHost = project.tracker?.["host"];
  if (typeof trackerHost === "string" && trackerHost.toLowerCase().includes("gitlab")) {
    return "gitlab";
  }

  return "github";
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const ReactionConfigSchema = z.object({
  auto: z.boolean().default(true),
  action: z.enum(["send-to-agent", "notify", "auto-merge"]).default("notify"),
  message: z.string().optional(),
  priority: z.enum(["urgent", "action", "warning", "info"]).optional(),
  retries: z.number().optional(),
  refireIntervalMs: z.number().nonnegative().optional(),
  escalateAfter: z.union([z.number(), z.string()]).optional(),
  threshold: z.string().optional(),
  maxRuntime: z.string().optional(),
  noCommitTimeout: z.string().optional(),
  firstCommit: z.string().optional(),
  firstPR: z.string().optional(),
  checkpointMessage: z.string().optional(),
  includeSummary: z.boolean().optional(),
});

const TrackerConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const SCMConfigSchema = z
  .object({
    plugin: z.string(),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  })
  .passthrough();

const NotifierConfigSchema = z
  .object({
    plugin: z.string(),
  })
  .passthrough();

const AgentPermissionSchema = z
  .enum(["permissionless", "default", "auto-edit", "suggest", "skip"])
  .default("permissionless")
  .transform((value) => (value === "skip" ? "permissionless" : value));

const AgentSpecificConfigSchema = z
  .object({
    permissions: AgentPermissionSchema,
    model: z.string().optional(),
    orchestratorModel: z.string().optional(),
    opencodeSessionId: z.string().optional(),
  })
  .passthrough();

const ProgressCheckSignalsSchema = z.object({
  errorPatterns: z.array(z.string()).default(["Error:", "FAIL", "TypeError", "ECONNREFUSED"]),
  testPatterns: z
    .array(z.string())
    .default(["npm test", "pnpm test", "pytest", "cargo test", "go test"]),
  livePatterns: z.array(z.string()).default([]),
});

const ProgressChecksNotifySchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === "string" ? [value] : value));

const ProgressChecksSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMinutes: z.number().int().positive().default(10),
  terminalLines: z.number().int().positive().default(50),
  notify: ProgressChecksNotifySchema.optional(),
  signals: ProgressCheckSignalsSchema.default({}),
});

const ProjectProgressChecksSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().positive().optional(),
  terminalLines: z.number().int().positive().optional(),
  notify: ProgressChecksNotifySchema.optional(),
  signals: ProgressCheckSignalsSchema.partial().optional(),
});

const VerificationPostPushSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().positive().optional(),
  failAction: z.enum(["block-merge", "warn", "notify"]).optional(),
  artifacts: z.array(z.string()).optional(),
});

const VerificationEvidenceSchema = z.object({
  required: z.boolean().optional(),
  patterns: z.array(z.string()).optional(),
});

const VerificationConfigSchema = z.object({
  postPush: VerificationPostPushSchema.optional(),
  evidence: VerificationEvidenceSchema.optional(),
});

const DecomposerConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxDepth: z.number().min(1).max(5).default(3),
    model: z.string().default("claude-sonnet-4-20250514"),
    requireApproval: z.boolean().default(true),
  })
  .default({
    enabled: false,
    maxDepth: 3,
    model: "claude-sonnet-4-20250514",
    requireApproval: true,
  });

const ProjectConfigSchema = z.object({
  name: z.string().optional(),
  repo: z.string(),
  path: z.string(),
  defaultBranch: z.string().default("main"),
  sessionPrefix: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "sessionPrefix must match [a-zA-Z0-9_-]+")
    .optional(),
  runtime: z.string().optional(),
  agent: z.string().optional(),
  workspace: z.string().optional(),
  tracker: TrackerConfigSchema.optional(),
  scm: SCMConfigSchema.optional(),
  symlinks: z.array(z.string()).optional(),
  postCreate: z.array(z.string()).optional(),
  verification: VerificationConfigSchema.optional(),
  agentConfig: AgentSpecificConfigSchema.default({}),
  reactions: z.record(ReactionConfigSchema.partial()).optional(),
  agentRules: z.string().optional(),
  agentRulesFile: z.string().optional(),
  orchestratorRules: z.string().optional(),
  orchestratorSessionStrategy: z
    .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
    .optional(),
  opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
  decomposer: DecomposerConfigSchema.optional(),
  progressChecks: ProjectProgressChecksSchema.optional(),
});

const DefaultPluginsSchema = z.object({
  runtime: z.string().default("tmux"),
  agent: z.string().default("claude-code"),
  workspace: z.string().default("worktree"),
  notifiers: z.array(z.string()).default(["composio", "desktop"]),
});

const AccountBaseQuotaSchema = z.object({
  estimatedTotal: z.number().positive(),
  windowHours: z.number().positive().optional(),
});

const AccountOverageSchema = z.object({
  enabled: z.boolean(),
  type: z.enum(["credits", "api-rates"]).optional(),
  spendCap: z.number().nonnegative().optional(),
});

const AccountAuthSchema = z.object({
  profile: z.string().min(1).optional(),
});

const AccountLimitsSchema = z.object({
  quotaWindow: z.string().min(1).optional(),
  overageType: z.enum(["credits", "api-rates"]).optional(),
  overageEnabled: z.boolean().optional(),
  overageSpendCap: z.number().nonnegative().optional(),
  apiKeyFallback: z.boolean().optional(),
});

const AccountConfigSchema = z.object({
  agent: z.string(),
  model: z.string().optional(),
  auth: AccountAuthSchema.optional(),
  limits: AccountLimitsSchema.optional(),
  baseQuota: AccountBaseQuotaSchema.optional(),
  overage: AccountOverageSchema.optional(),
});

const ConfiguredAccountSchema = AccountConfigSchema.extend({
  id: z
    .string()
    .regex(ACCOUNT_ID_PATTERN, "account id must match [a-zA-Z0-9][a-zA-Z0-9_-]*"),
});

const AgentPoolConfigSchema = z.object({
  accounts: z.array(ConfiguredAccountSchema).default([]),
});

const ShellEnvironmentPolicySchema = z.object({
  exclude: z.array(z.string()).default([]),
});

const OrchestratorConfigSchema = z.object({
  port: z.number().default(3000),
  terminalPort: z.number().optional(),
  directTerminalPort: z.number().optional(),
  readyThresholdMs: z.number().nonnegative().default(300_000),
  defaults: DefaultPluginsSchema.default({}),
  projects: z.record(ProjectConfigSchema),
  notifiers: z.record(NotifierConfigSchema).default({}),
  notificationRouting: z.record(z.array(z.string())).default({
    urgent: ["desktop", "composio"],
    action: ["desktop", "composio"],
    warning: ["composio"],
    info: ["composio"],
  }),
  reactions: z.record(ReactionConfigSchema).default({}),
  progressChecks: ProgressChecksSchema.default({}),
  agentPool: AgentPoolConfigSchema.optional(),
  accounts: z.record(AccountConfigSchema).optional(),
  shellEnvironmentPolicy: ShellEnvironmentPolicySchema.optional(),
});

function normalizeAccounts(config: OrchestratorConfig): OrchestratorConfig {
  const normalized: Record<string, NonNullable<OrchestratorConfig["accounts"]>[string]> = {};
  const configuredAccounts = config.agentPool?.accounts ?? [];

  const register = (accountId: string, account: NonNullable<OrchestratorConfig["accounts"]>[string]): void => {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error(
        `Invalid account ID '${accountId}': must match [a-zA-Z0-9][a-zA-Z0-9_-]*`,
      );
    }

    if (normalized[accountId]) {
      throw new Error(`Duplicate account ID detected: '${accountId}'`);
    }

    if (!KNOWN_ACCOUNT_AGENTS.has(account.agent)) {
      throw new Error(
        `Unknown agent plugin for account '${accountId}': '${account.agent}'. Known agents: ${[...KNOWN_ACCOUNT_AGENTS].join(", ")}`,
      );
    }

    const windowHours =
      account.baseQuota?.windowHours ?? parseQuotaWindowHours(account.limits?.quotaWindow) ?? undefined;
    const baseQuota = account.baseQuota
      ? {
          ...account.baseQuota,
          ...(windowHours !== undefined ? { windowHours } : {}),
        }
      : account.limits?.quotaWindow && windowHours !== undefined
        ? {
            estimatedTotal: 0,
            windowHours,
          }
        : undefined;

    normalized[accountId] = {
      ...account,
      ...(baseQuota ? { baseQuota } : {}),
      ...(account.overage
        ? {}
        : account.limits?.overageEnabled
          ? {
              overage: {
                enabled: true,
                type: account.limits.overageType,
                spendCap: account.limits.overageSpendCap,
              },
            }
          : {}),
    };
  };

  for (const [accountId, account] of Object.entries(config.accounts ?? {})) {
    register(accountId, account);
  }

  for (const configuredAccount of configuredAccounts) {
    const { id, ...account } = configuredAccount;
    register(id, account);
  }

  config.accounts = Object.keys(normalized).length > 0 ? normalized : undefined;
  config.agentPool =
    Object.keys(normalized).length > 0
      ? {
          accounts: Object.entries(normalized).map(([id, account]) => ({ id, ...account })),
        }
      : undefined;

  return config;
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

/** Expand ~ to home directory */
function expandHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Expand all path fields in the config */
function expandPaths(config: OrchestratorConfig): OrchestratorConfig {
  for (const project of Object.values(config.projects)) {
    project.path = expandHome(project.path);
  }

  return config;
}

/** Apply defaults to project configs */
function applyProjectDefaults(config: OrchestratorConfig): OrchestratorConfig {
  for (const [id, project] of Object.entries(config.projects)) {
    // Derive name from project ID if not set
    if (!project.name) {
      project.name = id;
    }

    // Derive session prefix from project path basename if not set
    if (!project.sessionPrefix) {
      const projectId = basename(project.path);
      project.sessionPrefix = generateSessionPrefix(projectId);
    }

    const inferredPlugin = inferScmPlugin(project);

    // Infer SCM from repo if not set
    if (!project.scm && project.repo.includes("/")) {
      project.scm = { plugin: inferredPlugin };
    }

    // Infer tracker from repo if not set (default to github issues)
    if (!project.tracker) {
      project.tracker = { plugin: inferredPlugin };
    }
  }

  return config;
}

/** Validate project uniqueness and session prefix collisions */
function validateProjectUniqueness(config: OrchestratorConfig): void {
  // Check for duplicate project IDs (basenames)
  const projectIds = new Set<string>();
  const projectIdToPaths: Record<string, string[]> = {};

  for (const [_configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);

    if (!projectIdToPaths[projectId]) {
      projectIdToPaths[projectId] = [];
    }
    projectIdToPaths[projectId].push(project.path);

    if (projectIds.has(projectId)) {
      const paths = projectIdToPaths[projectId].join(", ");
      throw new Error(
        `Duplicate project ID detected: "${projectId}"\n` +
          `Multiple projects have the same directory basename:\n` +
          `  ${paths}\n\n` +
          `To fix this, ensure each project path has a unique directory name.\n` +
          `Alternatively, you can use the config key as a unique identifier.`,
      );
    }
    projectIds.add(projectId);
  }

  // Check for duplicate session prefixes
  const prefixes = new Set<string>();
  const prefixToProject: Record<string, string> = {};

  for (const [configKey, project] of Object.entries(config.projects)) {
    const projectId = basename(project.path);
    const prefix = project.sessionPrefix || generateSessionPrefix(projectId);

    if (prefixes.has(prefix)) {
      const firstProjectKey = prefixToProject[prefix];
      const firstProject = config.projects[firstProjectKey];
      throw new Error(
        `Duplicate session prefix detected: "${prefix}"\n` +
          `Projects "${firstProjectKey}" and "${configKey}" would generate the same prefix.\n\n` +
          `To fix this, add an explicit sessionPrefix to one of these projects:\n\n` +
          `projects:\n` +
          `  ${firstProjectKey}:\n` +
          `    path: ${firstProject?.path}\n` +
          `    sessionPrefix: ${prefix}1  # Add explicit prefix\n` +
          `  ${configKey}:\n` +
          `    path: ${project.path}\n` +
          `    sessionPrefix: ${prefix}2  # Add explicit prefix\n`,
      );
    }

    prefixes.add(prefix);
    prefixToProject[prefix] = configKey;
  }
}

/** Apply default reactions */
function applyDefaultReactions(config: OrchestratorConfig): OrchestratorConfig {
  const defaults: Record<string, (typeof config.reactions)[string]> = {
    "ci-failed": {
      auto: true,
      action: "send-to-agent",
      retries: 2,
      refireIntervalMs: 120_000,
      escalateAfter: 2,
    },
    "changes-requested": {
      auto: true,
      action: "send-to-agent",
      message:
        "There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.",
      refireIntervalMs: 300_000,
      escalateAfter: "30m",
    },
    "bugbot-comments": {
      auto: true,
      action: "send-to-agent",
      message: "Automated review comments found on your PR. Fix the issues flagged by the bot.",
      escalateAfter: "30m",
    },
    "merge-conflicts": {
      auto: true,
      action: "send-to-agent",
      message: "Your branch has merge conflicts. Rebase on the default branch and resolve them.",
      escalateAfter: "15m",
    },
    "approved-and-green": {
      auto: false,
      action: "notify",
      priority: "action",
      message: "PR is ready to merge",
    },
    "agent-idle": {
      auto: true,
      action: "send-to-agent",
      message:
        "You appear to be idle. If your task is not complete, continue working — write the code, commit, push, and create a PR. If you are blocked, explain what is blocking you.",
      retries: 2,
      escalateAfter: "15m",
    },
    "agent-stuck": {
      auto: true,
      action: "notify",
      priority: "urgent",
      refireIntervalMs: 300_000,
      threshold: "10m",
    },
    "progress-checkpoints": {
      auto: true,
      action: "notify",
      priority: "warning",
    },
    "agent-needs-input": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "agent-exited": {
      auto: true,
      action: "notify",
      priority: "urgent",
    },
    "all-complete": {
      auto: true,
      action: "notify",
      priority: "info",
      includeSummary: true,
    },
  };

  // Merge defaults with user-specified reactions (user wins per field)
  const mergedReactions: typeof config.reactions = { ...defaults };

  for (const [reactionKey, reactionConfig] of Object.entries(config.reactions)) {
    mergedReactions[reactionKey] = {
      ...(defaults[reactionKey] ?? {}),
      ...reactionConfig,
    };
  }

  config.reactions = mergedReactions;

  return config;
}

/**
 * Search for config file in standard locations.
 *
 * Search order:
 * 1. AO_CONFIG_PATH environment variable (if set)
 * 2. Search up directory tree from CWD (like git)
 * 3. Explicit startDir (if provided)
 * 4. Home directory locations
 */
export function findConfigFile(startDir?: string): string | null {
  // 1. Check environment variable override
  const envConfigCandidates = [process.env["SYNTESE_CONFIG_PATH"], process.env["AO_CONFIG_PATH"]];
  for (const envConfigPath of envConfigCandidates) {
    if (!envConfigPath) continue;
    const envPath = resolve(envConfigPath);
    if (existsSync(envPath)) {
      return envPath;
    }
  }

  // 2. Search up directory tree from CWD (like git)
  const searchUpTree = (dir: string): string | null => {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = resolve(dir, filename);
      if (existsSync(configPath)) {
        return configPath;
      }
    }

    const parent = resolve(dir, "..");
    if (parent === dir) {
      // Reached root
      return null;
    }

    return searchUpTree(parent);
  };

  const cwd = process.cwd();
  const foundInTree = searchUpTree(cwd);
  if (foundInTree) {
    return foundInTree;
  }

  // 3. Check explicit startDir if provided
  if (startDir) {
    for (const filename of CONFIG_FILENAMES) {
      const path = resolve(startDir, filename);
      if (existsSync(path)) {
        return path;
      }
    }
  }

  // 4. Check home directory locations
  for (const path of HOME_CONFIG_PATHS) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/** Find config file path (exported for use in hash generation) */
export function findConfig(startDir?: string): string | null {
  return findConfigFile(startDir);
}

/** Load and validate config from a YAML file */
export function loadConfig(configPath?: string): OrchestratorConfig {
  // Priority: 1. Explicit param, 2. Search (including AO_CONFIG_PATH env var)
  // findConfigFile handles AO_CONFIG_PATH validation, so delegate to it
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error(MISSING_CONFIG_ERROR);
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return config;
}

/** Load config and return both config and resolved path */
export function loadConfigWithPath(configPath?: string): {
  config: OrchestratorConfig;
  path: string;
} {
  const path = configPath ?? findConfigFile();

  if (!path) {
    throw new Error(MISSING_CONFIG_ERROR);
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  const config = validateConfig(parsed);

  // Set the config path in the config object for hash generation
  config.configPath = path;

  return { config, path };
}

/** Validate a raw config object */
export function validateConfig(raw: unknown): OrchestratorConfig {
  const validated = OrchestratorConfigSchema.parse(raw);

  let config = validated as OrchestratorConfig;
  config = normalizeAccounts(config);
  config = expandPaths(config);
  config = applyProjectDefaults(config);
  config = applyDefaultReactions(config);
  warnInvalidShellEnvironmentPolicy(config);

  // Validate project uniqueness and prefix collisions
  validateProjectUniqueness(config);

  return config;
}

/** Get the default config (useful for `ao init`) */
export function getDefaultConfig(): OrchestratorConfig {
  return validateConfig({
    projects: {},
  });
}
