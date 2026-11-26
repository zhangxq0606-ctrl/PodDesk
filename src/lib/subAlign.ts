import { create } from "zustand";

const STORAGE_KEY = "podcast-desk-sub-offsets";
const MAX_ENTRIES = 200;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function clampOffset(sec: number): number {
  if (!Number.isFinite(sec)) return 0;
  const r = round1(Math.max(-1800, Math.min(1800, sec)));
  return Math.abs(r) < 0.05 ? 0 : r;
}

export function toSubtitleTime(playTime: number, offset: number): number {
  return Math.max(0, playTime - offset);
}

export function toPlaybackTime(subTime: number, offset: number): number {
  return Math.max(0, subTime + offset);
}

export function alignSegmentToTime(segStart: number, playTime: number): number {
  return clampOffset(playTime - segStart);
}

export function formatOffsetLabel(offset: number): string {
  const o = clampOffset(offset);
  if (o === 0) return "未偏移";
  const abs = Math.abs(o);
  const num = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
  return o > 0 ? `延后 ${num}s` : `提前 ${num}s`;
}

function readAll(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number") {
        const c = clampOffset(v);
        if (c !== 0) out[k] = c;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistAll(map: Record<string, number>): void {
  try {
    const entries = Object.entries(map).slice(-MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore storage error */
  }
}

interface SubAlignState {
  offsets: Record<string, number>;
  setOffset: (epId: string, sec: number) => number;
  nudgeOffset: (epId: string, delta: number) => number;
  resetOffset: (epId: string) => void;
}

export const useSubAlign = create<SubAlignState>((set, get) => ({
  offsets: readAll(),
  setOffset: (epId, sec) => {
    const nextVal = clampOffset(sec);
    const next = { ...get().offsets };
    if (nextVal === 0) {
      delete next[epId];
    } else {
      delete next[epId];
      next[epId] = nextVal;
    }
    set({ offsets: next });
    persistAll(next);
    return nextVal;
  },
  nudgeOffset: (epId, delta) => {
    const cur = get().offsets[epId] ?? 0;
    return get().setOffset(epId, cur + delta);
  },
  resetOffset: (epId) => {
    if (!(epId in get().offsets)) return;
    const next = { ...get().offsets };
    delete next[epId];
    set({ offsets: next });
    persistAll(next);
  },
}));
