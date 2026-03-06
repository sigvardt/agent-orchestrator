import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "@composio/ao-core";
import { getLifecycleManager } from "../lib/create-session-manager.js";
import {
  clearLifecycleWorkerPid,
  getLifecycleWorkerStatus,
  writeLifecycleWorkerPid,
} from "../lib/lifecycle-service.js";

function parseInterval(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

export function registerLifecycleWorker(program: Command): void {
  program
    .command("lifecycle-worker")
    .description("Internal lifecycle polling worker")
    .argument("<project>", "Project ID from config")
    .option("--interval-ms <ms>", "Polling interval in milliseconds", "30000")
    .action(async (projectId: string, opts: { intervalMs?: string }) => {
      const config = loadConfig();
      if (!config.projects[projectId]) {
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const existing = getLifecycleWorkerStatus(config, projectId);
      if (existing.running && existing.pid !== process.pid) {
        return;
      }

      const lifecycle = await getLifecycleManager(config);
      const intervalMs = parseInterval(opts.intervalMs ?? "30000");
      let shuttingDown = false;

      const shutdown = (code: number): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        lifecycle.stop();
        clearLifecycleWorkerPid(config, projectId, process.pid);
        process.exit(code);
      };

      process.on("SIGINT", () => shutdown(0));
      process.on("SIGTERM", () => shutdown(0));
      process.on("uncaughtException", (err) => {
        console.error(`[ao lifecycle] Worker crashed for ${projectId}:`, err);
        shutdown(1);
      });
      process.on("unhandledRejection", (reason) => {
        console.error(`[ao lifecycle] Worker crashed for ${projectId}:`, reason);
        shutdown(1);
      });

      writeLifecycleWorkerPid(config, projectId, process.pid);
      console.log(
        `[ao lifecycle] Started for ${projectId} (pid=${process.pid}, interval=${intervalMs}ms)`,
      );
      lifecycle.start(intervalMs);
    });
}
