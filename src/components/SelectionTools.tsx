import { useEffect, useRef, useState } from "react";
import { Copy, Sparkles } from "lucide-react";
import { queueDraftAsk } from "../lib/jobs";
import { useStore } from "../store";

const ZONES = ".lines, .notes-body, .summary, .chat-scroll";

interface SelectionInfo {
  text: string;
  x: number;
  y: number;
  below: boolean;
  ts?: string;
}

export function SelectionTools({ onAskFocus }: { onAskFocus?: () => void }) {
  const [sel, setSel] = useState<SelectionInfo | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const read = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) {
        setSel(null);
        return;
      }
      const text = s.toString().replace(/\s+/g, " ").trim();
      const range = s.getRangeAt(0);
      const host = (
        range.commonAncestorContainer.nodeType === 1
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement
      ) as HTMLElement | null;
      if (text.length < 3 || !host?.closest(ZONES) || host.closest(".sel-bar")) {
        setSel(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const ts =
        (range.startContainer.parentElement?.closest(".line")?.querySelector(".line-time")?.textContent?.trim() ??
          undefined) ||
        undefined;
      const below = rect.top < 72;
      setSel({
        text,
        x: Math.max(90, Math.min(rect.left + rect.width / 2, window.innerWidth - 90)),
        y: below ? rect.bottom + 8 : rect.top - 8,
        below,
        ts,
      });
    };

    const onChange = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(read, 200);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      window.clearTimeout(timerRef.current);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  const currentEpisode = () => {
    const s = useStore.getState();
    if (s.view.kind === "episode") {
      return s.episodeCache[s.view.id] ?? s.current;
    }
    return s.current;
  };

  const handleCopy = async () => {
    if (!sel) return;
    const ep = currentEpisode();
    const link = ep?.videoId ? `https://youtu.be/${ep.videoId}` : ep?.link;
    const src = ep
      ? `——《${ep.title}》${ep.showTitle ? ` · ${ep.showTitle}` : ""}${sel.ts ? ` [${sel.ts}]` : ""}${link ? `\n${link}` : ""}`
      : "";
    try {
      await navigator.clipboard.writeText(`“${sel.text}”\n${src}`);
      useStore.getState().notify("已带出处复制到剪贴板");
      setSel(null);
    } catch {
      useStore.getState().notify("复制失败", false);
    }
  };

  const handleAskAi = () => {
    if (!sel) return;
    const ep = currentEpisode();
    if (!ep) return;
    const quote = sel.ts ? `关于 [${sel.ts}] 这段话：\n> ${sel.text}\n\n请帮我解释一下：` : `关于这段内容：\n> ${sel.text}\n\n请帮我解释一下：`;
    queueDraftAsk(ep.id, quote);
    onAskFocus?.();
    setSel(null);
    window.getSelection()?.removeAllRanges();
  };

  if (!sel) return null;

  return (
    <div
      className={`sel-bar ${sel.below ? "below" : ""}`}
      style={{ left: sel.x, top: sel.y }}
      role="toolbar"
      aria-label="选中文字操作"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="sel-actions">
        <button type="button" onClick={handleAskAi}>
          <Sparkles size={13} /> 问 AI
        </button>
        <button type="button" onClick={() => void handleCopy()}>
          <Copy size={13} /> 带出处复制
        </button>
      </div>
    </div>
  );
}
