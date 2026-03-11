# Multi-Project Support Plan

## Goals

1. Register projects globally from any repo path.
2. Allow CLI commands to run outside project roots via global registry merge mode.
3. Improve dashboard usability with project-specific filtering.
4. Keep single-project behavior backward compatible.

## Delivery slices

### 1) CLI project management

- Add `packages/cli/src/commands/project.ts` with:
  - `syn project add [path]`
  - `syn project remove <name>`
  - `syn project list`
- Register the command group in `packages/cli/src/program.ts`.

### 2) CLI global mode config resolution

- Add a dedicated CLI config resolver in `packages/cli/src/lib/config.ts`.
- Resolution order:
  1. local config from current working tree,
  2. merged global config from registry entries.
- Update CLI commands to use the resolver instead of direct `loadConfig()`.

### 3) Session path compatibility

- Use per-project `configPath` when available for hash-based paths in session manager.
- Keep fallback to root `config.configPath` for legacy/single-config behavior.

### 4) Dashboard project filtering

- Extend `GET /api/sessions` to accept `?project=<id>`.
- Add project selector UI in Dashboard when `projectIds.length >= 2`.
- Filter board/PR stats by selected project while preserving default all-project view.

## Validation

- Run build + typecheck + tests + lint.
- Confirm:
  - `syn project add/remove/list` works,
  - `syn status` and `syn session ls` run without local `syntese.yaml` when registry exists,
  - dashboard filter updates visible data by project.
