import { describe, expect, it } from "vitest";
import type { Episode } from "../api";
import { isEpisodeDone, pickContinueHero, upsertRecentTop } from "../recent";

function makeEp(id: string, overrides: Partial<Episode> = {}): Episode {
  return {
    id,
    showId: "show-1",
    guid: id,
    title: `Episode ${id}`,
    progress: 0,
    hasTranscript: false,
    completed: false,
    audioUrl: `https://example.com/${id}.mp3`,
    duration: 1800,
    ...overrides,
  };
}

describe("recent hero & sync helpers", () => {
  it("detects completion via flag or 97% progress threshold", () => {
    expect(isEpisodeDone(makeEp("1", { completed: true, progress: 10 }))).toBe(true);
    expect(isEpisodeDone(makeEp("2", { duration: 1000, progress: 970 }))).toBe(true);
    expect(isEpisodeDone(makeEp("3", { duration: 1000, progress: 969 }))).toBe(false);
    expect(isEpisodeDone(makeEp("4", { duration: undefined, progress: 500 }))).toBe(false);
  });

  it("promotes the newly played episode to index 0 without duplicates", () => {
    const a = makeEp("a", { progress: 120 });
    const b = makeEp("b", { progress: 300 });
    const c = makeEp("c", { progress: 45 });

    const movedExisting = upsertRecentTop([a, b], { ...b, progress: 320 });
    expect(movedExisting.map((e) => e.id)).toEqual(["b", "a"]);
    expect(movedExisting[0].progress).toBe(320);

    const insertedNew = upsertRecentTop([a, b], c, 2);
    expect(insertedNew.map((e) => e.id)).toEqual(["c", "a"]);
  });

  it("picks live playing episode over stale recentEpisodes and supports backward scrubs", () => {
    const oldEp = makeEp("old", { progress: 420 });
    const subEp = makeEp("sub", { progress: 15, videoId: "vid-sub" });

    // Live playing subscribed episode not yet in recentEpisodes takes precedence.
    const hero1 = pickContinueHero([oldEp], { ep: subEp, time: 30 });
    expect(hero1?.id).toBe("sub");
    expect(hero1?.progress).toBe(30);

    // Backward scrub below threshold falls back cleanly when no longer >5s.
    const scrubbedBack = makeEp("old", { progress: 2 });
    const hero2 = pickContinueHero([scrubbedBack], { ep: scrubbedBack, time: 2 });
    expect(hero2).toBeNull();

    // Completed episode is skipped for the next incomplete episode.
    const doneEp = makeEp("done", { completed: true, progress: 1800 });
    const hero3 = pickContinueHero([doneEp, oldEp], { ep: doneEp, time: 1800 });
    expect(hero3?.id).toBe("old");
  });
});
