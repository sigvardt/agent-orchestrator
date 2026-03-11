import { type NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { correlateIssues, correlatePullRequests } from "@/lib/agent-correlation";
import { fetchProjectVitals } from "@/lib/github-vitals";
import type { GitHubProjectVitals, GitHubVitalsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const projectFilter = request.nextUrl.searchParams.get("project") ?? undefined;

  try {
    const { config, sessionManager } = await getServices();
    const sessions = await sessionManager.list();

    const projectEntries: Array<{ projectId: string; repository: string }> = [];

    for (const projectId of Object.keys(config.projects)) {
      if (projectFilter && projectId !== projectFilter) {
        continue;
      }

      const project = config.projects[projectId];
      if (!project) continue;
      if (project.scm?.plugin !== "github") continue;
      projectEntries.push({ projectId, repository: project.repo });
    }

    const projects = await Promise.all(
      projectEntries.map(async ({ projectId, repository }) => {
        const baseVitals = await fetchProjectVitals(projectId, repository);
        const projectSessions = sessions.filter((session) => session.projectId === projectId);

        const correlated: GitHubProjectVitals = {
          ...baseVitals,
          issues: correlateIssues(baseVitals.issues, projectSessions),
          prs: correlatePullRequests(baseVitals.prs, projectSessions),
        };

        return correlated;
      }),
    );

    const payload: GitHubVitalsResponse = {
      projects,
      fetchedAt: new Date().toISOString(),
    };

    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch GitHub vitals" },
      { status: 500 },
    );
  }
}
