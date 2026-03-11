import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  addProject,
  getRegistryPath,
  listProjects,
  loadRegistry,
  removeProject,
  resolveProjectConfig,
  saveRegistry,
} from "../project-registry.js";

let homeDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  homeDir = join(tmpdir(), `syntese-registry-home-${randomUUID()}`);
  mkdirSync(homeDir, { recursive: true });
  originalHome = process.env["HOME"];
  process.env["HOME"] = homeDir;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
});

function writeConfig(configPath: string, projectId: string): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    [
      "defaults:",
      "  runtime: tmux",
      "  agent: claude-code",
      "  workspace: worktree",
      "  notifiers: [desktop]",
      "projects:",
      `  ${projectId}:`,
      "    repo: org/repo",
      `    path: ${join(homeDir, projectId)}`,
    ].join("\n"),
    "utf-8",
  );
}

describe("project registry", () => {
  it("returns empty registry when file does not exist", () => {
    expect(loadRegistry()).toEqual({ projects: {} });
  });

  it("saves and loads registry from ~/.syntese/projects.yaml", () => {
    saveRegistry({
      projects: {
        alpha: {
          configPath: "/tmp/alpha/syntese.yaml",
          addedAt: "2026-03-11T00:00:00.000Z",
        },
      },
    });

    const registryPath = getRegistryPath();
    expect(registryPath).toBe(join(homeDir, ".syntese", "projects.yaml"));
    expect(existsSync(registryPath)).toBe(true);

    const loaded = loadRegistry();
    expect(loaded.projects["alpha"]?.configPath).toBe("/tmp/alpha/syntese.yaml");
  });

  it("addProject adds absolute config paths and listProjects sorts ids", () => {
    const alphaPath = join(homeDir, "alpha", "syntese.yaml");
    const betaPath = join(homeDir, "beta", "syntese.yaml");

    addProject("beta", betaPath);
    addProject("alpha", alphaPath);

    const listed = listProjects();
    expect(listed.map((item) => item.id)).toEqual(["alpha", "beta"]);
    expect(listed[0]?.configPath).toBe(alphaPath);
    expect(listed[1]?.configPath).toBe(betaPath);
    expect(listed[0]?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("removeProject returns false for missing project and true after removal", () => {
    const configPath = join(homeDir, "alpha", "syntese.yaml");
    addProject("alpha", configPath);

    expect(removeProject("missing")).toBe(false);
    expect(removeProject("alpha")).toBe(true);

    const remaining = listProjects();
    expect(remaining.find((p) => p.id === "alpha")).toBeUndefined();
  });

  it("resolveProjectConfig loads config from registry entry", () => {
    const configPath = join(homeDir, "repo", "syntese.yaml");
    writeConfig(configPath, "my-app");
    addProject("my-app", configPath);

    const resolved = resolveProjectConfig("my-app");
    expect(resolved.configPath).toBe(configPath);
    expect(resolved.config.projects["my-app"]?.repo).toBe("org/repo");
  });

  it("saveRegistry writes atomically without temp files", () => {
    saveRegistry({ projects: {} });
    const registryPath = getRegistryPath();
    const registryDir = join(homeDir, ".syntese");
    const content = existsSync(registryDir) ? readFileSync(registryPath, "utf-8") : "";
    const tempFiles = existsSync(registryDir)
      ? readdirSync(registryDir).filter((name) => name.includes(".tmp."))
      : [];

    expect(content).toContain("projects:");
    expect(tempFiles).toHaveLength(0);
  });
});
