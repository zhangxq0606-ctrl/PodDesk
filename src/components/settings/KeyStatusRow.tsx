import { useState } from "react";
import { Check } from "lucide-react";

export function KeyStatusRow({
  has,
  value,
  onValue,
  onSave,
  onDelete,
  placeholder,
}: {
  has: boolean;
  value: string;
  onValue: (v: string) => void;
  onSave: () => Promise<void>;
  onDelete: () => Promise<void>;
  placeholder: string;
}) {
  const [editing, setEditing] = useState(false);

  if (has && !editing) {
    return (
      <div className="key-saved">
        <span className="ok-text small">
          <Check size={14} /> 已保存至系统钥匙串 (••••••••••••)
        </span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => setEditing(true)}>
          更换
        </button>
        <button type="button" className="btn sm ghost" onClick={() => void onDelete()}>
          清除
        </button>
      </div>
    );
  }

  return (
    <div className="key-row">
      <input
        type="password"
        value={value}
        onChange={(e) => onValue(e.target.value)}
        placeholder={placeholder}
        autoFocus={editing}
      />
      <button
        type="button"
        className="btn sm primary"
        disabled={!value.trim()}
        onClick={() => {
          void onSave().then(() => setEditing(false));
        }}
      >
        保存
      </button>
      {editing && (
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            onValue("");
            setEditing(false);
          }}
        >
          取消
        </button>
      )}
    </div>
  );
}
