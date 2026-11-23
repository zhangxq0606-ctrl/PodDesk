import { useEffect, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { QUICK_PROMPTS } from "../../lib/ai";

export function PromptMenu({ onPick, disabled }: { onPick: (id: string, body: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
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

  return (
    <div className="mp" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn sm"
        title="快捷提问模板"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <MessageSquareText size={15} />
      </button>
      {open && (
        <div className="mp-pop prompts" role="menu">
          <div className="mp-list">
            {QUICK_PROMPTS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="pm-row"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPick(p.id, p.body);
                }}
              >
                <span className="pm-title">{p.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
