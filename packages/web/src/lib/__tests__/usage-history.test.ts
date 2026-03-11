import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageDial, UsageSnapshot } from "@composio/ao-core";
import {
  MIN_POINTS_FOR_ESTIMATE,
  estimateDialValue,
  recordUsageSnapshots,
  tryBuildEstimatedSnapshot,
} from "../usage-history";

const originalHome = process.env["HOME"];
let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "ao-usage-history-"));
  process.env["HOME"] = tempHome;
});

afterEach(async () => {
  if (originalHome) {
    process.env["HOME"] = originalHome;
  } else {
    delete process.env["HOME"];
  }
  await rm(tempHome, { recursive: true, force: true });
});

function makePercentRemainingDial(id: string, value: number, resetsAt?: string): UsageDial {
  return {
    id,
    label: "Test dial",
    kind: "percent_remaining",
    status: "available",
    value,
    maxValue: 100,
    displayValue: `${value}%`,
    resetsAt: resetsAt ?? null,
  };
}

function makePercentUsedDial(id: string, value: number): UsageDial {
  return {
    id,
    label: "Test dial",
    kind: "percent_used",
    status: "available",
    value,
    maxValue: 100,
    displayValue: `${value}%`,
    resetsAt: null,
  };
}

function makeSnapshot(
  provider: "codex" | "claude-code",
  dials: UsageDial[],
  capturedAt?: string,
): UsageSnapshot {
  return {
    provider,
    plan: null,
    capturedAt: capturedAt ?? new Date().toISOString(),
    dials,
  };
}

// ─── estimateDialValue ────────────────────────────────────────────────────────

describe("estimateDialValue", () => {
  it("returns null when dial is unavailable", () => {
    const dial: UsageDial = {
      id: "codex-5h",
      label: "5h",
      kind: "percent_remaining",
      status: "unavailable",
      value: null,
      displayValue: "--",
    };
    expect(estimateDialValue(dial, Date.now() - 3_600_000, 10)).toBeNull();
  });

  it("returns null when fewer than MIN_POINTS_FOR_ESTIMATE data points", () => {
    const dial = makePercentRemainingDial("codex-5h", 60);
    expect(
      estimateDialValue(dial, Date.now() - 3_600_000, MIN_POINTS_FOR_ESTIMATE - 1),
    ).toBeNull();
  });

  it("returns null for absolute dials (codex-credits)", () => {
    const dial: UsageDial = {
      id: "codex-credits",
      label: "Credits",
      kind: "absolute",
      status: "available",
      value: 50,
      displayValue: "$50",
    };
    expect(estimateDialValue(dial, Date.now() - 3_600_000, 10)).toBeNull();
  });

  it("returns null for unknown dial IDs", () => {
    const dial: UsageDial = {
      id: "unknown-dial",
      label: "Unknown",
      kind: "percent_remaining",
      status: "available",
      value: 50,
      displayValue: "50%",
    };
    expect(estimateDialValue(dial, Date.now() - 3_600_000, 10)).toBeNull();
  });

  it("estimates recovery for percent_remaining (codex-5h) rolling window", () => {
    const dial = makePercentRemainingDial("codex-5h", 40);
    const windowMs = 5 * 60 * 60 * 1000;
    // Half the window has passed: should recover halfway toward 100%
    const capturedAtMs = Date.now() - windowMs / 2;

    const result = estimateDialValue(dial, capturedAtMs, 10);
    expect(result).not.toBeNull();
    // At half the window: 40 + (100 - 40) * 0.5 = 40 + 30 = 70
    expect(result!.estimatedDial.value).toBe(70);
    expect(result!.estimatedDial.isEstimated).toBe(true);
    expect(result!.estimatedDial.displayValue).toBe("~70%");
  });

  it("estimates recovery for percent_used (claude-current-session) rolling window", () => {
    const dial = makePercentUsedDial("claude-current-session", 60);
    const windowMs = 5 * 60 * 60 * 1000;
    // Full window has passed: value should drop to 0%
    const capturedAtMs = Date.now() - windowMs;

    const result = estimateDialValue(dial, capturedAtMs, 10);
    expect(result).not.toBeNull();
    expect(result!.estimatedDial.value).toBe(0);
    expect(result!.estimatedDial.isEstimated).toBe(true);
  });

  it("clamps estimated value to [0, 100]", () => {
    const dial = makePercentRemainingDial("codex-5h", 98);
    // More than full window elapsed: should clamp at 100
    const capturedAtMs = Date.now() - 10 * 60 * 60 * 1000;

    const result = estimateDialValue(dial, capturedAtMs, 10);
    expect(result).not.toBeNull();
    expect(result!.estimatedDial.value).toBe(100);
  });

  it("returns estimated value = 100% remaining when resetsAt is in the past", () => {
    const pastReset = new Date(Date.now() - 60_000).toISOString();
    const dial = makePercentRemainingDial("codex-5h", 30, pastReset);

    const result = estimateDialValue(dial, Date.now() - 3_600_000, 10);
    expect(result).not.toBeNull();
    expect(result!.estimatedDial.value).toBe(100);
    expect(result!.estimatedDial.isEstimated).toBe(true);
  });

  it("sets confidence proportional to data point count", () => {
    const dial = makePercentRemainingDial("codex-5h", 60);
    const capturedAtMs = Date.now() - 3_600_000;

    const result5 = estimateDialValue(dial, capturedAtMs, 5);
    const result25 = estimateDialValue(dial, capturedAtMs, 25);
    const result50 = estimateDialValue(dial, capturedAtMs, 50);
    const result100 = estimateDialValue(dial, capturedAtMs, 100);

    expect(result5!.confidence).toBe(5 / 50);
    expect(result25!.confidence).toBe(0.5);
    expect(result50!.confidence).toBe(1.0);
    expect(result100!.confidence).toBe(1.0); // capped at 1
  });
});

