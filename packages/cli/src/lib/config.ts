import {
  findConfigFile,
  getDefaultConfig,
  getRegistryPath,
  listProjects,
  loadConfig,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@syntese/core";

function cloneProject(project: ProjectConfig, configPath: string): ProjectConfig {
  return {
    ...project,
    configPath,
  };
}

function mergeGlobalConfigFromRegistry(): OrchestratorConfig {
  const registeredProjects = listProjects();
  if (registeredProjects.length === 0) {
    return loadConfig();
  }

  const configPaths = [...new Set(registeredProjects.map((entry) => entry.configPath))];
  const merged = getDefaultConfig();
  let firstConfigPath: string | null = null;

  for (const configPath of configPaths) {
    const loaded = loadConfig(configPath);
    if (!firstConfigPath) {
      firstConfigPath = loaded.configPath;
      merged.port = loaded.port;
      merged.terminalPort = loaded.terminalPort;
      merged.directTerminalPort = loaded.directTerminalPort;
      merged.readyThresholdMs = loaded.readyThresholdMs;
      merged.defaults = loaded.defaults;
      merged.progressChecks = loaded.progressChecks;
      merged.shellEnvironmentPolicy = loaded.shellEnvironmentPolicy;
    }

    merged.notifiers = { ...merged.notifiers, ...loaded.notifiers };
    merged.notificationRouting = { ...merged.notificationRouting, ...loaded.notificationRouting };
    merged.reactions = { ...merged.reactions, ...loaded.reactions };

    for (const [projectId, project] of Object.entries(loaded.projects)) {
      if (merged.projects[projectId]) {
        throw new Error(
          `Duplicate project ID across registered configs: ${projectId} (${merged.projects[projectId].configPath} vs ${loaded.configPath})`,
        );
      }
      merged.projects[projectId] = cloneProject(project, loaded.configPath);
    }
  }

  merged.configPath = firstConfigPath ?? getRegistryPath();
  return merged;
}

export function loadCliConfig(configPath?: string): OrchestratorConfig {
  if (configPath) {
    return loadConfig(configPath);
  }

  const localConfigPath = findConfigFile();
  if (localConfigPath) {
    return loadConfig(localConfigPath);
  }

  return mergeGlobalConfigFromRegistry();
}
