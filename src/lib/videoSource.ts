import type { Episode } from "./api";

export type ParsedVideoSource =
  | { kind: "youtube"; id: string }
  | { kind: "bilibili"; bvid: string; page: number };

export function parseVideoSource(videoId?: string | null): ParsedVideoSource | null {
  if (!videoId) return null;
  if (videoId.startsWith("bili:")) {
    const rest = videoId.slice(5);
    const idx = rest.indexOf(":");
    const bvid = (idx >= 0 ? rest.slice(0, idx) : rest).trim();
    const pageRaw = idx >= 0 ? Number(rest.slice(idx + 1)) : 1;
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
    return bvid ? { kind: "bilibili", bvid, page } : null;
  }
  return { kind: "youtube", id: videoId };
}

export function isBilibiliEpisode(ep?: Pick<Episode, "videoId"> | null): boolean {
  return parseVideoSource(ep?.videoId)?.kind === "bilibili";
}

export function isYouTubeEpisode(ep?: Pick<Episode, "videoId"> | null): boolean {
  return parseVideoSource(ep?.videoId)?.kind === "youtube";
}

export function episodeExternalUrl(ep: Episode, atSeconds = 0): string | undefined {
  const src = parseVideoSource(ep.videoId);
  const t = Math.floor(atSeconds);
  if (src?.kind === "youtube") {
    return t > 5 ? `https://www.youtube.com/watch?v=${src.id}&t=${t}s` : `https://www.youtube.com/watch?v=${src.id}`;
  }
  if (src?.kind === "bilibili") {
    const base =
      src.page > 1
        ? `https://www.bilibili.com/video/${src.bvid}?p=${src.page}`
        : `https://www.bilibili.com/video/${src.bvid}`;
    if (t > 5) {
      return `${base}${base.includes("?") ? "&" : "?"}t=${t}`;
    }
    return base;
  }
  return ep.link;
}
