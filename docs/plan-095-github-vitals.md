## GitHub Vitals Panel Implementation Plan

### Scope (PR 1 of 2)
Implement phases 1-6 (research through harden): data client, reusable correlation utility, API route,
dashboard panel integration, tests, and resilience improvements.

### Architecture
1. Server-only GitHub vitals library (`packages/web/src/lib/github-vitals.ts`)
   - `fetchOpenIssues(repo)`
   - `fetchOpenPRs(repo)`
   - `fetchRecentCommits(repo)`
   - Shared `gh api` executor (child_process + typed parser)
   - ETag state + `TTLCache` snapshot cache (60s)

2. Reusable correlation utility (`packages/web/src/lib/agent-correlation.ts`)
   - Normalize sessions for matching (PR number, issue number, branch, session id token)
   - Correlate PRs and issues to one-or-more sessions with reason tags
   - Export utility functions usable by any dashboard route/component

3. API route (`packages/web/src/app/api/vitals/route.ts`)
   - `GET /api/vitals?project=<id>`
   - Resolve projects via `getServices()`
   - Fetch per-project vitals + recency markers
   - Attach correlation results
   - Return structured degraded response when GitHub unavailable

4. UI components
   - `packages/web/src/components/VitalsFoldDown.tsx` (generic animated fold-down list)
   - `packages/web/src/components/GitHubVitals.tsx` (panel + polling + recency + CI + badges)
   - Mount in `packages/web/src/components/Dashboard.tsx`

5. Type contracts
   - Extend `packages/web/src/lib/types.ts` with vitals domain types

6. Tests + harden
   - Unit tests for GitHub vitals client behavior (cache/etag/failure modes)
   - Unit tests for correlation utility matching
   - API fallback semantics (stale data/degraded status)

### Data Flow
- Client component polls `/api/vitals` every 30s.
- API route fans out to project repositories, aggregates normalized data.
- Correlation utility joins GitHub items with active sessions before response.
- UI renders summary badges + fold-down item lists for issues/PRs/commits.

### Simplification Guardrails
- Keep fetch layer minimal (single executor + endpoint helpers).
- Keep fold-down component generic and data-agnostic.
- Avoid introducing new query/state libraries.
- Keep route and component logic explicit over premature abstraction.

### Verification
- Changed files pass local diagnostics.
- `pnpm run typecheck && pnpm test && pnpm run lint`.
- Dashboard renders with and without GitHub availability.
