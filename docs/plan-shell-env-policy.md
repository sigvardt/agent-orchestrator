## Shell Environment Policy Implementation Plan

### Scope
Implement `shellEnvironmentPolicy.exclude` so configured environment variable names are unset in
tmux sessions before agent launch.

### File-by-File Plan

1. `packages/core/src/types.ts`
   - Add `ShellEnvironmentPolicy` interface (`exclude: string[]`).
   - Add `shellEnvironmentPolicy?: ShellEnvironmentPolicy` to `OrchestratorConfig`.
   - Add `excludeEnvironment?: string[]` to `RuntimeCreateConfig`.

2. `packages/core/src/config.ts`
   - Add `ShellEnvironmentPolicySchema` with `exclude: z.array(z.string()).default([])`.
   - Add optional `shellEnvironmentPolicy` to `OrchestratorConfigSchema`.
   - Add startup validation/warning for invalid exclude entries while preserving compatibility.

3. `packages/core/src/session-manager.ts`
   - Read `config.shellEnvironmentPolicy?.exclude` once per runtime creation call.
   - Pass `excludeEnvironment` to all three `runtime.create()` call sites:
     - `spawn()`
     - `spawnOrchestrator()`
     - `restore()`
   - Add debug-level trace when excludes are applied at spawn/restore time.

4. `packages/plugins/runtime-tmux/src/index.ts`
   - After `new-session`, before launch command, send `unset ...` for excluded vars.
   - Include a short delay to ensure shell processes unset before launch command.
   - Keep no-op behavior for empty/undefined excludes.

5. `packages/core/src/index.ts`
   - Export `ShellEnvironmentPolicy` type explicitly from the core barrel.

6. Tests
   - `packages/core/src/__tests__/config-validation.test.ts`
     - Validate policy accepted when valid/missing/empty.
     - Validate warning behavior for invalid exclude entries.
   - `packages/core/src/__tests__/session-manager.test.ts`
     - Assert `excludeEnvironment` is propagated to all runtime create paths.
   - `packages/plugins/runtime-tmux/src/__tests__/index.test.ts`
     - Assert `unset` command executes in correct order and is skipped when empty.

7. Verification + Docs
   - Run `pnpm build`, `pnpm run typecheck`, `pnpm test`, `pnpm run lint`.
   - Add `docs/verify-shell-env-policy.md` with executed checks and outcomes.
   - Add JSDoc/inline comments for the unset strategy and policy types.
