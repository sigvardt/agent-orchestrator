import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadConfig } from "./config.js";
import type { OrchestratorConfig, ProjectRegistry, ProjectRegistryEntry } from "./types.js";

const RegistryEntrySchema = z.object({
  configPath: z.string().min(1),
  addedAt: z.string().datetime(),
});

const RegistrySchema = z.object({
  projects: z.record(RegistryEntrySchema).default({}),
});

const DEFAULT_REGISTRY: ProjectRegistry = {
  projects: {},
};

export function getRegistryPath(): string {
  return resolve(homedir(), ".syntese", "projects.yaml");
}

export function loadRegistry(registryPath = getRegistryPath()): ProjectRegistry {
  if (!existsSync(registryPath)) {
    return { ...DEFAULT_REGISTRY };
  }

  const raw = readFileSync(registryPath, "utf-8");
  const parsed = parseYaml(raw) ?? {};
  return RegistrySchema.parse(parsed);
}

export function saveRegistry(registry: ProjectRegistry, registryPath = getRegistryPath()): void {
  const validated = RegistrySchema.parse(registry);
  mkdirSync(dirname(registryPath), { recursive: true });
  atomicWriteFileSync(registryPath, stringifyYaml(validated));
}

export function addProject(
  projectId: string,
  configPath: string,
  registryPath = getRegistryPath(),
): ProjectRegistry {
  const registry = loadRegistry(registryPath);
  const now = new Date().toISOString();
  const existing = registry.projects[projectId];

  registry.projects[projectId] = {
    configPath: resolve(configPath),
    addedAt: existing?.addedAt ?? now,
  };

  saveRegistry(registry, registryPath);
  return registry;
}

export function removeProject(projectId: string, registryPath = getRegistryPath()): boolean {
  const registry = loadRegistry(registryPath);
  if (!registry.projects[projectId]) {
    return false;
  }

  const { [projectId]: _, ...remaining } = registry.projects;
  registry.projects = remaining;
  saveRegistry(registry, registryPath);
  return true;
}

export function listProjects(
  registryPath = getRegistryPath(),
): Array<ProjectRegistryEntry & { id: string }> {
  const registry = loadRegistry(registryPath);
  return Object.entries(registry.projects)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveProjectConfig(
  projectId: string,
  registryPath = getRegistryPath(),
): {
  configPath: string;
  config: OrchestratorConfig;
} {
  const registry = loadRegistry(registryPath);
  const entry = registry.projects[projectId];
  if (!entry) {
    throw new Error(`Project is not registered: ${projectId}`);
  }

  const config = loadConfig(entry.configPath);
  if (!config.projects[projectId]) {
    throw new Error(`Project ${projectId} is not defined in ${entry.configPath}`);
  }

  return {
    configPath: entry.configPath,
    config,
  };
}
