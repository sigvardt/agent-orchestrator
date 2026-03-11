# @syntese/web

Next.js 15 dashboard + terminal WebSocket servers. Private package (not published to npm).

## STRUCTURE

```
src/
├── app/                    # Next.js App Router
│   ├── layout.tsx              # Root layout (IBM Plex Sans/Mono fonts)
│   ├── page.tsx                # Dashboard home (async SSR, force-dynamic)
│   ├── globals.css             # Tailwind v4 imports
│   ├── api/                    # Route handlers (11 endpoints)
│   │   ├── sessions/route.ts       # GET: list sessions + PR enrichment
│   │   ├── events/route.ts         # GET: SSE stream (5s snapshots, 15s heartbeat)
│   │   ├── spawn/route.ts          # POST: spawn new session
│   │   └── ...
│   └── sessions/[id]/page.tsx  # Session detail view
├── components/             # React 19 client components
│   ├── Dashboard.tsx           # Main view (tabs, backlog, session grid) ~30KB
│   ├── SessionDetail.tsx       # Detail view (terminal, PR, CI) ~30KB
│   ├── DirectTerminal.tsx      # XDA-capable terminal component ~24KB
│   ├── SessionCard.tsx         # Card with status, PR, activity
│   ├── UsageDials.tsx          # Quota visualization
│   └── ...
├── lib/                    # Utilities
│   ├── services.ts             # Singleton: config → plugins → managers (cached in globalThis)
│   ├── serialize.ts            # Core Session → DashboardSession (Date→string, PR enrichment)
│   ├── cache.ts                # TTL cache for PR data (5min, reduces GitHub API calls)
│   ├── types.ts                # DashboardSession, DashboardPR types
│   └── ...
└── hooks/
    └── useSessionEvents.ts     # SSE hook (useReducer for real-time state patches)

server/                     # Standalone WebSocket servers (NOT Next.js)
├── terminal-websocket.ts       # ttyd-based terminal (port 14800)
├── direct-terminal-ws.ts       # node-pty direct terminal (port 14801, XDA support)
└── tmux-utils.ts               # Shared tmux helpers

e2e/                        # Playwright screenshots
```

## DATA FLOW

```
page.tsx (SSR) → services.ts (singleton) → core SessionManager
                                         → serialize.ts (enrichment + caching)
                                         → Dashboard.tsx (client hydration)
                                         → useSessionEvents.ts (SSE for live updates)
```

No database. Server reads flat-file metadata from `~/.syntese/` via core.

## WHERE TO LOOK

| Task | Start here |
|------|-----------|
| Add dashboard feature | `components/Dashboard.tsx` |
| Add API endpoint | `src/app/api/{name}/route.ts` — init services via `lib/services.ts` |
| Change real-time updates | `src/app/api/events/route.ts` + `hooks/useSessionEvents.ts` |
| Modify PR enrichment | `lib/serialize.ts` → `enrichSessionPR()` |
| Terminal changes | `server/direct-terminal-ws.ts` (preferred) or `terminal-websocket.ts` |

## CONVENTIONS

- `no-console` OFF — server logs via console
- `force-dynamic` on pages — no static generation (live data)
- Services singleton in `globalThis.__syntese_services` — HMR-safe
- PR data cached 5min via `TTLCache` to avoid GitHub rate limits
- Tailwind v4 via `@tailwindcss/postcss` (not v3 config-based)
- Testing: Vitest + jsdom + @testing-library/react, setup in `src/__tests__/setup.ts`
- `dev` script runs 3 processes concurrently: Next.js + 2 terminal WS servers

## ANTI-PATTERNS

- Do NOT use static rendering — all pages need live session data
- Do NOT import `@syntese/core` client-side — it uses Node APIs. Use serialized types
- Terminal auth is TODO — do not assume authenticated access