// ─── recordUsageSnapshots + tryBuildEstimatedSnapshot ────────────────────────

describe("recordUsageSnapshots + tryBuildEstimatedSnapshot", () => {
  it("returns null when no history exists", async () => {
    const snapshot = makeSnapshot("codex", [makePercentRemainingDial("codex-5h", 60)]);
    const result = await tryBuildEstimatedSnapshot(snapshot);
    expect(result).toBeNull();
  });

  it("returns null when fewer than MIN_POINTS_FOR_ESTIMATE data points recorded", async () => {
    const dial = makePercentRemainingDial("codex-5h", 60);
    // Record only 4 snapshots (< 5)
    for (let i = 0; i < MIN_POINTS_FOR_ESTIMATE - 1; i++) {
      await recordUsageSnapshots([
        makeSnapshot("codex", [dial], new Date(Date.now() - i * 3_600_000).toISOString()),
      ]);
    }

    // Try to estimate from a snapshot taken 2 hours ago
    const staleSnapshot = makeSnapshot(
      "codex",
      [dial],
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
    );
    const result = await tryBuildEstimatedSnapshot(staleSnapshot);
    expect(result).toBeNull();
  });

  it("returns estimated snapshot after MIN_POINTS_FOR_ESTIMATE recordings", async () => {
    const dial = makePercentRemainingDial("codex-5h", 40);

    // Record MIN_POINTS_FOR_ESTIMATE snapshots
    for (let i = 0; i < MIN_POINTS_FOR_ESTIMATE; i++) {
      await recordUsageSnapshots([
        makeSnapshot("codex", [dial], new Date(Date.now() - i * 600_000).toISOString()),
      ]);
    }

    // Stale snapshot from 2.5h ago (half of 5h window)
    const staleSnapshot = makeSnapshot(
      "codex",
      [dial],
      new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString(),
    );
    const result = await tryBuildEstimatedSnapshot(staleSnapshot);
    expect(result).not.toBeNull();

    const estimatedDial = result!.dials.find((d) => d.id === "codex-5h");
    expect(estimatedDial?.isEstimated).toBe(true);
    // At half window: 40 + (100 - 40) * 0.5 = 70
    expect(estimatedDial?.value).toBe(70);
    expect(estimatedDial?.displayValue).toBe("~70%");
  });

  it("does not estimate absolute (credits) dials", async () => {
    const creditsDial: UsageDial = {
      id: "codex-credits",
      label: "Credits",
      kind: "absolute",
      status: "available",
      value: 50,
      displayValue: "$50",
    };

    for (let i = 0; i < MIN_POINTS_FOR_ESTIMATE; i++) {
      await recordUsageSnapshots([makeSnapshot("codex", [creditsDial])]);
    }

    const staleSnapshot = makeSnapshot(
      "codex",
      [creditsDial],
      new Date(Date.now() - 3_600_000).toISOString(),
    );
    const result = await tryBuildEstimatedSnapshot(staleSnapshot);
    // No estimatable dials → null
    expect(result).toBeNull();
  });

  it("persists up to MAX_POINTS_PER_DIAL=200 per dial and trims older ones", async () => {
    const dial = makePercentRemainingDial("codex-5h", 50);

    // Record 210 data points
    for (let i = 0; i < 210; i++) {
      await recordUsageSnapshots([
        makeSnapshot("codex", [dial], new Date(Date.now() - i * 60_000).toISOString()),
      ]);
    }

    // Should still work (doesn't throw or corrupt)
    const staleSnapshot = makeSnapshot(
      "codex",
      [dial],
      new Date(Date.now() - 3_600_000).toISOString(),
    );
    const result = await tryBuildEstimatedSnapshot(staleSnapshot);
    expect(result).not.toBeNull();
    expect(result!.dials[0]?.isEstimated).toBe(true);
  });

  it("handles mixed dials: estimates recoverable ones, passes through others", async () => {
    const recoverableDial = makePercentRemainingDial("codex-5h", 40);
    const creditsDial: UsageDial = {
      id: "codex-credits",
      label: "Credits",
      kind: "absolute",
      status: "available",
      value: 75,
      displayValue: "$75",
    };

    for (let i = 0; i < MIN_POINTS_FOR_ESTIMATE; i++) {
      await recordUsageSnapshots([makeSnapshot("codex", [recoverableDial, creditsDial])]);
    }

    const staleSnapshot = makeSnapshot(
      "codex",
      [recoverableDial, creditsDial],
      new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString(),
    );
    const result = await tryBuildEstimatedSnapshot(staleSnapshot);
    expect(result).not.toBeNull();

    const estimated5h = result!.dials.find((d) => d.id === "codex-5h");
    const estimatedCredits = result!.dials.find((d) => d.id === "codex-credits");

    expect(estimated5h?.isEstimated).toBe(true);
    expect(estimatedCredits?.isEstimated).toBeUndefined(); // not estimated
    expect(estimatedCredits?.value).toBe(75); // unchanged
  });
});
