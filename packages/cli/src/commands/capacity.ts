/**
 * `syn capacity` — show per-account capacity and headroom.
 *
 * Usage:
 *   syn capacity                  # Show all accounts
 *   syn capacity --agent codex    # Filter to Codex accounts
 *   syn capacity --available      # Only accounts with remaining quota
 *   syn capacity --json           # Machine-readable output
 */

import chalk from "chalk";
import type { Command } from "commander";
import type { AccountCapacity } from "@syntese/core";
import {
  computeAccountCapacity,
  getActiveSessionsByAccount,
  getEffectiveAccounts,
  refreshAccountUsageSnapshots,
  readCapacityState,
} from "../lib/capacity-store.js";
import { getRegistry, getSessionManager } from "../lib/create-session-manager.js";
import { banner, padCol } from "../lib/format.js";
import { loadCliConfig } from "../lib/config.js";

// ─── Display Helpers ─────────────────────────────────────────────────────────

const COL = {
  account: 16,
  agent: 13,
  quota: 18,
  overage: 16,
  sessions: 10,
};

function statusColor(status: AccountCapacity["status"]): string {
  switch (status) {
    case "available":
      return chalk.green(status);
    case "quota-exhausted":
      return chalk.yellow(status);
    case "overage-only":
      return chalk.magenta(status);
    case "fully-exhausted":
      return chalk.red(status);
  }
}

function formatQuota(capacity: AccountCapacity): string {
  const q = capacity.baseQuota;
  if (q.estimatedTotal === 0) {
    return chalk.dim("—");
  }
  const pct = `${q.percentRemaining}%`;
  const frac = `(${q.consumed}/${q.estimatedTotal})`;
  const color = q.percentRemaining > 30 ? chalk.green : q.percentRemaining > 10 ? chalk.yellow : chalk.red;
  return `${color(pct)} ${chalk.dim(frac)}`;
}

function formatOverage(capacity: AccountCapacity): string {
  if (!capacity.overage || !capacity.overage.enabled) {
    return chalk.dim("disabled");
  }
  const o = capacity.overage;
  const typeLabel = o.type === "api-rates" ? "api" : "credits";
  return chalk.dim(`${typeLabel}: $${o.consumed.toFixed(0)}/$${o.spendCap}`);
}

function printTableHeader(): void {
  const hdr =
    padCol("Account", COL.account) +
    padCol("Agent", COL.agent) +
    padCol("Base Quota", COL.quota) +
    padCol("Overage", COL.overage) +
    padCol("Sessions", COL.sessions) +
    "Status";
  console.log(chalk.dim(`  ${hdr}`));
  const totalWidth = COL.account + COL.agent + COL.quota + COL.overage + COL.sessions + 12;
  console.log(chalk.dim(`  ${"─".repeat(totalWidth)}`));
}

function printCapacityRow(capacity: AccountCapacity): void {
  const row =
    padCol(chalk.cyan(capacity.accountId), COL.account) +
    padCol(chalk.dim(capacity.agent), COL.agent) +
    padCol(formatQuota(capacity), COL.quota) +
    padCol(formatOverage(capacity), COL.overage) +
    padCol(String(capacity.activeSessions), COL.sessions) +
    statusColor(capacity.status);
  console.log(`  ${row}`);
}

// ─── Command Registration ─────────────────────────────────────────────────────

export function registerCapacity(program: Command): void {
  program
    .command("capacity")
    .description("Show per-account routing capacity, quota headroom, and overage state")
    .option("--agent <type>", "Filter to accounts for this agent type (e.g. codex, claude-code)")
    .option("--available", "Only show accounts with remaining quota")
    .option("--json", "Output as JSON")
    .action(
      async (opts: { agent?: string; available?: boolean; json?: boolean }) => {
        let config: ReturnType<typeof loadCliConfig>;
        try {
          config = loadCliConfig();
        } catch {
          console.error(chalk.red("No config found. Run `syn init` first."));
          process.exit(1);
        }

        // Get active sessions per accountId (count from session manager)
        let activeSessionsByAccount = new Map<string, number>();
        try {
          const sm = await getSessionManager(config);
          const sessions = await sm.list();
          const registry = await getRegistry(config);
          await refreshAccountUsageSnapshots(config, registry, sessions);
          activeSessionsByAccount = getActiveSessionsByAccount(config, sessions);
        } catch {
          // Session manager unavailable — proceed with zero active sessions
        }

        const accounts = getEffectiveAccounts(config);

        // Load states and compute capacities in parallel
        const entries = Object.entries(accounts);
        const capacities = await Promise.all(
          entries.map(async ([accountId, accountConfig]) => {
            const state = await readCapacityState(accountId);
            const activeSessions = activeSessionsByAccount.get(accountId) ?? 0;
            return computeAccountCapacity(accountId, accountConfig, state, activeSessions);
          }),
        );

        // Apply filters
        let filtered = capacities;
        if (opts.agent) {
          filtered = filtered.filter((c) => c.agent === opts.agent);
        }
        if (opts.available) {
          filtered = filtered.filter((c) => c.status === "available" || c.status === "overage-only");
        }

        if (opts.json) {
          console.log(JSON.stringify(filtered, null, 2));
          return;
        }

        console.log(banner("SYNTESE CAPACITY"));
        console.log();

        if (filtered.length === 0) {
          console.log(chalk.dim("  No accounts found."));
          console.log();
          return;
        }

        printTableHeader();
        for (const capacity of filtered) {
          printCapacityRow(capacity);
        }
        console.log();

        const windowNote = filtered.some((c) => c.baseQuota.windowResetIn !== null);
        if (windowNote) {
          for (const c of filtered) {
            if (c.baseQuota.windowResetIn) {
              console.log(
                chalk.dim(`  ${c.accountId}: window resets in ${c.baseQuota.windowResetIn}`),
              );
            }
          }
          console.log();
        }
      },
    );
}
