import { describe, expect, it } from "vitest";
import { computeWindow, rowBounds, VIRTUAL_OVERSCAN, VIRTUAL_THRESHOLD } from "../virtualList";

describe("virtualList windowing", () => {
  it("handles empty arrays cleanly", () => {
    const empty = new Float32Array(0);
    expect(computeWindow(empty, 0, 600)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
    expect(rowBounds(empty, 0)).toEqual({ top: 0, bottom: 0, height: 0 });
    expect(rowBounds(empty, -1)).toEqual({ top: 0, bottom: 0, height: 0 });
  });

  it("preserves exact total height across 3,000 variable-height rows at any scroll offset", () => {
    const n = 3000;
    const heights = new Float32Array(n);
    let expectedTotal = 0;
    for (let i = 0; i < n; i++) {
      const h = 48 + (i % 5) * 14;
      heights[i] = h;
      expectedTotal += h;
    }

    expect(VIRTUAL_THRESHOLD).toBe(160);
    expect(VIRTUAL_OVERSCAN).toBe(20);

    for (const scrollTop of [0, 12_500, 95_000, expectedTotal - 500]) {
      const w = computeWindow(heights, scrollTop, 600, 10);
      expect(w.start).toBeGreaterThanOrEqual(0);
      expect(w.end).toBeLessThanOrEqual(n);
      expect(w.start).toBeLessThan(w.end);

      let visibleSum = 0;
      for (let i = w.start; i < w.end; i++) visibleSum += heights[i];
      expect(w.topPad + visibleSum + w.bottomPad).toBe(expectedTotal);
    }
  });

  it("computes accurate bounds and clamps out-of-range positions", () => {
    const heights = new Float32Array([50, 75, 100]);
    expect(rowBounds(heights, 0)).toEqual({ top: 0, bottom: 50, height: 50 });
    expect(rowBounds(heights, 1)).toEqual({ top: 50, bottom: 125, height: 75 });
    expect(rowBounds(heights, 2)).toEqual({ top: 125, bottom: 225, height: 100 });
    expect(rowBounds(heights, 99)).toEqual({ top: 125, bottom: 225, height: 100 });
    expect(rowBounds(heights, -3)).toEqual({ top: 0, bottom: 0, height: 0 });
  });
});
