import { useEffect, useRef } from "react";
import { answerConfirm, useConfirm } from "../lib/confirm";

export function ConfirmHost() {
  const req = useConfirm((s) => s.req);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!req) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        answerConfirm(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req]);

  if (!req) return null;

  return (
    <div
      className="modal-back confirm-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answerConfirm(false);
      }}
    >
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <p id="confirm-title" className="confirm-title">
          {req.title}
        </p>
        {req.message && <p className="muted confirm-msg">{req.message}</p>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={() => answerConfirm(false)}>
            取消
          </button>
          <button
            ref={okRef}
            type="button"
            className={`btn ${req.danger ? "danger" : "primary"}`}
            onClick={() => answerConfirm(true)}
          >
            {req.ok ?? "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
