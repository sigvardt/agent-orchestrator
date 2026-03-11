import chalk from "chalk";
import type { Command } from "commander";
import {
  getAccountDataDir,
  getEffectiveAccounts,
  type AccountConfig,
  type OrchestratorConfig,
  type Session,
  PRIMARY_CLI_COMMAND,
} from "@syntese/core";
import { banner, padCol } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { loginAccount, resolveSessionAccountId, testAccountAuth } from "../lib/accounts.js";
import { loadCliConfig } from "../lib/config.js";

const ACTIVE_SESSION_STATUSES = new Set(["working", "spawning", "ready", "idle"]);

const COL = {
  account: 18,
  agent: 14,
  profile: 18,
  source: 10,
  auth: 20,
  sessions: 10,
};

interface AccountRow {
  accountId: string;
  account: AccountConfig;
  authSummary: string;
  authOk: boolean;
  activeSessions: number;
  source: "config" | "implicit";
}

function formatAuth(authOk: boolean, summary: string): string {
  if (authOk) {
    return chalk.green(summary);
  }
  return chalk.yellow(summary);
}

function printAccountsHeader(): void {
  const header =
    padCol("Account", COL.account) +
    padCol("Agent", COL.agent) +
    padCol("Profile", COL.profile) +
    padCol("Source", COL.source) +
    padCol("Auth", COL.auth) +
    "Sessions";
  console.log(chalk.dim(`  ${header}`));
  console.log(chalk.dim(`  ${"─".repeat(COL.account + COL.agent + COL.profile + COL.source + COL.auth + COL.sessions + 2)}`));
}

function printAccountRow(row: AccountRow): void {
  const profile = row.account.auth?.profile ?? "—";
  const line =
    padCol(chalk.cyan(row.accountId), COL.account) +
    padCol(chalk.dim(row.account.agent), COL.agent) +
    padCol(profile, COL.profile) +
    padCol(chalk.dim(row.source), COL.source) +
    padCol(formatAuth(row.authOk, row.authSummary), COL.auth) +
    String(row.activeSessions);
  console.log(`  ${line}`);
}

function requireAccount(
  config: OrchestratorConfig,
  accountId: string,
): { accountId: string; account: AccountConfig; source: "config" | "implicit" } {
  const accounts = getEffectiveAccounts(config);
  const account = accounts[accountId];
  if (!account) {
    throw new Error(
      `Unknown account: ${accountId}\nAvailable: ${Object.keys(accounts).sort().join(", ") || "(none)"}`,
    );
  }

  return {
    accountId,
    account,
    source: config.accounts?.[accountId] ? "config" : "implicit",
  };
}

async function getActiveSessionsByAccount(
  config: OrchestratorConfig,
): Promise<Map<string, Session[]>> {
  const sessionsByAccount = new Map<string, Session[]>();

  try {
    const sessionManager = await getSessionManager(config);
    const sessions = await sessionManager.list();
    for (const session of sessions) {
      if (!ACTIVE_SESSION_STATUSES.has(session.status)) {
        continue;
      }

      const accountId = resolveSessionAccountId(config, session);
      const existing = sessionsByAccount.get(accountId) ?? [];
      existing.push(session);
      sessionsByAccount.set(accountId, existing);
    }
  } catch {
    // Best effort — account commands should still work without session metadata access.
  }

  return sessionsByAccount;
}

async function listAccounts(opts: { json?: boolean } = {}): Promise<void> {
        const config = loadCliConfig();
  const accounts = getEffectiveAccounts(config);
  const activeSessionsByAccount = await getActiveSessionsByAccount(config);
  const rows = await Promise.all(
    Object.entries(accounts).map(async ([accountId, account]) => {
      const auth = await testAccountAuth(accountId, account);
      return {
        accountId,
        account,
        authSummary: auth.summary,
        authOk: auth.ok,
        activeSessions: activeSessionsByAccount.get(accountId)?.length ?? 0,
        source: config.accounts?.[accountId] ? "config" : "implicit",
      } satisfies AccountRow;
    }),
  );

  rows.sort((left, right) => left.accountId.localeCompare(right.accountId));

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(banner("SYNTESE ACCOUNTS"));
  console.log();

  if (rows.length === 0) {
    console.log(chalk.dim("  No accounts found."));
    console.log();
    return;
  }

  printAccountsHeader();
  for (const row of rows) {
    printAccountRow(row);
  }
  console.log();
}

