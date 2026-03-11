## Orchestrator Routing Mode Implementation Plan

### Goal
Close the remaining routing-mode gaps without changing the existing account selection architecture.

### Gap A: show account in `status` and `session ls`
1. Update `packages/cli/src/commands/status.ts`:
   - Extend `SessionInfo` with `accountId: string | null`.
   - Populate from `session.metadata["accountId"]`.
   - Add an `Account` table column and render value in `printSessionRow()`.
   - Keep JSON output backwards-compatible while adding `accountId` field.
2. Update `packages/cli/src/commands/session.ts`:
   - Extract `s.metadata["accountId"]` in `ls` output.
   - Append visible account token in session row output.
3. Add/adjust CLI tests to assert account is shown in both commands.

### Gap B: pre-spawn capacity validation
1. Update `packages/core/src/session-manager.ts` spawn flow after `resolveAccount()`:
   - Read capacity state for selected account.
   - Compute active-session count for selected account.
   - Call `computeAccountCapacity()`.
2. Enforce blocking rule:
   - If status is `fully-exhausted`, throw:
     - `Account {id} has no capacity (0% base quota, overage disabled)`.

### Gap C: pre-spawn auth validation
1. Add account-auth check helper(s) in `session-manager.ts` using `getAccountStatusCommand()`.
2. Execute auth check before runtime creation for supported agents.
3. On failed auth check, throw:
   - `Account {id} auth is invalid or expired. Run \`syn accounts login {id}\` to fix.`

### Gap D: overage-only warning
1. In spawn flow after capacity evaluation:
   - If status is `overage-only`, continue spawn.
   - Emit warning:
     - `⚠ Using overage budget for account {id}`.

### Tests
1. `packages/core/src/__tests__/session-manager.test.ts`
   - Add spawn tests for:
     - `fully-exhausted` blocks spawn.
     - `overage-only` warns and continues.
     - available capacity continues.
     - auth invalid blocks spawn.
     - auth valid continues.
   - Cover edge behavior where account record is missing while counting sessions.
2. `packages/cli/__tests__/commands/status.test.ts`
   - Assert `Account` column appears and account id is rendered.
   - Assert JSON payload contains `accountId`.
3. `packages/cli/__tests__/commands/session.test.ts`
   - Assert `session ls` output includes account marker/id.

### UX and docs
1. Verify `spawn --help` account description is clear (update wording if needed).
2. Verify `capacity --help` descriptions are self-explanatory (tighten wording if needed).
3. Add final verification doc:
   - `docs/verify-orchestrator-routing.md` with commands and outcomes.
4. Add JSDoc to new helper functions in session manager.

### Validation checklist
- `lsp_diagnostics` clean for changed files.
- `pnpm run typecheck`, `pnpm test`, and `pnpm run lint` pass.
- No new dependencies, no `any`/`@ts-ignore`, no lifecycle-manager changes.
