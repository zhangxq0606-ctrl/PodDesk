import { describe, expect, it } from "vitest";
import { episodeExternalUrl, isBilibiliEpisode, isYouTubeEpisode, parseVideoSource } from "../videoSource";
import type { Episode } from "../api";

function epWith(videoId?: string, link?: string): Episode {
  return {
    id: "ep1",
    showId: "single",
    guid: "g1",
    title: "Demo",
    videoId,
    link,
    progress: 0,
    hasTranscript: false,
    completed: false,
  };
}

describe("videoSource", () => {
  it("parses youtube and bilibili encoded videoIds cleanly", () => {
    expect(parseVideoSource("dQw4w9WgXcQ")).toEqual({ kind: "youtube", id: "dQw4w9WgXcQ" });
    expect(parseVideoSource("bili:BV1xx411c7mD")).toEqual({
      kind: "bilibili",
      bvid: "BV1xx411c7mD",
      page: 1,
    });
    expect(parseVideoSource("bili:BV1xx411c7mD:3")).toEqual({
      kind: "bilibili",
      bvid: "BV1xx411c7mD",
      page: 3,
    });
    expect(parseVideoSource(undefined)).toBeNull();
  });

  it("distinguishes sources and formats timestamped external URLs", () => {
    const yt = epWith("dQw4w9WgXcQ");
    expect(isYouTubeEpisode(yt)).toBe(true);
    expect(isBilibiliEpisode(yt)).toBe(false);
    expect(episodeExternalUrl(yt, 95)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s");

    const biliP1 = epWith("bili:BV1xx411c7mD");
    expect(isBilibiliEpisode(biliP1)).toBe(true);
    expect(isYouTubeEpisode(biliP1)).toBe(false);
    expect(episodeExternalUrl(biliP1, 0)).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
    expect(episodeExternalUrl(biliP1, 42)).toBe("https://www.bilibili.com/video/BV1xx411c7mD?t=42");

    const biliP3 = epWith("bili:BV1xx411c7mD:3");
    expect(episodeExternalUrl(biliP3, 42)).toBe("https://www.bilibili.com/video/BV1xx411c7mD?p=3&t=42");
  });
});
