/**
 * Plugin Registry — discovers and loads plugins.
 *
 * Plugins can be:
 * 1. Built-in (packages/plugins/*)
 * 2. npm packages (@syntese/plugin-*)
 * 3. Local file paths specified in config
 */

import type {
  PluginSlot,
  PluginManifest,
  PluginModule,
  PluginRegistry,
  OrchestratorConfig,
} from "./types.js";

/** Map from "slot:name" → plugin instance */
type PluginMap = Map<string, { manifest: PluginManifest; instance: unknown }>;

function makeKey(slot: PluginSlot, name: string): string {
  return `${slot}:${name}`;
}

/** Built-in plugin package names, mapped to their npm package */
const BUILTIN_PLUGINS: Array<{ slot: PluginSlot; name: string; pkg: string }> = [
  // Runtimes
  { slot: "runtime", name: "tmux", pkg: "@syntese/plugin-runtime-tmux" },
  { slot: "runtime", name: "process", pkg: "@syntese/plugin-runtime-process" },
  // Agents
  { slot: "agent", name: "claude-code", pkg: "@syntese/plugin-agent-claude-code" },
  { slot: "agent", name: "codex", pkg: "@syntese/plugin-agent-codex" },
  { slot: "agent", name: "aider", pkg: "@syntese/plugin-agent-aider" },
  { slot: "agent", name: "opencode", pkg: "@syntese/plugin-agent-opencode" },
  // Workspaces
  { slot: "workspace", name: "worktree", pkg: "@syntese/plugin-workspace-worktree" },
  { slot: "workspace", name: "clone", pkg: "@syntese/plugin-workspace-clone" },
  // Trackers
  { slot: "tracker", name: "github", pkg: "@syntese/plugin-tracker-github" },
  { slot: "tracker", name: "linear", pkg: "@syntese/plugin-tracker-linear" },
  { slot: "tracker", name: "gitlab", pkg: "@syntese/plugin-tracker-gitlab" },
  // SCM
  { slot: "scm", name: "github", pkg: "@syntese/plugin-scm-github" },
  { slot: "scm", name: "gitlab", pkg: "@syntese/plugin-scm-gitlab" },
  // Notifiers
  { slot: "notifier", name: "composio", pkg: "@syntese/plugin-notifier-composio" },
  { slot: "notifier", name: "desktop", pkg: "@syntese/plugin-notifier-desktop" },
  { slot: "notifier", name: "openclaw", pkg: "@syntese/plugin-notifier-openclaw" },
  { slot: "notifier", name: "slack", pkg: "@syntese/plugin-notifier-slack" },
  { slot: "notifier", name: "webhook", pkg: "@syntese/plugin-notifier-webhook" },
  // Terminals
  { slot: "terminal", name: "iterm2", pkg: "@syntese/plugin-terminal-iterm2" },
  { slot: "terminal", name: "web", pkg: "@syntese/plugin-terminal-web" },
];

/** Extract plugin-specific config from orchestrator config */
function extractPluginConfig(
  slot: PluginSlot,
  name: string,
  config: OrchestratorConfig,
): Record<string, unknown> | undefined {
  // Notifiers are configured under config.notifiers.<id>.
  // Match by key (e.g. "openclaw") or explicit plugin field.
  if (slot === "notifier") {
    for (const [notifierName, notifierConfig] of Object.entries(config.notifiers ?? {})) {
      if (!notifierConfig || typeof notifierConfig !== "object") continue;
      const configuredPlugin = (notifierConfig as Record<string, unknown>)["plugin"];
      const hasExplicitPlugin = typeof configuredPlugin === "string" && configuredPlugin.length > 0;
      const matches = hasExplicitPlugin ? configuredPlugin === name : notifierName === name;
      if (matches) {
        const { plugin: _plugin, ...rest } = notifierConfig as Record<string, unknown>;
        return rest;
      }
    }
  }

  return undefined;
}

export function createPluginRegistry(): PluginRegistry {
  const plugins: PluginMap = new Map();

  return {
    register(plugin: PluginModule, config?: Record<string, unknown>): void {
      const { manifest } = plugin;
      const key = makeKey(manifest.slot, manifest.name);
      const instance = plugin.create(config);
      plugins.set(key, { manifest, instance });
    },

    get<T>(slot: PluginSlot, name: string): T | null {
      const entry = plugins.get(makeKey(slot, name));
      return entry ? (entry.instance as T) : null;
    },

    list(slot: PluginSlot): PluginManifest[] {
      const result: PluginManifest[] = [];
      for (const [key, entry] of plugins) {
        if (key.startsWith(`${slot}:`)) {
          result.push(entry.manifest);
        }
      }
      return result;
    },

    async loadBuiltins(
      orchestratorConfig?: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
    ): Promise<void> {
      const doImport = importFn ?? ((pkg: string) => import(pkg));
      for (const builtin of BUILTIN_PLUGINS) {
        try {
          const mod = (await doImport(builtin.pkg)) as PluginModule;
          if (mod.manifest && typeof mod.create === "function") {
            const pluginConfig = orchestratorConfig
              ? extractPluginConfig(builtin.slot, builtin.name, orchestratorConfig)
              : undefined;
            this.register(mod, pluginConfig);
          }
        } catch {
          // Plugin not installed — that's fine, only load what's available
        }
      }
    },

    async loadFromConfig(
      config: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
    ): Promise<void> {
      // Load built-ins with orchestrator config so plugins receive their settings
      await this.loadBuiltins(config, importFn);

      // Then, load any additional plugins specified in project configs
      // (future: support npm package names and local file paths)
    },
  };
}
