import { Component, lazy, memo, Suspense, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ConfirmHost } from "./components/ConfirmHost";
import { HomeView, ShowView } from "./components/Lists";
import { EpisodeView } from "./components/PlayerPanel";
import { AudioEngine, cycleSubtitleMode, stepRate, toggleMute } from "./components/Players";
import { SelectionTools } from "./components/SelectionTools";
import { SettingsModal } from "./components/SettingsModal";
import { ImportModal, MiniPlayer, Sidebar, Toast, TopBar } from "./components/Sidebar";
import { Splitter } from "./components/Splitter";
import { UpdateModal } from "./components/UpdateModal";
import { api } from "./lib/api";
import { ask } from "./lib/confirm";
import { SIDEBAR, triggerSidebarAnim, useLayout } from "./lib/layout";

declare global {
  interface Window {
    __poddeskRequestQuit?: () => void;
  }
}
import { resolveEffectiveMode } from "./lib/themes";
import { useStore, type View } from "./store";

const DevThemeLab = import.meta.env.DEV
  ? lazy(() => import("./dev/ThemeLabBar").then((m) => ({ default: m.ThemeLabBar })))
  : null;

const MainContent = memo(function MainContent({ view }: { view: View }) {
  return (
    <main className="main">
      {view.kind !== "episode" && <TopBar />}
      {view.kind === "home" && <HomeView />}
      {view.kind === "show" && <ShowView key={view.id} id={view.id} />}
      {view.kind === "episode" && <EpisodeView key={view.id} id={view.id} />}
    </main>
  );
});

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[PodDesk] Uncaught UI error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boot">
          <div className="error-card">
            <p className="lead">页面遇到了一点意外</p>
            <p className="muted small">{this.state.error.message || "渲染异常，已自动拦截以防止白屏"}</p>
            <div className="row-actions center" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn sm"
                onClick={() => this.setState({ error: null })}
              >
                尝试恢复
              </button>
              <button
                type="button"
                className="btn sm primary"
                onClick={() => window.location.reload()}
              >
                重新加载页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppShell() {
  const { ready, view, notice, setNotice, bootstrap, theme, lightTheme, darkTheme, subSize, chatSize } = useStore(
    useShallow((s) => ({
      ready: s.ready,
      view: s.view,
      notice: s.notice,
      setNotice: s.setNotice,
      bootstrap: s.bootstrap,
      theme: s.prefs.theme,
      lightTheme: s.prefs.lightTheme,
      darkTheme: s.prefs.darkTheme,
      subSize: s.prefs.subtitleSize,
      chatSize: s.prefs.chatSize,
    })),
  );
  const { sidebar, sideOpen, sideDrawerOpen, put } = useLayout(
    useShallow((l) => ({ sidebar: l.sidebar, sideOpen: l.sideOpen, sideDrawerOpen: l.sideDrawerOpen, put: l.put })),
  );

  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    if (useLayout.getState().sideDrawerOpen) {
      useLayout.setState({ sideDrawerOpen: false });
    }
  }, [view]);

  useEffect(() => {
    void bootstrap().catch((err) => {
      setBootError(err instanceof Error ? err.message : "连接本地服务失败");
    });
  }, [bootstrap]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), notice.action ? 6500 : 3500);
    return () => window.clearTimeout(t);
  }, [notice, setNotice]);

  useEffect(() => {
    let prompting = false;
    window.__poddeskRequestQuit = () => {
      if (prompting) return;
      prompting = true;
      void ask({
        title: "后台任务正在进行",
        message: "当前仍有转写、下载或 AI 任务在运行，确定立即退出 PodDesk？",
        ok: "停止并退出",
        danger: true,
      }).then((yes) => {
        prompting = false;
        if (yes) {
          void api.quitApp().catch(() => {});
        }
      });
    };
    return () => {
      delete window.__poddeskRequestQuit;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const mode = resolveEffectiveMode(theme);
      root.setAttribute("data-theme", mode);
      root.setAttribute("data-palette", mode === "dark" ? darkTheme : lightTheme);
    };
    apply();
    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme, lightTheme, darkTheme]);

  useEffect(() => {
    const scrollTimers = new WeakMap<Element, number>();
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      el.classList.add("is-scrolling");
      window.clearTimeout(scrollTimers.get(el));
      scrollTimers.set(
        el,
        window.setTimeout(() => el.classList.remove("is-scrolling"), 850),
      );
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable]");

      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        const l = useLayout.getState();
        if (useStore.getState().view.kind === "episode") {
          useLayout.setState({ sideDrawerOpen: !l.sideDrawerOpen });
        } else {
          triggerSidebarAnim();
          l.put({ sideOpen: !l.sideOpen });
        }
        return;
      }
      if (e.key === "Escape" && useStore.getState().view.kind === "episode" && useLayout.getState().sideDrawerOpen) {
        e.preventDefault();
        useLayout.setState({ sideDrawerOpen: false });
        return;
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        const l = useLayout.getState();
        l.put({ panelOpen: !l.panelOpen });
        return;
      }
      if (mod && e.key.toLowerCase() === "l") {
        const box = document.querySelector<HTMLInputElement>(".top-search input");
        if (box) {
          e.preventDefault();
          box.focus();
          box.select();
        }
        return;
      }

      if (typing) return;

      const s = useStore.getState();
      if (e.code === "Space" && !e.shiftKey && !mod && !e.altKey) {
        if (s.player) {
          e.preventDefault();
          s.player.toggle();
        }
      } else if (e.key === "ArrowLeft" && !mod) {
        if (s.player) {
          e.preventDefault();
          s.player.seek(Math.max(0, s.time - 10));
        }
      } else if (e.key === "ArrowRight" && !mod) {
        if (s.player) {
          e.preventDefault();
          s.player.seek(s.time + 10);
        }
      } else if (e.key === "[") {
        e.preventDefault();
        stepRate(-1);
      } else if (e.key === "]") {
        e.preventDefault();
        stepRate(1);
      } else if (e.key.toLowerCase() === "m" && !mod) {
        e.preventDefault();
        toggleMute();
      } else if (e.key.toLowerCase() === "c" && !mod) {
        e.preventDefault();
        cycleSubtitleMode();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (bootError) {
    return (
      <div className="boot">
        <div className="panel-empty">
          <p className="lead">无法连接 PodDesk 本地服务</p>
          <p className="error-text">{bootError}</p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="boot">
        <div className="panel-empty">
          <p className="muted">正在启动工作台…</p>
        </div>
      </div>
    );
  }

  const isEpisode = view.kind === "episode";
  const dockedOpen = !isEpisode && sideOpen;
  const showThemeLab =
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("lab") === "1";

  return (
    <div
      className={`app sub-${subSize} chat-${chatSize} ${dockedOpen ? "" : "side-collapsed"} ${isEpisode ? "is-episode" : ""}`}
      style={
        {
          "--sidebar-w": `${dockedOpen ? sidebar : 0}px`,
          "--sidebar-fixed-w": `${sidebar}px`,
        } as React.CSSProperties
      }
    >
      <Sidebar isDrawer={isEpisode} />
      {isEpisode && (
        <div
          className={`side-backdrop ${sideDrawerOpen ? "open" : ""}`}
          onClick={() => useLayout.setState({ sideDrawerOpen: false })}
          aria-hidden={!sideDrawerOpen}
        />
      )}
      {dockedOpen && (
        <Splitter
          value={sidebar}
          min={SIDEBAR.min}
          max={SIDEBAR.max}
          def={SIDEBAR.def}
          snap={SIDEBAR.snap}
          edge="right"
          label="侧栏宽度"
          onChange={(w) => put({ sidebar: w, sideOpen: true })}
          onCollapse={() => put({ sideOpen: false })}
        />
      )}
      <MainContent view={view} />
      <MiniPlayer />
      <AudioEngine />
      <SelectionTools />
      <SettingsModal />
      <UpdateModal />
      <ImportModal />
      <ConfirmHost />
      <Toast />
      {showThemeLab && DevThemeLab && (
        <Suspense fallback={null}>
          <DevThemeLab />
        </Suspense>
      )}
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
