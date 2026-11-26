import { beforeEach, describe, expect, it } from "vitest";
import {
  markYtBlocked,
  parseBlockedEntries,
  perceptualVolumeGain,
  RATES,
  requestYtStreamUrl,
  stepRate,
  unmarkYtBlocked,
  wasYtBlocked,
  YT_BLOCKED_TTL_MS,
} from "../../components/player/playerUtils";
import type { Episode } from "../api";
import { useStore } from "../../store";

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (idx: number) => Array.from(map.keys())[idx] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

function makeEp(id: string, overrides: Partial<Episode> = {}): Episode {
  return {
    id,
    showId: "show-1",
    guid: id,
    title: `Episode ${id}`,
    progress: 0,
    hasTranscript: false,
    completed: false,
    videoId: `vid-${id}`,
    ...overrides,
  };
}

describe("player blocklist TTL, stream dedup & playback pending state", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: makeMemoryStorage(),
      configurable: true,
      writable: true,
    });
    useStore.setState({
      current: null,
      playing: false,
      time: 0,
      length: 0,
      loadingSince: null,
      player: null,
      playWhenReady: null,
      seekWhenReady: null,
    });
  });

  it("expires yt-blocked entries after 7 days and expires legacy string arrays", () => {
    const t0 = 1_700_000_000_000;
    markYtBlocked("vid-a", t0);
    expect(wasYtBlocked("vid-a", t0 + 1000)).toBe(true);
    expect(wasYtBlocked("vid-a", t0 + YT_BLOCKED_TTL_MS - 1)).toBe(true);
    expect(wasYtBlocked("vid-a", t0 + YT_BLOCKED_TTL_MS)).toBe(false);

    unmarkYtBlocked("vid-a", t0);
    expect(wasYtBlocked("vid-a", t0 + 1000)).toBe(false);

    // Legacy string[] format without timestamps should expire so videos re-probe once.
    expect(parseBlockedEntries(JSON.stringify(["legacy-vid-1", "legacy-vid-2"]), t0)).toEqual([]);
  });

  it("deduplicates concurrent non-fresh stream requests and bypasses on fresh=true", async () => {
    let calls = 0;
    let resolveFirst!: (url: string) => void;
    const fetcher = (_id: string, fresh: boolean, signal?: AbortSignal) => {
      calls += 1;
      if (fresh) {
        return Promise.resolve("https://cdn.example.com/fresh.mp4");
      }
      return new Promise<string>((resolve, reject) => {
        resolveFirst = resolve;
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };

    const warmCtrl = new AbortController();
    const activeCtrl = new AbortController();
    const pWarm = requestYtStreamUrl("ep-1", { passive: true, signal: warmCtrl.signal, fetcher });
    const pActive = requestYtStreamUrl("ep-1", { passive: false, signal: activeCtrl.signal, fetcher });
    expect(calls).toBe(1);

    // Aborting passive warmer while active consumer still waits must not abort the fetch.
    warmCtrl.abort();
    await expect(pWarm).rejects.toThrow();
    resolveFirst("https://cdn.example.com/cached.mp4");
    await expect(pActive).resolves.toBe("https://cdn.example.com/cached.mp4");

    // fresh=true triggers a clean fresh request.
    const freshUrl = await requestYtStreamUrl("ep-1", { fresh: true, fetcher });
    expect(freshUrl).toBe("https://cdn.example.com/fresh.mp4");
    expect(calls).toBe(2);
  });

  it("aborts shared stream fetch when active consumer cancels even if passive warmer exists", async () => {
    let aborted = false;
    const fetcher = (_id: string, _fresh: boolean, signal?: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });

    const warmCtrl = new AbortController();
    const activeCtrl = new AbortController();
    const pWarm = requestYtStreamUrl("ep-2", { passive: true, signal: warmCtrl.signal, fetcher });
    const pActive = requestYtStreamUrl("ep-2", { passive: false, signal: activeCtrl.signal, fetcher });

    activeCtrl.abort();
    await expect(pActive).rejects.toThrow();
    await expect(pWarm).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it("clears loadingSince, playWhenReady and seekWhenReady on load switch and clearPlaybackPending", () => {
    const epA = makeEp("a", { progress: 120 });
    const epB = makeEp("b", { progress: 45 });

    const s = useStore.getState();
    s.load(epA);
    s.playSoon(epA.id);
    expect(useStore.getState().loadingSince).not.toBeNull();
    expect(useStore.getState().playWhenReady).toBe("a");

    // Calling clearPlaybackPending for a different episode does not disturb epA.
    s.clearPlaybackPending("other");
    expect(useStore.getState().loadingSince).not.toBeNull();

    // Switching to epB clears stale pending intents from epA.
    s.load(epB);
    expect(useStore.getState().current?.id).toBe("b");
    expect(useStore.getState().loadingSince).toBeNull();
    expect(useStore.getState().playWhenReady).toBeNull();
    expect(useStore.getState().seekWhenReady).toBeNull();

    // Seeking epB sets seekWhenReady + loadingSince; clearPlaybackPending resets all of them.
    s.seekToEpisode(epB, 300);
    expect(useStore.getState().seekWhenReady).toEqual({ id: "b", at: 300 });
    expect(useStore.getState().loadingSince).not.toBeNull();
    s.clearPlaybackPending("b");
    expect(useStore.getState().loadingSince).toBeNull();
    expect(useStore.getState().playing).toBe(false);
    expect(useStore.getState().playWhenReady).toBeNull();
    expect(useStore.getState().seekWhenReady).toBeNull();
  });

  it("maps perceptual cubic volume gain and clamps stepRate to player maxRate", () => {
    expect(perceptualVolumeGain(0)).toBe(0);
    expect(perceptualVolumeGain(-0.5)).toBe(0);
    expect(perceptualVolumeGain(0.5)).toBeCloseTo(0.125, 5);
    expect(perceptualVolumeGain(1)).toBe(1);
    expect(RATES).toContain(3);

    let appliedRate = 1;
    useStore.setState({
      prefs: { ...useStore.getState().prefs, playbackRate: 2 },
      player: {
        episodeId: "ep-yt",
        seek: () => {},
        toggle: () => {},
        play: () => {},
        setRate: (r) => {
          appliedRate = r;
        },
        maxRate: 2,
      },
    });
    stepRate(1);
    expect(appliedRate).toBe(2);
    expect(useStore.getState().prefs.playbackRate).toBe(2);

    stepRate(-1);
    expect(appliedRate).toBe(1.75);
  });
});
