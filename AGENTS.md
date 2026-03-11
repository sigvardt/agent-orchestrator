# SYNTESE — PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-11 | **Commit:** e6426d7 | **Branch:** main

## OVERVIEW

AI agent orchestration platform. Spawns parallel coding agents (Claude Code, Codex, Aider, OpenCode) in isolated git worktrees, monitors PR lifecycle, auto-reacts to CI failures and review comments. pnpm monorepo, TypeScript strict, Node 20+.

## STRUCTURE

```
syntese/
├── packages/
│   ├── core/              # Engine: types, session manager, lifecycle, plugins
│   ├── cli/               # CLI: `syn` (aliases: `syntese`, `ao`) — Commander.js
│   ├── web/               # Dashboard: Next.js 15 + terminal WebSocket servers
│   ├── syntese/           # Global bin wrapper re-exporting @syntese/cli
│   ├── mobile/            # React Native app (EXCLUDED from pnpm workspace)
│   ├── integration-tests/ # E2E tests for all plugins (vitest forks pool)
│   └── plugins/           # 20 plugin packages across 8 slots
├── scripts/               # Legacy bash helpers (claude-spawn, notify-session, etc.)
├── docs/                  # Design docs, security audit, dev guide
├── examples/              # Config templates (GitHub, Linear, multi-project)
├── tests/integration/     # Docker-based onboarding test
└── .github/workflows/     # 8 CI workflows (ci, security, integration, release)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add CLI command | `packages/cli/src/commands/` | Register in `program.ts`, follow Commander pattern |
| Add plugin | `packages/plugins/{slot}-{name}/` | Implement interface from `core/types.ts`, export `PluginModule` |
| Change session lifecycle | `packages/core/src/lifecycle-manager.ts` | 117KB — the central state machine |
| Modify dashboard UI | `packages/web/src/components/` | React 19 + Tailwind v4, server-rendered via App Router |
| Add API endpoint | `packages/web/src/app/api/` | Next.js route handlers, init services via `lib/services.ts` |
| Terminal WebSocket | `packages/web/server/` | Two backends: ttyd-based + direct node-pty |
| Config schema | `packages/core/src/config.ts` | Zod validation, loads `syntese.yaml` |
| Type definitions | `packages/core/src/types.ts` | ALL plugin interfaces (1591 lines) — the contract |
| Session metadata | `packages/core/src/metadata.ts` | Flat-file key=value in `~/.syntese/` |
| Integration tests | `packages/integration-tests/src/` | `.integration.test.ts` suffix, requires tmux + agent binaries |
| Recovery logic | `packages/core/src/recovery/` | Session crash detection + auto-restore |
| Account/quota | `packages/core/src/account-capacity.ts` | Multi-account with per-window quota tracking |

## CONVENTIONS

- **Module system**: ESM only (`"type": "module"`). Use `.js` extensions in imports (`import "./foo.js"`)
- **Type imports**: `import type { X }` enforced by ESLint (`consistent-type-imports`)
- **No any**: `@typescript-eslint/no-explicit-any` is error (relaxed in tests only)
- **Prettier**: 100-char width, double quotes, trailing commas, semicolons
- **Tests**: Vitest everywhere. Unit in `__tests__/`, integration in separate package with `.integration.test.ts`
- **Unused vars**: Prefix with `_` (e.g., `_unused`) — enforced
- **Plugin naming**: `@syntese/plugin-{slot}-{name}` (e.g., `plugin-agent-claude-code`)
- **Session naming**: `{prefix}-{num}` user-facing, `{hash}-{prefix}-{num}` for tmux (global uniqueness)
- **No database**: All state in flat-file metadata (`~/.syntese/{hash}-{project}/sessions/`)
- **Changesets**: Version management via `@changesets/cli`, not manual

## GIT WORKFLOW (MANDATORY)

- **NEVER** commit directly to `main` or `dev`
- For every task: create a worktree (`git worktree add ../wt-<branch> -b feat/<name>`)
- Work ONLY inside the worktree directory
- When done: commit, push, open PR via `gh pr create`
- After PR is merged: clean up worktree (`git worktree remove`)
- Commit messages: conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`)

## ANTI-PATTERNS

- **NEVER** commit secrets — pre-commit gitleaks hook blocks it. Use `.env.local`
- **NEVER** use `eval()`, `new Function()`, or `require()` — ESLint errors
- **NEVER** suppress types with `as any` or `@ts-ignore`
- **NEVER** put console.log in core/plugin packages — only CLI and web are exempted
- **NEVER** skip the hash prefix in tmux session names — causes cross-instance collisions
- Orchestrator sessions ALWAYS get `permissionless` mode — non-negotiable for autonomous CLI execution
- `lifecycle-manager.ts` is monolithic by design — do NOT split it

## COMMANDS

```bash
pnpm install && pnpm build     # Install + build all packages
pnpm dev                        # Start web dashboard (Next.js + terminal WS servers)
pnpm test                       # Unit tests (excludes web package)
pnpm test:integration           # Integration tests (requires tmux, agent binaries)
pnpm lint                       # ESLint
pnpm format:check               # Prettier check
pnpm typecheck                  # TypeScript check (all packages)
```

## NOTES

- `AGENTS.md` and `CLAUDE.md` are gitignored — local knowledge bases only
- `packages/mobile` excluded from workspace — builds separately with Expo
- `postinstall` runs `scripts/rebuild-node-pty.js` — node-pty requires native rebuild
- Web tests excluded from root `pnpm test` — run separately via `pnpm --filter @syntese/web test`
- `syntese.yaml` (runtime config) is gitignored — use `syntese.yaml.example` as template
- Terminal WS auth is TODO — currently basic CORS only, not production-ready
- AI-powered rule generation in `init` command is stub — template-based only
- Two terminal backends exist: ttyd (iframe, port 14800) and direct WS (node-pty, port 14801)
- `.cursor/` dir exists — some team members use Cursor IDE
