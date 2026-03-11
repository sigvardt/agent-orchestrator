import { cn } from "@/lib/cn";
import type {
  CostEstimate,
  DashboardUsageSnapshot,
  DashboardUsageSource,
  UsageDial,
  UsageProvider,
  UsageSnapshot,
} from "@/lib/types";

interface UsagePanelsProps {
  snapshots: DashboardUsageSnapshot[];
  compact?: boolean;
}

interface SessionUsageCardProps {
  cost: CostEstimate | null;
  snapshot: UsageSnapshot | null;
}

interface UsageSnapshotLike {
  provider: UsageProvider;
  plan?: string | null;
  capturedAt?: string | null;
  dials: UsageDial[];
}

const PROVIDER_META: Record<
  UsageProvider,
  { title: string; accent: string; glow: string; heading: string }
> = {
  codex: {
    title: "Codex",
    accent: "var(--color-accent-blue)",
    glow: "rgba(88,166,255,0.16)",
    heading: "ChatGPT Pro limits",
  },
  "claude-code": {
    title: "Claude Code",
    accent: "var(--color-accent-violet)",
    glow: "rgba(163,113,247,0.16)",
    heading: "claude.ai subscription",
  },
};

const TWO_LINE_CLAMP_STYLE = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
  overflow: "hidden",
} as const;

function formatResetTime(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null;

  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;

  const formatted = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

  return `Resets ${formatted.replace(",", "")}`;
}

function formatRelativeUpdate(capturedAt: string | null | undefined): string | null {
  if (!capturedAt) return null;

  const timestamp = new Date(capturedAt);
  if (Number.isNaN(timestamp.getTime())) return null;

  const diffMs = timestamp.getTime() - Date.now();
  const absSeconds = Math.abs(diffMs) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absSeconds < 60) {
    return "Last updated just now";
  }
  if (absSeconds < 3600) {
    return `Last updated ${rtf.format(Math.round(diffMs / 60_000), "minute")}`;
  }
  if (absSeconds < 86_400) {
    return `Last updated ${rtf.format(Math.round(diffMs / 3_600_000), "hour")}`;
  }
  return `Last updated ${rtf.format(Math.round(diffMs / 86_400_000), "day")}`;
}

function getSnapshotStatusLabel(source: DashboardUsageSource): string {
  switch (source) {
    case "live":
      return "Live";
    case "cached":
      return "Cached snapshot";
    case "empty":
      return "Awaiting first snapshot";
  }
}

function getEmptyDialDisplayValue(dial: UsageDial): string {
  switch (dial.kind) {
    case "percent_remaining":
      return "100%";
    case "percent_used":
      return "0%";
    case "absolute":
      return "Ready";
  }
}

function progressForDial(dial: UsageDial): number | null {
  if (dial.status === "unavailable") return null;
  if (dial.status === "unlimited") return 100;
  if (dial.value === null) return null;

  if (dial.kind === "absolute") {
    if (typeof dial.maxValue === "number" && dial.maxValue > 0) {
      return Math.min(100, Math.max(0, (dial.value / dial.maxValue) * 100));
    }
    return 100;
  }

  const maxValue = typeof dial.maxValue === "number" && dial.maxValue > 0 ? dial.maxValue : 100;
  return Math.min(100, Math.max(0, (dial.value / maxValue) * 100));
}

function valueClassName(displayValue: string, compact: boolean): string {
  if (displayValue.length >= 9) return compact ? "text-[9px]" : "text-[10px]";
  if (displayValue.length >= 6) return compact ? "text-[11px]" : "text-[13px]";
  return compact ? "text-[14px]" : "text-[16px]";
}

function CircularUsageDial({
  dial,
  accent,
  compact = false,
  source,
  capturedAt,
}: {
  dial: UsageDial;
  accent: string;
  compact?: boolean;
  source?: DashboardUsageSource;
  capturedAt?: string | null;
}) {
  const size = compact ? 84 : 92;
  const strokeWidth = compact ? 6 : 7;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const isEmptyState = source === "empty";
  const progress = isEmptyState ? 100 : progressForDial(dial);
  const dashOffset =
    progress === null ? circumference : circumference - (progress / 100) * circumference;
  const resetLabel = formatResetTime(dial.resetsAt);
  const displayValue =
    isEmptyState && dial.status === "unavailable"
      ? getEmptyDialDisplayValue(dial)
      : dial.displayValue;
  const helperText =
    source === "empty"
      ? "Starts tracking on first session"
      : dial.status === "unavailable"
        ? source === "cached"
          ? (formatRelativeUpdate(capturedAt) ?? "Snapshot unavailable")
          : "Live data unavailable"
        : (resetLabel ??
          (source === "cached"
            ? dial.kind === "absolute"
              ? "Last known balance"
              : "Last known usage"
            : dial.kind === "absolute"
              ? "Live balance"
              : "Live usage"));

  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-[12px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.02)] px-2.5",
        compact ? "py-2" : "py-2.5",
      )}
    >
      <div className="flex items-center justify-center">
        <div className="relative">
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="-rotate-90"
            aria-hidden="true"
          >
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={strokeWidth}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={
                dial.status === "unavailable"
                  ? isEmptyState
                    ? `color-mix(in srgb, ${accent} 36%, rgba(255,255,255,0.14))`
                    : "rgba(125,133,144,0.35)"
                  : accent
              }
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={
                dial.status === "unavailable"
                  ? isEmptyState
                    ? circumference
                    : `${circumference / 18} ${circumference / 22}`
                  : circumference
              }
              strokeDashoffset={dashOffset}
              style={{
                transition: "stroke-dashoffset 320ms ease, stroke 220ms ease",
                filter:
                  dial.status === "unavailable"
                    ? isEmptyState
                      ? `drop-shadow(0 0 10px color-mix(in srgb, ${accent} 18%, transparent))`
                      : "none"
                    : `drop-shadow(0 0 12px color-mix(in srgb, ${accent} 32%, transparent))`,
              }}
            />
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <div
              className={cn(
                "font-[var(--font-mono)] font-semibold tabular-nums text-[var(--color-text-primary)]",
                valueClassName(displayValue, compact),
              )}
            >
              {dial.status === "unlimited" ? "∞" : displayValue}
            </div>
            {dial.status === "unlimited" && (
              <div className="mt-0.5 text-[8px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                unlimited
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex-1 space-y-0.5 text-center">
        <div
          className="min-h-[2.5rem] text-[10px] font-medium leading-tight text-[var(--color-text-secondary)]"
          style={TWO_LINE_CLAMP_STYLE}
          title={dial.label}
        >
          {dial.label}
        </div>
        <div
          className="truncate text-[9px] leading-tight text-[var(--color-text-tertiary)]"
          title={helperText}
        >
          {helperText}
        </div>
      </div>
    </div>
  );
}

