# plugins/

20 plugin packages across 8 slots. Each implements one interface from `@syntese/core/types.ts`.

## SLOT → PLUGINS MAP

| Slot | Plugins | Interface |
|------|---------|-----------|
| Agent | claude-code, codex, aider, opencode | `Agent` |
| Runtime | tmux, process | `Runtime` |
| Workspace | worktree, clone | `Workspace` |
| Tracker | github, linear, gitlab | `Tracker` |
| SCM | github, gitlab | `SCM` |
| Notifier | desktop, slack, webhook, openclaw, composio | `Notifier` |
| Terminal | iterm2, web | `Terminal` |

## PLUGIN ANATOMY

Every plugin follows the same pattern:

```
plugin-{slot}-{name}/
├── package.json      # name: @syntese/plugin-{slot}-{name}
├── src/
│   └── index.ts      # Exports: { manifest, create }
├── tsconfig.json     # Extends ../../tsconfig.base.json (NOT root)
└── test/             # Optional tests (some use root integration-tests instead)
```

**Minimal implementation:**
```typescript
import type { PluginModule, PluginManifest, Notifier } from "@syntese/core/types";

const manifest: PluginManifest = {
  name: "my-notifier",
  slot: "notifier",
  description: "My custom notifier",
  version: "0.1.0",
};

function create(config?: Record<string, unknown>): Notifier {
  return {
    name: manifest.name,
    async notify(event) { /* ... */ },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
```

## CONVENTIONS

- Package name: `@syntese/plugin-{slot}-{name}` (e.g., `@syntese/plugin-agent-codex`)
- Single dependency allowed: `@syntese/core` via `workspace:*`
- Slot-specific deps are fine (e.g., `node-notifier` for desktop, `@linear/sdk` for linear)
- Registration happens in `packages/cli/src/lib/plugins.ts` — add new plugins there
- `tsconfig.json` extends `../../tsconfig.base.json` (two levels up from plugins dir)
- Tests: either `test/` dir inside plugin or integration tests in `packages/integration-tests/`

## WHERE TO LOOK

| Task | Start here |
|------|-----------|
| Create new plugin | Copy closest existing plugin, change manifest + create() |
| Understand interface | `packages/core/src/types.ts` — search for the slot interface |
| Register plugin | `packages/cli/src/lib/plugins.ts` + add to CLI `package.json` deps |
| Integration test | `packages/integration-tests/src/{slot}-{name}.integration.test.ts` |

## NOTABLE PLUGINS

- **agent-claude-code**: Largest plugin (~40KB). Handles JSONL activity detection, usage snapshots, workspace hooks, pricing estimation
- **scm-github**: Rich interface (PR lifecycle, CI checks, reviews, merge readiness) — uses `gh` CLI
- **runtime-tmux**: Core runtime. Creates tmux sessions with hash-prefixed names
- **terminal-web**: Bridges web dashboard to tmux via plugin registry
