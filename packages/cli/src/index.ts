#!/usr/bin/env node

import { basename } from "node:path";
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

const program = new Command();
const invokedName = basename(process.argv[1] ?? "");
const commandName = invokedName === "syntese" ? "syntese" : "ao";

program
  .name(commandName)
  .description("Syntese — manage parallel AI coding agents (`ao` is still supported)")
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

program.parse();
