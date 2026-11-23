import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import type { Episode } from "../../lib/api";
import { formatAnswerCopy, type CopyKind } from "../../lib/subexport";
import { useStore } from "../../store";

export async function copyTextSafe(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    useStore.getState().notify("已复制到剪贴板");
  } catch {
    useStore.getState().notify("复制失败，请手动复制", false);
  }
}

export function CopyMenu({ text, ep }: { text: string; ep: Episode }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const doneTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(doneTimerRef.current), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const doCopy = (kind: CopyKind) => {
    setOpen(false);
    void copyTextSafe(formatAnswerCopy(text, kind, ep));
    setDone(true);
    window.clearTimeout(doneTimerRef.current);
    doneTimerRef.current = window.setTimeout(() => setDone(false), 1400);
  };

  return (
    <div className="msg-copy" ref={boxRef}>
      <button type="button" className={`msg-act ${done ? "is-done" : ""}`} title="复制（保留时间戳）" onClick={() => doCopy("stamps")}>
        {done ? <Check size={13} className="check-draw-icon" /> : <Copy size={13} />}
      </button>
      <button
        type="button"
        className="msg-act caret"
        title="更多复制格式"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu msg-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => doCopy("stamps")}>
            <Copy size={13} /> <span>复制，保留时间戳</span>
          </button>
          <button type="button" role="menuitem" onClick={() => doCopy("plain")}>
            <Copy size={13} /> <span>复制，去掉时间戳</span>
          </button>
          <button type="button" role="menuitem" onClick={() => doCopy("markdown")}>
            <Copy size={13} /> <span>{ep.videoId ? "复制 Markdown（含 YouTube 时间链）" : "复制 Markdown（附出处）"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
