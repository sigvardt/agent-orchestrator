# Multi-Project Support Research

## Existing foundation

- Core registry support already exists in `packages/core/src/project-registry.ts` with CRUD, Zod validation, and atomic writes.
- Registry tests are present in `packages/core/src/__tests__/project-registry.test.ts`.
- Shared types already include:
  - `ProjectRegistry` and `ProjectRegistryEntry`
  - `SessionMetadata.issueId` and `SessionMetadata.phase`
  - `ProjectConfig.configPath`
- Core exports and metadata support are already wired through `packages/core/src/index.ts` and `packages/core/src/metadata.ts`.
- `session-from-metadata` already contains the issue fallback chain.

## Gaps identified

- CLI has no `syn project` command group to manage the global registry.
- CLI config loading assumes local config discovery and does not fall back to a global registry merge.
- Dashboard session API does not support server-side filtering by project query param.
- Dashboard UI has no project selector for multi-project views.

## Implementation direction

- Add `syn project add/remove/list` with Commander patterns used by existing commands.
- Add a CLI config loader that:
  - uses local config when available,
  - otherwise loads registered configs from `~/.syntese/projects.yaml` and merges them.
- Ensure runtime session path resolution uses per-project `configPath` when present.
- Add `?project=` filtering support in sessions API route.
- Add a Dashboard project dropdown when multiple project IDs are present.
