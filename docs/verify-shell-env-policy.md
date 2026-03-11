## Shell Environment Policy Verification

### Commands Executed

```bash
pnpm build
pnpm run typecheck
pnpm test
pnpm run lint
```

### Result
- `pnpm build`: PASS
- `pnpm run typecheck`: PASS
- `pnpm test`: PASS
- `pnpm run lint`: PASS (repository has existing warnings unrelated to this feature)

### LSP Diagnostics (changed files)
- `packages/core/src/config.ts`: clean
- `packages/core/src/types.ts`: clean
- `packages/core/src/session-manager.ts`: no errors (one existing deprecation hint in legacy path)
- `packages/core/src/index.ts`: clean
- `packages/core/src/__tests__/config-validation.test.ts`: clean
- `packages/core/src/__tests__/session-manager.test.ts`: clean
- `packages/plugins/runtime-tmux/src/index.ts`: clean
- `packages/plugins/runtime-tmux/src/__tests__/index.test.ts`: clean

### Behavior Checks Covered by Tests
- Config accepts `shellEnvironmentPolicy.exclude`, empty policy object, and missing policy.
- Config emits startup warning for non-standard exclude entries.
- Session manager forwards `excludeEnvironment` in all runtime create paths:
  - `spawn()`
  - `spawnOrchestrator()`
  - `restore()`
- tmux runtime unsets excluded variables between session creation and launch command.
- tmux runtime skips unset when exclude list is empty.
- tmux runtime shell-escapes exclude names for safety.
