import { create } from "zustand";

export const SIDEBAR = { min: 184, max: 320, def: 224, snap: 130 };
export const PANEL = { min: 340, max: 920, def: 420, snap: 240 };
export const SPLIT_DEFAULT_RATIO = 0.42;

export function defaultAudioPanelWidth(): number {
  if (typeof window === "undefined") return 760;
  return Math.min(960, Math.max(520, Math.round(window.innerWidth * 0.55)));
}

export type AudioTab = "transcript" | "guide" | "chat";
export type VideoTab = "guide" | "chat";
export const AUDIO_TAB_ORDER: readonly AudioTab[] = ["transcript", "guide", "chat"];
export const VIDEO_TAB_ORDER: readonly VideoTab[] = ["guide", "chat"];

export function sortAudioTabs(tabs?: readonly unknown[]): AudioTab[] {
  if (!Array.isArray(tabs)) return ["transcript", "chat"];
  const picked = AUDIO_TAB_ORDER.filter((t) => tabs.includes(t)).slice(0, 2);
  return picked.length ? picked : ["transcript", "chat"];
}

export function sortVideoTabs(tabs?: readonly unknown[]): VideoTab[] {
  if (!Array.isArray(tabs)) return ["guide"];
  const picked = VIDEO_TAB_ORDER.filter((t) => tabs.includes(t)).slice(0, 2);
  return picked.length ? picked : ["guide"];
}

export interface LayoutState {
  sidebar: number;
  sideOpen: boolean;
  sideDrawerOpen: boolean;
  panel: number;
  audioPanel: number;
  audioTabs: AudioTab[];
  videoTabs: VideoTab[];
  panelOpen: boolean;
  splitRatio: number;
  splitRatioV?: number;
  guideOpen: boolean;
}

const KEY = "podcast-desk-layout";

function readLayout(): LayoutState {
  const fallback: LayoutState = {
    sidebar: SIDEBAR.def,
    sideOpen: true,
    sideDrawerOpen: false,
    panel: PANEL.def,
    audioPanel: defaultAudioPanelWidth(),
    audioTabs: ["transcript", "chat"],
    videoTabs: ["guide"],
    panelOpen: true,
    splitRatio: SPLIT_DEFAULT_RATIO,
    splitRatioV: 2,
    guideOpen: true,
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<LayoutState> & { splitSubChat?: boolean };
    const migratedRatio =
      !parsed.splitRatioV && parsed.splitRatio === 0.5 ? SPLIT_DEFAULT_RATIO : parsed.splitRatio;
    const migratedVideoTabs: VideoTab[] = parsed.videoTabs
      ? sortVideoTabs(parsed.videoTabs)
      : parsed.splitSubChat
        ? ["guide", "chat"]
        : fallback.videoTabs;
    return {
      ...fallback,
      ...parsed,
      audioTabs: parsed.audioTabs ? sortAudioTabs(parsed.audioTabs) : fallback.audioTabs,
      videoTabs: migratedVideoTabs,
      sideDrawerOpen: false,
      ...(migratedRatio !== undefined ? { splitRatio: migratedRatio } : {}),
      splitRatioV: 2,
    };
  } catch {
    return fallback;
  }
}

let saveTimer = 0;
let sideAnimTimer = 0;

/** Enable grid-column transition strictly for manual browse-page sidebar toggles, preventing episode view-switch flash/jank. */
export function triggerSidebarAnim(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.add("side-anim");
  window.clearTimeout(sideAnimTimer);
  sideAnimTimer = window.setTimeout(() => {
    root.classList.remove("side-anim");
  }, 260);
}

export const useLayout = create<LayoutState & { put: (patch: Partial<LayoutState>) => void }>((set, get) => ({
  ...readLayout(),
  put: (patch) => {
    set(patch);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const { sidebar, sideOpen, panel, audioPanel, audioTabs, videoTabs, panelOpen, splitRatio, guideOpen } = get();
      try {
        localStorage.setItem(
          KEY,
          JSON.stringify({
            sidebar,
            sideOpen,
            panel,
            audioPanel,
            audioTabs,
            videoTabs,
            panelOpen,
            splitRatio,
            splitRatioV: 2,
            guideOpen,
          }),
        );
      } catch {
        /* ignore private storage error */
      }
    }, 250);
  },
}));
