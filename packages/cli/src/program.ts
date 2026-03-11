import { CLI_ALIASES, PRIMARY_CLI_COMMAND } from "@syntese/core";
import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerSpawn, registerBatchSpawn } from "./commands/spawn.js";
import { registerSession } from "./commands/session.js";
import { registerSend } from "./commands/send.js";
import { registerReviewCheck } from "./commands/review-check.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerOpen } from "./commands/open.js";
import { registerStart, registerStop } from "./commands/start.js";
import { registerLifecycleWorker } from "./commands/lifecycle-worker.js";
import { registerServices } from "./commands/services.js";
import { registerVerify } from "./commands/verify.js";

export function createProgram(): Command {
  const program = new Command();
  const aliases = CLI_ALIASES.map((alias) => `\`${alias}\``).join(" and ");

  program
    .name(PRIMARY_CLI_COMMAND)
    .description(`Syntese — manage parallel AI coding agents (${aliases} are also available as aliases)`)
    .version("0.1.0");

  registerInit(program);
  registerStart(program);
  registerStop(program);
  registerStatus(program);
  registerSpawn(program);
  registerBatchSpawn(program);
  registerSession(program);
  registerSend(program);
  registerReviewCheck(program);
  registerDashboard(program);
  registerServices(program);
  registerOpen(program);
  registerLifecycleWorker(program);
  registerVerify(program);

  return program;
}
