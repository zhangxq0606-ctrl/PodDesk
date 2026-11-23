import type { Episode } from "./api";

export function isEpisodeDone(ep: Pick<Episode, "completed" | "duration" | "progress">): boolean {
  return !!(ep.completed || (ep.duration && ep.progress >= ep.duration * 0.97));
}

export function upsertRecentTop(list: Episode[], ep: Episode, limit = 50): Episode[] {
  return [ep, ...list.filter((e) => e.id !== ep.id)].slice(0, limit);
}

export function pickContinueHero(
  recentEpisodes: Episode[],
  live?: { ep: Episode; time: number } | null,
): Episode | null {
  if (live?.ep && (live.ep.audioUrl || live.ep.videoId)) {
    const progress = Math.max(0, live.time > 0 ? live.time : live.ep.progress);
    const candidate = { ...live.ep, progress };
    if (!isEpisodeDone(candidate) && progress > 5) {
      return candidate;
    }
  }
  return recentEpisodes.find((e) => !isEpisodeDone(e) && e.progress > 5 && (e.audioUrl || e.videoId)) ?? null;
}
