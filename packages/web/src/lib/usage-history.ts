/**
 * Usage history storage and estimation engine.
 *
 * Records per-dial usage data points and uses them to estimate current
 * subscription consumption when no active session is running.
 *
 * Storage: ~/.agent-orchestrator/usage-history.json (global, not per-project,
 * because subscription limits are account-wide).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { UsageDial, UsageProvider, UsageSnapshot } from "@syntese/core";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum data points stored per dial; oldest entries are dropped beyond this. */
const MAX_POINTS_PER_DIAL = 200;

const HISTORY_FILE_VERSION = 1;

/** Minimum data points per dial before estimation is shown. */
export const MIN_POINTS_FOR_ESTIMATE = 5;

/** Data points needed to reach full (1.0) confidence. */
const HIGH_CONFIDENCE_POINTS = 50;

// ─── Data Model ──────────────────────────────────────────────────────────────

export interface UsageDataPoint {
  /** Unix timestamp in milliseconds when the value was recorded. */
  timestamp: number;
  /** Dial value at recording time (0-100 for percent dials, raw for absolute). */
  value: number;
  /** Dial identifier, e.g. "codex-5h". */
  dialId: string;
}

interface UsageHistoryFile {
  version: number;
  dataPoints: UsageDataPoint[];
}

// ─── Dial Window Configuration ───────────────────────────────────────────────

type WindowType = "rolling" | "none";

interface DialConfig {
  windowType: WindowType;
  /** Rolling window duration in milliseconds. 0 for "none". */
  windowMs: number;
  kind: "percent_used" | "percent_remaining" | "absolute";
}

/**
 * Recovery window configuration for each known dial.
 *
 * Rolling window logic: usage from more than `windowMs` ago has fully "fallen
 * off", so the dial recovers linearly toward its limit over that period.
 */
const DIAL_CONFIGS: Record<string, DialConfig> = {
  "codex-5h": {
    windowType: "rolling",
    windowMs: 5 * 60 * 60 * 1000,
    kind: "percent_remaining",
  },
  "codex-weekly": {
    windowType: "rolling",
    windowMs: 7 * 24 * 60 * 60 * 1000,
    kind: "percent_remaining",
  },
  "codex-spark-5h": {
    windowType: "rolling",
    windowMs: 5 * 60 * 60 * 1000,
    kind: "percent_remaining",
  },
  "codex-spark-weekly": {
    windowType: "rolling",
    windowMs: 7 * 24 * 60 * 60 * 1000,
    kind: "percent_remaining",
  },
  "codex-code-review": {
    windowType: "rolling",
    windowMs: 24 * 60 * 60 * 1000,
    kind: "percent_remaining",
  },
  // Credits don't recover automatically — skip estimation.
  "codex-credits": { windowType: "none", windowMs: 0, kind: "absolute" },
  "claude-current-session": {
    windowType: "rolling",
    windowMs: 5 * 60 * 60 * 1000,
    kind: "percent_used",
  },
  "claude-weekly-all-models": {
    windowType: "rolling",
    windowMs: 7 * 24 * 60 * 60 * 1000,
    kind: "percent_used",
  },
  "claude-weekly-sonnet-only": {
    windowType: "rolling",
    windowMs: 7 * 24 * 60 * 60 * 1000,
    kind: "percent_used",
  },
};

// ─── File I/O ─────────────────────────────────────────────────────────────────

function getHistoryFilePath(): string {
  return join(homedir(), ".agent-orchestrator", "usage-history.json");
}

async function loadHistory(): Promise<UsageHistoryFile> {
  try {
    const raw = await readFile(getHistoryFilePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { version: HISTORY_FILE_VERSION, dataPoints: [] };
    }

    const candidate = parsed as Partial<UsageHistoryFile>;
    if (!Array.isArray(candidate.dataPoints)) {
      return { version: HISTORY_FILE_VERSION, dataPoints: [] };
    }

    const dataPoints = candidate.dataPoints.filter(
      (p): p is UsageDataPoint =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as UsageDataPoint).timestamp === "number" &&
        typeof (p as UsageDataPoint).value === "number" &&
        typeof (p as UsageDataPoint).dialId === "string",
    );

    return { version: HISTORY_FILE_VERSION, dataPoints };
  } catch {
    return { version: HISTORY_FILE_VERSION, dataPoints: [] };
  }
}

async function saveHistory(history: UsageHistoryFile): Promise<void> {
  const path = getHistoryFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(history, null, 2) + "\n", "utf-8");
}

// ─── Public: Record ──────────────────────────────────────────────────────────

/**
 * Append data points from live snapshots to the history store.
 * Silently no-ops on I/O errors — history recording is best-effort.
 */