function UsageProviderSection({
  snapshot,
  compact = false,
  source,
}: {
  snapshot: UsageSnapshotLike;
  compact?: boolean;
  source?: DashboardUsageSource;
}) {
  const meta = PROVIDER_META[snapshot.provider];
  const updateLabel =
    source === "cached"
      ? formatRelativeUpdate(snapshot.capturedAt)
      : source === "empty"
        ? "Start a session to see usage."
        : null;

  return (
    <section
      className="overflow-hidden rounded-[14px] border border-[var(--color-border-default)]"
      style={{
        background: `linear-gradient(180deg, ${meta.glow} 0%, rgba(255,255,255,0.02) 32%, rgba(255,255,255,0.02) 100%)`,
        boxShadow: `0 14px 32px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.04)`,
      }}
    >
      <div className="border-b border-[var(--color-border-subtle)] px-3.5 py-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: meta.accent, boxShadow: `0 0 14px ${meta.glow}` }}
              />
              <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
                {meta.title}
              </h3>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.11em] text-[var(--color-text-tertiary)]">
              <span>{meta.heading}</span>
              {snapshot.plan && (
                <span className="rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 normal-case tracking-normal text-[10px]">
                  {snapshot.plan}
                </span>
              )}
            </div>
          </div>
          {source && (
            <div className="flex flex-col items-end gap-1 text-right">
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.11em]",
                  source === "live"
                    ? "border-[var(--color-border-subtle)] text-[var(--color-text-secondary)]"
                    : source === "cached"
                      ? "border-[rgba(255,184,108,0.35)] text-[rgb(255,200,132)]"
                      : "border-[var(--color-border-subtle)] text-[var(--color-text-tertiary)]",
                )}
              >
                {getSnapshotStatusLabel(source)}
              </span>
              {updateLabel && (
                <span className="text-[10px] text-[var(--color-text-tertiary)]">{updateLabel}</span>
              )}
            </div>
          )}
        </div>
      </div>
      <div
        className={cn(
          "grid gap-2.5 p-3",
          compact
            ? "grid-cols-2 md:grid-cols-3 xl:grid-cols-4"
            : "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6",
        )}
      >
        {snapshot.dials.map((dial) => (
          <CircularUsageDial
            key={`${snapshot.provider}-${dial.id}`}
            dial={dial}
            accent={meta.accent}
            compact={compact}
            source={source}
            capturedAt={snapshot.capturedAt}
          />
        ))}
      </div>
    </section>
  );
}

function UsageMetric({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-[12px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.03)] px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.11em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div
        className="mt-1 font-[var(--font-mono)] text-[18px] font-semibold tabular-nums"
        style={{ color: accent }}
      >
        {value}
      </div>
    </div>
  );
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.1 ? 3 : 2,
    maximumFractionDigits: value < 0.1 ? 3 : 2,
  }).format(value);
}

export function UsagePanels({ snapshots, compact = false }: UsagePanelsProps) {
  return (
    <div className="space-y-4">
      {snapshots.map((snapshot) => (
        <UsageProviderSection
          key={snapshot.provider}
          snapshot={snapshot}
          compact={compact}
          source={snapshot.source}
        />
      ))}
    </div>
  );
}

export function SessionUsageCard({ cost, snapshot }: SessionUsageCardProps) {
  if (!cost && !snapshot) {
    return null;
  }

  const accent = snapshot ? PROVIDER_META[snapshot.provider].accent : "var(--color-accent)";

  return (
    <div className="detail-card mb-6 rounded-[8px] border border-[var(--color-border-default)] p-5">
      <div className="mb-4 flex items-center gap-2">
        <div className="h-3 w-0.5 rounded-full" style={{ background: accent, opacity: 0.8 }} />
        <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
          Usage
        </span>
      </div>

      {cost && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <UsageMetric
            label="Input tokens"
            value={new Intl.NumberFormat("en-US").format(cost.inputTokens)}
            accent={accent}
          />
          <UsageMetric
            label="Output tokens"
            value={new Intl.NumberFormat("en-US").format(cost.outputTokens)}
            accent={accent}
          />
          <UsageMetric
            label="Estimated cost"
            value={formatCurrency(cost.estimatedCostUsd)}
            accent={accent}
          />
        </div>
      )}

      {snapshot && <UsageProviderSection snapshot={snapshot} compact />}
    </div>
  );
}
