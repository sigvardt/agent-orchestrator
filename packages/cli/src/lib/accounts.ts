import { execFile as execFileCallback, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import {
  getAccountDataDir,
  getAccountEnvironment,
  getAccountLoginCommand,
  getAccountStatusCommand,
  resolveAccountForProject,
  type AccountConfig,
  type OrchestratorConfig,
  type Session,
} from "@syntese/core";

const execFileAsync = promisify(execFileCallback);

export interface AccountAuthCheck {
  ok: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function formatExecError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runCommand(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout: stdout.trimEnd(),
      stderr: stderr.trimEnd(),
    };
  } catch (err: unknown) {
    const stdout =
      typeof err === "object" && err !== null && "stdout" in err && typeof err.stdout === "string"
        ? err.stdout.trimEnd()
        : "";
    const stderr =
      typeof err === "object" && err !== null && "stderr" in err && typeof err.stderr === "string"
        ? err.stderr.trimEnd()
        : formatExecError(err);
    const exitCode =
      typeof err === "object" && err !== null && "code" in err && typeof err.code === "number"
        ? err.code
        : 1;
    return { exitCode, stdout, stderr };
  }
}

function parseClaudeStatus(stdout: string, stderr: string, exitCode: number): AccountAuthCheck {
  const fallbackSummary = stdout || stderr || `claude auth status exited with code ${exitCode}`;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, summary: fallbackSummary };
    }

    const record = parsed as Record<string, unknown>;

    const loggedIn = record["loggedIn"] === true;
    const authMethod =
      typeof record["authMethod"] === "string" ? record["authMethod"] : null;
    const apiKeySource =
      typeof record["apiKeySource"] === "string"
        ? record["apiKeySource"]
        : null;

    return {
      ok: loggedIn,
      summary: loggedIn
        ? [authMethod, apiKeySource].filter(Boolean).join(" · ") || "authenticated"
        : "not authenticated",
      details: record,
    };
  } catch {
    return { ok: false, summary: fallbackSummary };
  }
}

function parseCodexStatus(stdout: string, stderr: string, exitCode: number): AccountAuthCheck {
  const output = stdout || stderr;
  if (/logged in/i.test(output) && !/not logged in/i.test(output)) {
    return { ok: true, summary: output.split("\n")[0] ?? "authenticated" };
  }
  if (/not logged in/i.test(output)) {
    return { ok: false, summary: "not authenticated" };
  }
  return {
    ok: exitCode === 0,
    summary: output.split("\n")[0] ?? `codex login status exited with code ${exitCode}`,
  };
}

export async function testAccountAuth(
  accountId: string,
  account: AccountConfig,
): Promise<AccountAuthCheck> {
  const command = getAccountStatusCommand(account);
  if (!command) {
    return {
      ok: false,
      summary: `auth status is not supported for agent '${account.agent}'`,
    };
  }

  const accountDir = getAccountDataDir(accountId);
  if (!existsSync(accountDir)) {
    return {
      ok: false,
      summary: "not authenticated",
      details: { accountDir, initialized: false },
    };
  }

  const env = getAccountEnvironment(accountId, account, { useApiKeyFallback: false });
  const result = await runCommand(command.command, command.args, env);

  switch (account.agent) {
    case "claude-code":
      return parseClaudeStatus(result.stdout, result.stderr, result.exitCode);
    case "codex":
      return parseCodexStatus(result.stdout, result.stderr, result.exitCode);
    default:
      return {
        ok: result.exitCode === 0,
        summary: result.stdout || result.stderr || `command exited with code ${result.exitCode}`,
      };
  }
}

export async function loginAccount(accountId: string, account: AccountConfig): Promise<number> {
  const command = getAccountLoginCommand(account);
  if (!command) {
    throw new Error(`Interactive login is not supported for agent '${account.agent}'`);
  }

  await mkdir(getAccountDataDir(accountId), { recursive: true });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: "inherit",
      env: {
        ...process.env,
        ...getAccountEnvironment(accountId, account, { useApiKeyFallback: false }),
      },
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      reject(new Error(`${command.command} exited due to signal ${signal ?? "unknown"}`));
    });
  });

  return exitCode;
}

export function resolveSessionAccountId(config: OrchestratorConfig, session: Session): string {
  const persistedAccountId = session.metadata["accountId"];
  if (persistedAccountId) {
    return persistedAccountId;
  }

  const persistedAgent = session.metadata["agent"];
  return resolveAccountForProject(config, session.projectId, undefined, persistedAgent);
}
