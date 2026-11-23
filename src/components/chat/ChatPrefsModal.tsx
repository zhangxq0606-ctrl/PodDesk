import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CHAT_STYLE_CHIPS } from "../../lib/ai";
import { useStore } from "../../store";

export function ChatPrefsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { chatInstruction, chatInstructionEnabled, savePrefs } = useStore(
    useShallow((s) => ({
      chatInstruction: s.prefs.chatInstruction,
      chatInstructionEnabled: s.prefs.chatInstructionEnabled,
      savePrefs: s.savePrefs,
    })),
  );

  const [text, setText] = useState(chatInstruction);
  const [enabled, setEnabled] = useState(chatInstructionEnabled);

  useEffect(() => {
    if (!open) return;
    setText(chatInstruction);
    setEnabled(chatInstructionEnabled);
  }, [open, chatInstruction, chatInstructionEnabled]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const toggleChip = (chipText: string) => {
    if (text.includes(chipText)) {
      const next = text
        .split("\n")
        .map((line) => line.replace(chipText, "").trim())
        .filter(Boolean)
        .join("\n");
      setText(next);
    } else {
      const trimmed = text.trim();
      setText(trimmed ? `${trimmed}\n${chipText}` : chipText);
      setEnabled(true);
    }
  };

  const handleSave = () => {
    savePrefs({
      chatInstruction: text.trim(),
      chatInstructionEnabled: enabled,
    });
    onClose();
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal chat-pref-modal" role="dialog" aria-modal="true" aria-label="回答偏好">
        <div className="modal-head">
          <h3>回答偏好</h3>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="row-between" style={{ marginBottom: 8 }}>
            <span className="chat-pref-label">全局回答指令</span>
            <label className="chat-pref-toggle">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>启用</span>
            </label>
          </div>
          <textarea
            className="chat-pref-textarea"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：我是独立开发者，跳过基础概念直接讲架构权衡；控制在 300 字以内。"
          />
          <div className="chat-pref-chips">
            <span className="muted small">试试：</span>
            {CHAT_STYLE_CHIPS.map((c) => {
              const active = text.includes(c.text);
              return (
                <button
                  key={c.label}
                  type="button"
                  className={`chip sm ${active ? "on" : ""}`}
                  onClick={() => toggleChip(c.text)}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            仅对之后的问答生效，不影响历史回答与左侧导读。
          </p>
          <div className="modal-foot">
            {text.trim() && (
              <button type="button" className="btn ghost sm" onClick={() => setText("")}>
                清空
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn sm" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn sm primary" onClick={handleSave}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
