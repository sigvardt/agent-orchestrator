# @syntese/cli

User-facing CLI. Triple-aliased as `syn`, `syntese`, `ao`. Built with Commander.js.

## STRUCTURE

```
src/
├── index.ts        # Entry point (shebang, calls createProgram().parse())
├── program.ts      # Commander setup, registers all commands
├── commands/       # One file per command group (14 commands)
│   ├── spawn.ts        # Spawn agent session
│   ├── start.ts        # Start orchestrator + dashboard
│   ├── init.ts         # Initialize project (auto-detect + config gen)
│   ├── session.ts      # ls, kill, restore, claim-pr
│   ├── send.ts         # Send instructions to running agent
│   ├── status.ts       # Overview of all sessions
│   ├── services.ts     # Supervised runtime (systemd/supervisor)
│   ├── dashboard.ts    # Open/start web dashboard
│   ├── accounts.ts     # Account management (login, test, status)
│   ├── capacity.ts     # Quota monitoring
│   ├── open.ts         # Open session in terminal
│   ├── verify.ts       # Post-push verification
│   ├── review-check.ts # PR review status
│   └── lifecycle-worker.ts  # Background lifecycle polling
└── lib/            # Shared CLI utilities (13 modules)
    ├── create-session-manager.ts  # Factory: loads config → plugins → SessionManager
    ├── plugins.ts                 # Plugin loading + registration
    ├── services.ts                # Service management (systemd/supervisor, 25KB)
    ├── preflight.ts               # Pre-flight dependency checks
    ├── project-detection.ts       # Auto-detect language/framework/PM
    ├── format.ts                  # Output formatting (tables, colors)
    ├── session-utils.ts           # Session resolution helpers
    └── ...
```

## WHERE TO LOOK

| Task | Start here |
|------|-----------|
| Add new command | Create `commands/foo.ts`, register in `program.ts` |
| Change spawn flow | `commands/spawn.ts` → `lib/create-session-manager.ts` |
| Modify service management | `lib/services.ts` — handles systemd + supervisor fallback |
| Change output formatting | `lib/format.ts` |
| Plugin loading | `lib/plugins.ts` — registers all built-in plugins |

## CONVENTIONS

- `no-console` is OFF for this package — CLI uses console for user output
- All commands load config via `lib/create-session-manager.ts` → builds full plugin stack
- Templates in `templates/rules/` — agent rule files injected during `init`
- Spinner via `ora` for async operations
- Colors via `chalk`
- Exit codes: 0 success, 1 error — never `process.exit()` in command handlers, throw instead
