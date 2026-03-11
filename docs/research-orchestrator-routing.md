## Orchestrator Routing Mode Research

### Scope audited
- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/session.ts`
- `packages/core/src/session-manager.ts`
- `packages/core/src/account-capacity.ts`
- `packages/core/src/accounts.ts`

### Confirmed existing behavior
1. `syn spawn --account <id>` is already wired through CLI to `SessionManager.spawn()`.
2. `syn capacity --json` already returns structured `AccountCapacity[]` output.
3. Session metadata persists `accountId` during spawn and restore paths.
4. Spawn fallback routing already exists via `selectAccountForProject()` and `resolveAccountForProject()`.
5. Account environment/auth isolation is already handled by `getAccountEnvironment()` and account data dirs.

### Gap A: account visibility in session listings
- `status.ts` already builds a `SessionInfo` object, but it does not expose `accountId`.
- `printSessionRow()` currently renders session, branch, PR/CI/review/activity, but no account column.
- `session.ts` `ls` subcommand builds a per-session parts list from id/age/branch/status/pr only.
- Result: routing decisions are persisted but not visible in primary CLI session views.

### Gap B: missing pre-spawn capacity hard stop
- `spawn()` resolves a target account (`resolveAccount`) and immediately proceeds to runtime creation.
- There is no preflight capacity read for the chosen account.
- `computeAccountCapacity()` already computes `available`, `overage-only`, and `fully-exhausted`.
- Result: sessions can start even when account capacity is fully exhausted.

### Gap C: missing auth validation before spawn
- `accounts.ts` exposes `getAccountStatusCommand()` for account-specific auth verification.
- `spawn()` does not execute account status checks before launching runtime.
- Result: invalid/expired account auth is only discovered after launch attempts.

### Gap D: missing overage warning
- Capacity model already exposes `status === "overage-only"`.
- Spawn currently does not communicate overage usage to users.
- Result: sessions can consume overage budget silently.

### Testing surface identified
- CLI output tests:
  - `packages/cli/__tests__/commands/status.test.ts`
  - `packages/cli/__tests__/commands/session.test.ts`
- Core spawn validation tests:
  - `packages/core/src/__tests__/session-manager.test.ts`

### Constraints to preserve
- Do not rewrite existing account routing infrastructure.
- Keep `.js` ESM import suffixes and strict TypeScript typing.
- Keep behavior backwards-compatible for unsupported agent auth-status commands.