async function runAccountTest(accountId: string, opts: { json?: boolean } = {}): Promise<void> {
        const config = loadCliConfig();
  const resolved = requireAccount(config, accountId);
  const auth = await testAccountAuth(resolved.accountId, resolved.account);
  const payload = {
    accountId: resolved.accountId,
    agent: resolved.account.agent,
    profile: resolved.account.auth?.profile ?? null,
    accountDir: getAccountDataDir(resolved.accountId),
    authenticated: auth.ok,
    summary: auth.summary,
    details: auth.details ?? null,
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    if (!auth.ok) {
      process.exit(1);
    }
    return;
  }

  console.log(banner("ACCOUNT TEST"));
  console.log();
  console.log(`  Account: ${chalk.cyan(resolved.accountId)}`);
  console.log(`  Agent:   ${chalk.dim(resolved.account.agent)}`);
  console.log(`  Profile: ${chalk.dim(resolved.account.auth?.profile ?? "—")}`);
  console.log(`  Dir:     ${chalk.dim(getAccountDataDir(resolved.accountId))}`);
  console.log(`  Auth:    ${auth.ok ? chalk.green(auth.summary) : chalk.yellow(auth.summary)}`);
  console.log();

  if (!auth.ok) {
    process.exit(1);
  }
}

async function runAccountLogin(accountId: string): Promise<void> {
        const config = loadCliConfig();
  const resolved = requireAccount(config, accountId);

  console.log(banner("ACCOUNT LOGIN"));
  console.log();
  console.log(`  Account: ${chalk.cyan(resolved.accountId)}`);
  console.log(`  Agent:   ${chalk.dim(resolved.account.agent)}`);
  console.log(`  Profile: ${chalk.dim(resolved.account.auth?.profile ?? "—")}`);
  console.log(`  Dir:     ${chalk.dim(getAccountDataDir(resolved.accountId))}`);
  console.log();

  const exitCode = await loginAccount(resolved.accountId, resolved.account);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }

  const auth = await testAccountAuth(resolved.accountId, resolved.account);
  console.log();
  console.log(
    auth.ok
      ? chalk.green(`✓ ${resolved.accountId} authenticated (${auth.summary})`)
      : chalk.yellow(
          `! ${resolved.accountId} login completed, but auth check still reports: ${auth.summary}`,
        ),
  );
  console.log();

  if (!auth.ok) {
    process.exit(1);
  }
}

async function showAccountSessionStatus(opts: { json?: boolean } = {}): Promise<void> {
        const config = loadCliConfig();
  const activeSessionsByAccount = await getActiveSessionsByAccount(config);
  const rows = [...activeSessionsByAccount.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accountId, sessions]) => {
      const explicitAccount = config.accounts?.[accountId] ?? null;
      return {
        accountId,
        agent:
          explicitAccount?.agent ??
          sessions[0]?.metadata["agent"] ??
          config.projects[sessions[0]?.projectId ?? ""]?.agent ??
          config.defaults.agent,
        profile: explicitAccount?.auth?.profile ?? null,
        sessions: sessions
          .slice()
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((session) => ({
            id: session.id,
            projectId: session.projectId,
            status: session.status,
            issueId: session.issueId,
            branch: session.branch,
          })),
      };
    });

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(banner("ACCOUNT SESSION STATUS"));
  console.log();

  if (rows.length === 0) {
    console.log(chalk.dim("  No active sessions are using tracked accounts."));
    console.log();
    return;
  }

  for (const row of rows) {
    const profileSuffix = row.profile ? chalk.dim(` (${row.profile})`) : "";
    console.log(`  ${chalk.cyan(row.accountId)} ${chalk.dim(row.agent)}${profileSuffix}`);
    for (const session of row.sessions) {
      const detail = [session.projectId, session.issueId ?? session.branch ?? "—"]
        .filter(Boolean)
        .join(" · ");
      console.log(`    ${session.id}  ${chalk.dim(detail)}  ${chalk.dim(session.status)}`);
    }
    console.log();
  }
}

export function registerAccounts(program: Command): void {
  const accountsCommand = program
    .command("accounts")
    .description("Manage configured agent accounts")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        await listAccounts(opts);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  accountsCommand
    .command("test")
    .description("Test auth for a configured account")
    .argument("<id>", "Account ID")
    .option("--json", "Output as JSON")
    .action(async (accountId: string, opts: { json?: boolean }) => {
      try {
        await runAccountTest(accountId, opts);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  accountsCommand
    .command("login")
    .description("Run an interactive login flow for an account")
    .argument("<id>", "Account ID")
    .action(async (accountId: string) => {
      try {
        await runAccountLogin(accountId);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  accountsCommand
    .command("status")
    .description("Show which sessions are using which accounts")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        await showAccountSessionStatus(opts);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  accountsCommand.addHelpText(
    "after",
    `\nExamples:\n  ${PRIMARY_CLI_COMMAND} accounts\n  ${PRIMARY_CLI_COMMAND} accounts test codex-pro-1\n  ${PRIMARY_CLI_COMMAND} accounts login claude-max-1\n  ${PRIMARY_CLI_COMMAND} accounts status`,
  );
}
