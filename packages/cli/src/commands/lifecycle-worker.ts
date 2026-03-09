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

function serializeWorkerLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? undefined : serializeWorkerLogValue(value.cause);
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...(cause !== undefined ? { cause } : {}),
    };
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function writeWorkerLog(event: string, fields: Record<string, unknown> = {}): void {
  const payload = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializeWorkerLogValue(value)]),
  );

  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      scope: "lifecycle-worker",
      event,
      ...payload,
    })}\n`,
  );
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
        // Another lifecycle worker is already running for this project — exit
        // silently to avoid duplicate polling loops.
        writeWorkerLog("worker.already_running", {
          projectId,
          pid: existing.pid,
          currentPid: process.pid,
        });
        return;
      }

      const lifecycle = await getLifecycleManager(config, projectId);
      const intervalMs = parseInterval(opts.intervalMs ?? "30000");
      let shuttingDown = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const shutdown = (code: number, signal?: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        writeWorkerLog("worker.shutdown", {
          projectId,
          pid: process.pid,
          exitCode: code,
          ...(signal ? { signal } : {}),
        });
        if (heartbeat) clearInterval(heartbeat);
        lifecycle.stop();
        clearLifecycleWorkerPid(config, projectId, process.pid);
        // Flush stdout/stderr before exiting so crash messages reach the log file
        const done = (): void => process.exit(code);
        if (process.stdout.writableFinished && process.stderr.writableFinished) {
          done();
        } else {
          let flushed = 0;
          const tryExit = (): void => {
            flushed++;
            if (flushed >= 2) done();
          };
          process.stdout.write("", tryExit);
          process.stderr.write("", tryExit);
          // Hard exit if flush hangs
          setTimeout(done, 1_000).unref();
        }
      };

      process.on("SIGINT", () => shutdown(0, "SIGINT"));
      process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
      process.on("uncaughtException", (err) => {
        writeWorkerLog("worker.crash", {
          projectId,
          pid: process.pid,
          source: "uncaughtException",
          error: err,
        });
        shutdown(1, "uncaughtException");
      });
      process.on("unhandledRejection", (reason) => {
        writeWorkerLog("worker.crash", {
          projectId,
          pid: process.pid,
          source: "unhandledRejection",
          error: reason,
        });
        shutdown(1, "unhandledRejection");
      });

      writeLifecycleWorkerPid(config, projectId, process.pid);
      writeWorkerLog("worker.started", {
        projectId,
        pid: process.pid,
        intervalMs,
      });

      // Periodic heartbeat so we can verify the worker is alive from the log
      heartbeat = setInterval(() => {
        writeWorkerLog("worker.heartbeat", {
          projectId,
          pid: process.pid,
        });
      }, 5 * 60_000); // every 5 minutes
      heartbeat.unref();

      lifecycle.start(intervalMs);
    });
}
