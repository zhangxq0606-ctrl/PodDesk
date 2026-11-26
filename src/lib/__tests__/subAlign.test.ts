import { beforeEach, describe, expect, it } from "vitest";
import {
  alignSegmentToTime,
  clampOffset,
  formatOffsetLabel,
  toPlaybackTime,
  toSubtitleTime,
  useSubAlign,
} from "../subAlign";

describe("subAlign helpers and store", () => {
  beforeEach(() => {
    useSubAlign.setState({ offsets: {} });
  });

  it("clamps and rounds offsets cleanly", () => {
    expect(clampOffset(Number.NaN)).toBe(0);
    expect(clampOffset(0.02)).toBe(0);
    expect(clampOffset(12.34)).toBe(12.3);
    expect(clampOffset(-2500)).toBe(-1800);
    expect(clampOffset(2500)).toBe(1800);
  });

  it("maps between playback clock and subtitle clock symmetrically", () => {
    const offset = alignSegmentToTime(60, 74.5);
    expect(offset).toBe(14.5);
    expect(toSubtitleTime(74.5, offset)).toBe(60);
    expect(toPlaybackTime(60, offset)).toBe(74.5);
    expect(toSubtitleTime(5, offset)).toBe(0);
  });

  it("formats readable offset labels", () => {
    expect(formatOffsetLabel(0)).toBe("未偏移");
    expect(formatOffsetLabel(12)).toBe("延后 12s");
    expect(formatOffsetLabel(-3.5)).toBe("提前 3.5s");
  });

  it("nudges and resets per-episode offsets in store", () => {
    const { nudgeOffset, resetOffset } = useSubAlign.getState();
    expect(nudgeOffset("ep-1", 1)).toBe(1);
    expect(nudgeOffset("ep-1", -1)).toBe(0);
    expect(useSubAlign.getState().offsets["ep-1"]).toBeUndefined();

    nudgeOffset("ep-1", -5);
    expect(useSubAlign.getState().offsets["ep-1"]).toBe(-5);
    resetOffset("ep-1");
    expect(useSubAlign.getState().offsets["ep-1"]).toBeUndefined();
  });
});
