import { describe, expect, it } from "vitest";
import { clock, formatBytes, formatDuration, formatPublishDate, monthKey, notesText, parseClock } from "../format";

describe("format utilities", () => {
  it("formats and parses playback clock strings", () => {
    expect(clock(-4)).toBe("00:00");
    expect(clock(125)).toBe("02:05");
    expect(clock(3605)).toBe("1:00:05");

    expect(parseClock("02:05")).toBe(125);
    expect(parseClock("1:00:05")).toBe(3605);
    expect(parseClock("42")).toBeNull();
    expect(parseClock("1:2:3:4")).toBeNull();
    expect(parseClock("ab:cd")).toBeNull();
  });

  it("formats durations cleanly across seconds, minutes, and hours", () => {
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(45)).toBe("45 秒");
    expect(formatDuration(180)).toBe("3 分钟");
    expect(formatDuration(5400)).toBe("1 小时 30 分");
  });

  it("formats byte sizes and dates", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");

    const ts = new Date(2026, 2, 9, 12, 0, 0).getTime();
    expect(formatPublishDate(ts)).toBe("2026-03-09");
    expect(monthKey(ts)).toBe("2026-03");
    expect(formatPublishDate(undefined)).toBe("");
  });

  it("handles empty notesText safely", () => {
    expect(notesText("")).toBe("");
    expect(notesText(null)).toBe("");
    expect(notesText(undefined)).toBe("");
  });
});
