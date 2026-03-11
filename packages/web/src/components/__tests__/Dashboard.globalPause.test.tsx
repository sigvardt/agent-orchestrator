import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import type { GlobalPauseState } from "@/lib/types";
import { makeSession } from "@/__tests__/helpers";

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.pathname;
  }

  return input.url;
}

function makeJsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe("Dashboard globalPause banner", () => {
  let eventSourceMock: {
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: (() => void) | null;
    close: () => void;
  };

  const defaultStats = {
    totalSessions: 1,
    workingSessions: 1,
    openPRs: 0,
    needsReview: 0,
  };

  const makeGlobalPause = (overrides: Partial<GlobalPauseState> = {}): GlobalPauseState => ({
    pausedUntil: new Date(Date.now() + 3600000).toISOString(),
    reason: "Model rate limit reached",
    sourceSessionId: "session-1",
    ...overrides,
  });

  async function renderDashboard({
    initialSessions,
    stats,
    initialGlobalPause,
  }: {
    initialSessions: Parameters<typeof Dashboard>[0]["initialSessions"];
    stats: Parameters<typeof Dashboard>[0]["stats"];
    initialGlobalPause: Parameters<typeof Dashboard>[0]["initialGlobalPause"];
  }) {
    await act(async () => {
      render(
        <Dashboard
          initialSessions={initialSessions}
          stats={stats}
          initialGlobalPause={initialGlobalPause}
        />,
      );
    });
  }

  beforeEach(() => {
    eventSourceMock = {
      onmessage: null,
      onerror: null,
      close: vi.fn(),
    };
    global.EventSource = vi.fn(() => eventSourceMock as unknown as EventSource);
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = getRequestUrl(input);

      if (url === "/api/usage") {
        return makeJsonResponse({ snapshots: [] });
      }

      if (url === "/api/sessions") {
        return makeJsonResponse({ sessions: [], globalPause: null });
      }

      throw new Error(`Unexpected fetch request in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows banner when initialGlobalPause is set", async () => {
    const sessions = [makeSession()];
    const globalPause = makeGlobalPause();

    await renderDashboard({
      initialSessions: sessions,
      stats: defaultStats,
      initialGlobalPause: globalPause,
    });

    expect(screen.getByText(/Syntese paused:/)).toBeInTheDocument();
    expect(screen.getByText(/Model rate limit reached/)).toBeInTheDocument();
  });

  it("hides banner when initialGlobalPause is null", async () => {
    const sessions = [makeSession()];

    await renderDashboard({
      initialSessions: sessions,
      stats: defaultStats,
      initialGlobalPause: null,
    });

    expect(screen.queryByText(/Syntese paused:/)).not.toBeInTheDocument();
  });

  it("shows banner with custom reason from any provider", async () => {
    const sessions = [makeSession()];
    const globalPause = makeGlobalPause({ reason: "Custom provider limit exceeded" });

    await renderDashboard({
      initialSessions: sessions,
      stats: defaultStats,
      initialGlobalPause: globalPause,
    });

    expect(screen.getByText(/Custom provider limit exceeded/)).toBeInTheDocument();
  });

  it("renders the usage section and pause banner only once", async () => {
    const sessions = [makeSession()];
    const globalPause = makeGlobalPause();

    await renderDashboard({
      initialSessions: sessions,
      stats: defaultStats,
      initialGlobalPause: globalPause,
    });

    expect(screen.getAllByText("Subscription Usage")).toHaveLength(1);
    expect(screen.getAllByText(/Syntese paused:/)).toHaveLength(1);
  });

  it("displays source session ID when provided", async () => {
    const sessions = [makeSession()];
    const globalPause = makeGlobalPause({ sourceSessionId: "my-worker-42" });

    await renderDashboard({
      initialSessions: sessions,
      stats: defaultStats,
      initialGlobalPause: globalPause,
    });

    expect(screen.getByText(/Source: my-worker-42/)).toBeInTheDocument();
  });

  it("banner appears from state update via SSE (provider-agnostic)", async () => {
    const sessions = [makeSession()];

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = getRequestUrl(input);

      if (url === "/api/usage") {
        return makeJsonResponse({ snapshots: [] });
      }

      if (url === "/api/sessions") {
        return makeJsonResponse({
          sessions: [...sessions, makeSession({ id: "session-new" })],
          globalPause: makeGlobalPause({ reason: "Rate limit from any agent" }),
        });
      }

      throw new Error(`Unexpected fetch request in test: ${url}`);
    });

    render(<Dashboard initialSessions={sessions} stats={defaultStats} initialGlobalPause={null} />);

    expect(screen.queryByText(/Syntese paused:/)).not.toBeInTheDocument();

    await waitFor(() => expect(eventSourceMock.onmessage).not.toBeNull());

    await act(async () => {
      eventSourceMock.onmessage!({
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            {
              id: "session-0",
              status: "working",
              activity: "active",
              lastActivityAt: new Date().toISOString(),
            },
            {
              id: "session-new",
              status: "working",
              activity: "active",
              lastActivityAt: new Date().toISOString(),
            },
          ],
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Syntese paused:/)).toBeInTheDocument();
      expect(screen.getByText(/Rate limit from any agent/)).toBeInTheDocument();
    });
  });

  it("banner disappears from state update via SSE (pause expires)", async () => {
    const sessions = [makeSession()];
    const globalPause = makeGlobalPause();

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = getRequestUrl(input);

      if (url === "/api/usage") {
        return makeJsonResponse({ snapshots: [] });
      }

      if (url === "/api/sessions") {
        return makeJsonResponse({
          sessions: [...sessions, makeSession({ id: "session-new" })],
          globalPause: null,
        });
      }

      throw new Error(`Unexpected fetch request in test: ${url}`);
    });

    render(
      <Dashboard
        initialSessions={sessions}
        stats={defaultStats}
        initialGlobalPause={globalPause}
      />,
    );

    expect(screen.getByText(/Syntese paused:/)).toBeInTheDocument();

    await waitFor(() => expect(eventSourceMock.onmessage).not.toBeNull());

    await act(async () => {
      eventSourceMock.onmessage!({
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            {
              id: "session-0",
              status: "working",
              activity: "active",
              lastActivityAt: new Date().toISOString(),
            },
            {
              id: "session-new",
              status: "working",
              activity: "active",
              lastActivityAt: new Date().toISOString(),
            },
          ],
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(screen.queryByText(/Syntese paused:/)).not.toBeInTheDocument();
    });
  });
});