export async function recordUsageSnapshots(snapshots: UsageSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return;

  const history = await loadHistory();
  const now = Date.now();

  const newPoints: UsageDataPoint[] = [];
  for (const snapshot of snapshots) {
    const snapshotTs = Date.parse(snapshot.capturedAt);
    const ts = Number.isNaN(snapshotTs) ? now : snapshotTs;
    for (const dial of snapshot.dials) {
      if (dial.status !== "available" || dial.value === null) continue;
      newPoints.push({ timestamp: ts, value: dial.value, dialId: dial.id });
    }
  }

  if (newPoints.length === 0) return;

  const combined = [...history.dataPoints, ...newPoints];

  // Group by dialId and retain only the most recent MAX_POINTS_PER_DIAL entries.
  const byDial = new Map<string, UsageDataPoint[]>();
  for (const point of combined) {
    const arr = byDial.get(point.dialId) ?? [];
    arr.push(point);
    byDial.set(point.dialId, arr);
  }

  const trimmed: UsageDataPoint[] = [];
  for (const [, points] of byDial) {
    const sorted = points.slice().sort((a, b) => a.timestamp - b.timestamp);
    trimmed.push(...sorted.slice(-MAX_POINTS_PER_DIAL));
  }

  await saveHistory({ version: HISTORY_FILE_VERSION, dataPoints: trimmed });
}

// ─── Public: Estimate ────────────────────────────────────────────────────────

/**
 * Estimate the current value of a single dial using the recovery model.
 *
 * Returns null when:
 * - The dial has no recoverable window (e.g. absolute credits dial)
 * - Not enough historical data (< MIN_POINTS_FOR_ESTIMATE)
 * - No meaningful recovery can be computed
 */
export function estimateDialValue(
  dial: UsageDial,
  capturedAtMs: number,
  dataPointCount: number,
): { estimatedDial: UsageDial; confidence: number } | null {
  if (dial.status !== "available" || dial.value === null) return null;
  if (dataPointCount < MIN_POINTS_FOR_ESTIMATE) return null;

  const config = DIAL_CONFIGS[dial.id];
  if (!config || config.windowType === "none") return null;

  const now = Date.now();
  const elapsedMs = now - capturedAtMs;
  if (elapsedMs <= 0) return null;

  // Check if a calendar reset has already occurred (resetsAt is in the past).
  if (dial.resetsAt) {
    const resetMs = Date.parse(dial.resetsAt);
    if (!Number.isNaN(resetMs) && now >= resetMs) {
      const recoveredValue = config.kind === "percent_remaining" ? 100 : 0;
      const confidence = Math.min(1.0, dataPointCount / HIGH_CONFIDENCE_POINTS);
      return {
        estimatedDial: buildEstimatedDial(dial, recoveredValue, confidence),
        confidence,
      };
    }
  }

  // Rolling window: linear recovery toward fully-recovered state.
  const recoveryFraction = Math.min(1.0, elapsedMs / config.windowMs);

  let estimatedValue: number;
  if (config.kind === "percent_remaining") {
    // Value recovers toward 100%.
    estimatedValue = dial.value + (100 - dial.value) * recoveryFraction;
  } else {
    // percent_used: value decreases toward 0%.
    estimatedValue = dial.value * (1 - recoveryFraction);
  }

  estimatedValue = Math.min(100, Math.max(0, estimatedValue));
  const confidence = Math.min(1.0, dataPointCount / HIGH_CONFIDENCE_POINTS);

  return {
    estimatedDial: buildEstimatedDial(dial, Math.round(estimatedValue), confidence),
    confidence,
  };
}

function buildEstimatedDial(
  original: UsageDial,
  estimatedValue: number,
  confidence: number,
): UsageDial {
  return {
    ...original,
    value: estimatedValue,
    displayValue: `~${estimatedValue}%`,
    isEstimated: true,
    estimationConfidence: confidence,
  };
}

/**
 * Given a cached snapshot, attempt to produce an estimated snapshot by
 * applying the recovery model to each dial that has enough history.
 *
 * Returns null when no dials can be estimated (not enough history, or all
 * dials are absolute/non-recoverable).
 */
export async function tryBuildEstimatedSnapshot(
  snapshot: UsageSnapshot,
): Promise<UsageSnapshot | null> {
  const history = await loadHistory();

  // Count data points per dial from history.
  const countByDial = new Map<string, number>();
  for (const point of history.dataPoints) {
    countByDial.set(point.dialId, (countByDial.get(point.dialId) ?? 0) + 1);
  }

  const capturedAtMs = Date.parse(snapshot.capturedAt);
  if (Number.isNaN(capturedAtMs)) return null;

  let anyEstimated = false;
  const estimatedDials = snapshot.dials.map((dial) => {
    const count = countByDial.get(dial.id) ?? 0;
    const result = estimateDialValue(dial, capturedAtMs, count);
    if (result) {
      anyEstimated = true;
      return result.estimatedDial;
    }
    return dial;
  });

  if (!anyEstimated) return null;

  return { ...snapshot, dials: estimatedDials };
}

/**
 * Returns the number of recorded data points for a given dial.
 * Exposed for testing.
 */
export async function getDataPointCount(
  dialId: string,
  provider?: UsageProvider,
): Promise<number> {
  const history = await loadHistory();
  return history.dataPoints.filter(
    (p) => p.dialId === dialId && (provider === undefined || true),
  ).length;
}
