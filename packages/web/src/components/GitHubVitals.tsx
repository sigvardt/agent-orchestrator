"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import type {
  GitHubProjectVitals,
  GitHubVitalsCIStatus,
  GitHubVitalsCommit,
  GitHubVitalsIssue,
  GitHubVitalsPullRequest,
  GitHubVitalsResponse,
} from "@/lib/types";
import { VitalsFoldDown } from "./VitalsFoldDown";

interface GitHubVitalsProps {
  projectName?: string;
  projectId?: string;
  refreshIntervalMs?: number;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "n/a";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "n/a";
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ciDotClass(status: GitHubVitalsCIStatus): string {
  if (status === "passing") return "bg-[var(--color-status-ready)]";
  if (status === "failing") return "bg-[var(--color-status-error)]";
  if (status === "pending") return "bg-[var(--color-status-attention)]";
  return "bg-[var(--color-text-tertiary)]";
}

export function GitHubVitals({
  projectName,
  projectId,
  refreshIntervalMs = 45_000,
}: GitHubVitalsProps) {
  const [vitals, setVitals] = useState<GitHubVitalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchVitals = async () => {
      try {
        const query = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
        const response = await fetch(`/api/vitals${query}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as GitHubVitalsResponse;
        if (!cancelled) {
          startTransition(() => {
            setVitals(data);
            setError(null);
            setLoading(false);
          });
        }
      } catch (fetchError) {
        if (!cancelled) {
          startTransition(() => {
            setError(fetchError instanceof Error ? fetchError.message : "Failed to fetch vitals");
            setLoading(false);
          });
        }
      }
    };

    void fetchVitals();
    const intervalId = window.setInterval(() => {
      void fetchVitals();
    }, refreshIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [projectId, refreshIntervalMs]);

  const aggregate = useMemo(() => {
    const projects = vitals?.projects ?? [];
    const issues = projects.flatMap((project) => project.issues);
    const prs = projects.flatMap((project) => project.prs);
    const commits = projects.flatMap((project) => project.commits);
    const degraded = projects.some((project) => project.degraded);
    return { projects, issues, prs, commits, degraded };
  }, [vitals]);

  return (
    <section className="mb-8 rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            GitHub Vitals
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
            {projectName ? `${projectName} repository pulse` : "Repository pulse across configured projects"}
          </p>
        </div>
        <div className="text-right text-[11px] text-[var(--color-text-tertiary)]">
          {vitals?.fetchedAt ? `Updated ${relativeTime(vitals.fetchedAt)}` : ""}
        </div>
      </div>

      {loading && !vitals ? (
        <div className="rounded-[8px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.03)] px-3 py-2.5 text-[12px] text-[var(--color-text-secondary)]">
          Loading GitHub vitals...
        </div>
      ) : error && !vitals ? (
        <div className="rounded-[8px] border border-[rgba(248,81,73,0.25)] bg-[rgba(248,81,73,0.08)] px-3 py-2.5 text-[12px] text-[var(--color-status-error)]">
          GitHub vitals unavailable ({error}).
        </div>
      ) : (
        <div className="space-y-3">
          {aggregate.degraded && (
            <div className="rounded-[8px] border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.08)] px-3 py-2 text-[11px] text-[var(--color-status-attention)]">
              Some repositories are temporarily degraded. Showing the freshest available data.
            </div>
          )}

          <div className="grid gap-2 md:grid-cols-3">
            <VitalsFoldDown
              title="Open issues"
              count={aggregate.issues.length}
              accentClassName="bg-[rgba(88,166,255,0.14)] text-[var(--color-accent)]"
              defaultOpen
            >
              <IssueList issues={aggregate.issues} />
            </VitalsFoldDown>

            <VitalsFoldDown
              title="Open PRs"
              count={aggregate.prs.length}
              accentClassName="bg-[rgba(63,185,80,0.14)] text-[var(--color-status-ready)]"
              defaultOpen
            >
              <PRList prs={aggregate.prs} />
            </VitalsFoldDown>

            <VitalsFoldDown
              title="Recent commits"
              count={aggregate.commits.length}
              accentClassName="bg-[rgba(255,255,255,0.10)] text-[var(--color-text-secondary)]"
            >
              <CommitList commits={aggregate.commits} />
            </VitalsFoldDown>
          </div>

          <RecencyGrid projects={aggregate.projects} />
        </div>
      )}
    </section>
  );
}

function IssueList({ issues }: { issues: GitHubVitalsIssue[] }) {
  if (issues.length === 0) {
    return <div className="text-[12px] text-[var(--color-text-tertiary)]">No open issues.</div>;
  }

  return (
    <ul className="space-y-1.5">
      {issues.map((issue) => (
        <li key={`${issue.owner}/${issue.repo}#${issue.number}`} className="text-[12px]">
          <a
            href={issue.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
          >
            #{issue.number} {issue.title}
          </a>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
            <span>{issue.owner + "/" + issue.repo}</span>
            <span>&middot;</span>
            <span>{relativeTime(issue.updatedAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PRList({ prs }: { prs: GitHubVitalsPullRequest[] }) {
  if (prs.length === 0) {
    return <div className="text-[12px] text-[var(--color-text-tertiary)]">No open pull requests.</div>;
  }

  return (
    <ul className="space-y-1.5">
      {prs.map((pr) => (
        <li key={`${pr.owner}/${pr.repo}#${pr.number}`} className="text-[12px]">
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
          >
            #{pr.number} {pr.title}
          </a>

          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
            <span className={`h-2 w-2 rounded-full ${ciDotClass(pr.ciStatus)}`} />
            <span className="uppercase">{pr.ciStatus}</span>
            <span>&middot;</span>
            <span>{pr.owner + "/" + pr.repo}</span>
            <span>&middot;</span>
            <span>{relativeTime(pr.updatedAt)}</span>
          </div>

          {pr.correlations.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {pr.correlations.map((match) => (
                <span
                  key={`${pr.number}:${match.sessionId}`}
                  className="rounded-full bg-[rgba(88,166,255,0.14)] px-1.5 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-accent)]"
                  title={`matched by ${match.reason}`}
                >
                  {match.sessionId}
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function CommitList({ commits }: { commits: GitHubVitalsCommit[] }) {
  if (commits.length === 0) {
    return <div className="text-[12px] text-[var(--color-text-tertiary)]">No recent commits.</div>;
  }

  return (
    <ul className="space-y-1.5">
      {commits.map((commit) => (
        <li key={`${commit.owner}/${commit.repo}:${commit.sha}`} className="text-[12px]">
          <a
            href={commit.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--color-text-primary)] hover:text-[var(--color-accent)]"
          >
            {commit.shortSha} {commit.message}
          </a>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)]">
            <span>{commit.author}</span>
            <span>&middot;</span>
            <span>{commit.owner + "/" + commit.repo}</span>
            <span>&middot;</span>
            <span>{relativeTime(commit.pushedAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RecencyGrid({ projects }: { projects: GitHubProjectVitals[] }) {
  if (projects.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2 md:grid-cols-3">
      {projects.map((project) => (
        <div
          key={project.projectId}
          className="rounded-[8px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)] px-3 py-2"
        >
          <div className="mb-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            {project.projectId}
          </div>
          <div className="space-y-0.5 text-[10px] text-[var(--color-text-tertiary)]">
            <div>last closed issue: {relativeTime(project.recency.lastIssueClosedAt)}</div>
            <div>last merged PR: {relativeTime(project.recency.lastPRMergedAt)}</div>
            <div>last push: {relativeTime(project.recency.lastCommitPushedAt)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
