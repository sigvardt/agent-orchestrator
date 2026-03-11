## GitHub Vitals Panel Research

### Objective
Add a read-only dashboard panel that surfaces repository vitals (open issues, open PRs, recent commits,
and recency markers) without changing existing dashboard behavior.

### Existing Dashboard Patterns (Must Match)
- Client polling uses manual `fetch()` inside `useEffect` with `setInterval`, plus cleanup and
  cancellation guards (`packages/web/src/components/UsageOverview.tsx`,
  `packages/web/src/components/Dashboard.tsx`).
- API routes use `NextResponse.json(...)` and handle failures with explicit 4xx/5xx payloads
  (`packages/web/src/app/api/backlog/route.ts`, `packages/web/src/app/api/issues/route.ts`).
- Service bootstrap pattern is centralized through `getServices()` from `packages/web/src/lib/services.ts`.
- PR/session enrichment uses server-side TTL caching and fail-soft behavior under API pressure
  (`packages/web/src/lib/cache.ts`, `packages/web/src/lib/serialize.ts`).
- Dashboard styling uses Tailwind v4 utility classes + existing CSS variables; no new style system.

### GitHub Data Sources
- Open issues: `GET /repos/{owner}/{repo}/issues?state=open` (filter out entries with `pull_request`).
- Open PRs: `GET /repos/{owner}/{repo}/pulls?state=open`.
- PR CI indicator: `GET /repos/{owner}/{repo}/commits/{sha}/status` (state: success/failure/pending).
- Recent commits: `GET /repos/{owner}/{repo}/commits`.
- Last closed issue: `GET /repos/{owner}/{repo}/issues?state=closed&sort=updated&per_page=1`.
- Last merged PR: `GET /repos/{owner}/{repo}/pulls?state=closed&sort=updated` and first non-null
  `merged_at`.

### Rate Limit + Efficiency Requirements
- Use `gh api` (aligned with existing GitHub plugin strategy).
- Include ETag-aware conditional requests (`If-None-Match`) and accept `304 Not Modified`.
- Keep server-side `TTLCache` at 60s for vitals snapshots.
- Fail soft on 403/429/network errors and return stale cache where possible.

### Correlation Requirements
- Correlate GitHub PRs/issues to syntese sessions through:
  - Session metadata values (`pr`, `issue`, optional numeric metadata fields if present).
  - Branch matching (`session.branch` vs PR head branch).
  - Session id / branch naming conventions (`{prefix}-{num}` style identifiers).
- Utility must be reusable, not tied to one component.

### Security/Robustness Notes
- Keep all GitHub text rendered via normal React interpolation (no HTML injection).
- Treat missing `gh` auth or unavailable GitHub API as non-fatal; return structured degraded state.
- Prefer deterministic parsing and typed normalization over ad-hoc shape assumptions.
