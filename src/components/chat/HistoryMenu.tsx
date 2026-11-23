import { useEffect, useRef, useState } from "react";
import { Copy, Download, History, Trash2 } from "lucide-react";
import type { ChatMessage, Episode } from "../../lib/api";
import { formatDate } from "../../lib/format";
import type { ArchivedChat } from "../../lib/jobs";
import { downloadTextFile, exportChatMarkdown, safeFileName } from "../../lib/subexport";
import { useStore } from "../../store";
import { copyTextSafe } from "./CopyMenu";

export function HistoryMenu({
  archive,
  ep,
  current,
  onRestore,
  onDelete,
}: {
  archive: ArchivedChat[];
  ep: Episode;
  current: ChatMessage[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!archive.length && !current.length) return null;

  const titleOf = (msgs: ChatMessage[]) => msgs.find((m) => m.role === "user")?.content.slice(0, 42) ?? "对话";

  return (
    <div className="mp" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn sm"
        title="本集对话历史与导出"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <History size={15} />
      </button>
      {open && (
        <div className="mp-pop history" role="menu">
          <p className="mp-head">这一集的对话记录</p>
          <div className="mp-list">
            {!archive.length ? (
              <p className="mp-empty">点击「新对话」后，之前的问答会自动归档在这里。</p>
            ) : (
              archive.map((c) => (
                <div key={c.id} className="hist-row">
                  <button
                    type="button"
                    role="menuitem"
                    className="pm-row"
                    onClick={() => {
                      setOpen(false);
                      onRestore(c.id);
                    }}
                  >
                    <span className="hist-title clamp1">{titleOf(c.messages)}</span>
                    <span className="hist-meta">
                      {c.messages.filter((m) => m.role === "user").length} 问 · {formatDate(c.at)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    title="删除这段归档"
                    onClick={() => onDelete(c.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
          {current.length > 0 && (
            <>
              <button
                type="button"
                className="mp-foot"
                onClick={() => {
                  setOpen(false);
                  void copyTextSafe(exportChatMarkdown(ep, current));
                }}
              >
                <Copy size={13} /> 复制当前对话为 Markdown
              </button>
              <button
                type="button"
                className="mp-foot"
                onClick={() => {
                  setOpen(false);
                  downloadTextFile(safeFileName(`${ep.title}-问答笔记`, "md"), exportChatMarkdown(ep, current));
                  useStore.getState().notify("已导出问答笔记 .md 文件");
                }}
              >
                <Download size={13} /> 下载当前对话 (.md)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
