# @syntese/core

Engine library. Every other package depends on this. Exports types, config loader, session/lifecycle managers, plugin registry, and utilities.

## KEY FILES

| File | Role | Size |
|------|------|------|
| `src/types.ts` | ALL plugin interfaces + session/event types — the contract | 1591 lines |
| `src/lifecycle-manager.ts` | Central state machine: polls sessions, detects transitions, fires reactions | ~117KB |
| `src/session-manager.ts` | Session CRUD: spawn, list, kill, send, restore, claim-PR | Large |
| `src/config.ts` | Loads + validates `syntese.yaml` with Zod schemas | — |
| `src/plugin-registry.ts` | Plugin discovery, loading, slot registration | — |
| `src/metadata.ts` | Flat-file key=value read/write (atomic writes via temp file) | — |
| `src/paths.ts` | Hash-based directory derivation from config location | — |
| `src/account-capacity.ts` | Multi-account quota tracking, usage estimation, account selection | — |
| `src/accounts.ts` | Account registry, auth isolation, environment injection | — |
| `src/verification.ts` | Post-push verification execution, merge gating | — |
| `src/decomposer.ts` | LLM-driven issue decomposition into subtask trees | — |
| `src/prompt-builder.ts` | Layered prompt composition for agent sessions | — |
| `src/recovery/` | Session crash detection + auto-restore (scanner, validator, actions) | — |

## PLUGIN SYSTEM (8 SLOTS)

```
1. Runtime    — where sessions execute    (tmux, process)
2. Agent      — AI coding tool adapter    (claude-code, codex, aider, opencode)
3. Workspace  — code isolation method     (worktree, clone)
4. Tracker    — issue tracking            (github, linear, gitlab)
5. SCM        — PR/CI/review platform     (github, gitlab)
6. Notifier   — push notifications        (desktop, slack, webhook, openclaw)
7. Terminal   — human interaction UI      (iterm2, web)
8. Lifecycle  — state machine (core, not pluggable)
```

Every plugin exports `PluginModule<T>` with `manifest` + `create()`. The `T` is the slot interface (e.g., `Agent`, `Runtime`).

## DATA FLOW

```
syntese.yaml → config.ts (Zod parse) → PluginRegistry (load plugins)
                                      → SessionManager (CRUD via metadata.ts)
                                      → LifecycleManager (poll loop → reactions)
```

State lives in `~/.syntese/{hash}-{projectId}/sessions/{sessionId}` as key=value files. No database.

## WHERE TO LOOK

| Task | Start here |
|------|-----------|
| Add session status | `types.ts` → `SessionStatus` union type + `SESSION_STATUS` const |
| Add plugin interface | `types.ts` → new interface section + `PluginSlot` union |
| Change reaction logic | `lifecycle-manager.ts` → reaction handler methods |
| Modify session spawn | `session-manager.ts` → `spawn()` method |
| Change config schema | `config.ts` → Zod schemas |
| Add metadata field | `types.ts` → `SessionMetadata` interface + `metadata.ts` |
| Change path derivation | `paths.ts` — hash = SHA256(configDir).slice(0, 12) |

## CONVENTIONS

- Exports via barrel `index.ts` — add new exports there, not directly from consumer
- `tsconfig.build.json` excludes `__tests__/` from dist — tests never ship
- Dependencies: only `@anthropic-ai/sdk`, `yaml`, `zod` — keep minimal
- Vitest config uses path aliases to resolve plugin packages to source (avoids circular devDeps)
- Recovery module is self-contained: `recovery/index.ts` re-exports everything

## ANTI-PATTERNS

- Do NOT add database dependencies — flat-file metadata is intentional
- Do NOT split `lifecycle-manager.ts` — monolithic state machine by design
- Do NOT add runtime-specific logic to core — belongs in plugins
- Atomic writes (`atomic-write.ts`) required for metadata — never write directly to session files
