import chalk from "chalk";
import { basename, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import type { Command } from "commander";
import {
  addProject,
  findConfigFile,
  getRegistryPath,
  listProjects,
  loadConfig,
  removeProject,
} from "@syntese/core";

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return `${value}${" ".repeat(width - value.length)}`;
}

function resolveConfigPath(inputPath?: string): string {
  const target = resolve(inputPath ?? process.cwd());

  if (!existsSync(target)) {
    throw new Error(`Path does not exist: ${target}`);
  }

  const stats = statSync(target);
  if (stats.isFile()) {
    return target;
  }

  const configPath = findConfigFile(target);
  if (!configPath) {
    throw new Error(`No syntese.yaml found from ${target}`);
  }

  return configPath;
}

export function registerProject(program: Command): void {
  const command = program.command("project").description("Manage globally registered projects");

  command
    .command("add [path]")
    .description("Register a project from the current directory or a given path")
    .action((inputPath?: string) => {
      try {
        const configPath = resolveConfigPath(inputPath);
        const config = loadConfig(configPath);
        const projectIds = Object.keys(config.projects);

        if (projectIds.length === 0) {
          console.error(chalk.red(`No projects found in ${configPath}`));
          process.exit(1);
        }

        for (const projectId of projectIds) {
          addProject(projectId, configPath);
        }

        const added = projectIds.map((id) => chalk.cyan(id)).join(", ");
        console.log(
          `${chalk.green("✓")} Registered ${projectIds.length} project${projectIds.length === 1 ? "" : "s"}: ${added}`,
        );
        console.log(chalk.dim(`  config: ${configPath}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  command
    .command("remove <name>")
    .description("Remove a project from the global registry")
    .action((name: string) => {
      try {
        const removed = removeProject(name);
        if (!removed) {
          console.error(chalk.red(`Project not found: ${name}`));
          process.exit(1);
        }

        console.log(`${chalk.green("✓")} Removed project ${chalk.cyan(name)}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  command
    .command("list")
    .description("List globally registered projects")
    .action(() => {
      try {
        const projects = listProjects();
        if (projects.length === 0) {
          console.log(chalk.dim("No registered projects."));
          console.log(chalk.dim(`Registry: ${getRegistryPath()}`));
          return;
        }

        const idWidth = Math.max(2, ...projects.map((p) => p.id.length));
        const pathWidth = Math.max(10, ...projects.map((p) => p.configPath.length));

        console.log(
          `${pad("id", idWidth)}  ${pad("configPath", pathWidth)}  ${pad("addedAt", 24)}`,
        );
        console.log(
          `${"-".repeat(idWidth)}  ${"-".repeat(pathWidth)}  ${"-".repeat(24)}`,
        );

        for (const project of projects) {
          console.log(
            `${pad(project.id, idWidth)}  ${pad(project.configPath, pathWidth)}  ${project.addedAt}`,
          );
        }

        console.log();
        console.log(chalk.dim(`Registry: ${basename(getRegistryPath())}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
