import { useRef, useState, type RefObject } from "react";

interface SplitterProps {
  value: number;
  min: number;
  max: number;
  def: number;
  snap: number;
  edge: "right" | "left";
  label: string;
  onChange: (w: number) => void;
  onCollapse: () => void;
}

export function Splitter({ value, min, max, def, snap, edge, onChange, onCollapse, label }: SplitterProps) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  const widthAt = (x: number) => {
    const s = start.current!;
    const d = x - s.x;
    return edge === "right" ? s.w + d : s.w - d;
  };

  return (
    <div
      className={`splitter ${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      title="拖动调整宽度 · 双击恢复默认"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: value };
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const w = widthAt(e.clientX);
        if (w < snap) return;
        onChange(clamp(w));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const w = widthAt(e.clientX);
        start.current = null;
        document.body.classList.remove("resizing");
        if (w < snap) onCollapse();
      }}
      onDoubleClick={() => onChange(def)}
      onKeyDown={(e) => {
        const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
        const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
        if (e.key === grow || e.key === shrink) {
          e.preventDefault();
          e.stopPropagation();
          onChange(clamp(value + (e.key === grow ? 16 : -16)));
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onChange(def);
        }
      }}
    />
  );
}

interface SplitRatioDividerProps {
  containerRef: RefObject<HTMLDivElement | null>;
  ratio: number;
  defaultRatio?: number;
  thresholdPx?: number;
  onChange: (ratio: number) => void;
  onCollapseLeft: () => void;
  onCollapseRight: () => void;
}

export function SplitRatioDivider({
  containerRef,
  ratio,
  defaultRatio = 0.5,
  thresholdPx = 220,
  onChange,
  onCollapseLeft,
  onCollapseRight,
}: SplitRatioDividerProps) {
  const dragging = useRef(false);
  const snapRef = useRef<"left" | "right" | null>(null);
  const [snapSide, setSnapSide] = useState<"left" | "right" | null>(null);

  const setSnap = (next: "left" | "right" | null) => {
    snapRef.current = next;
    setSnapSide(next);
  };

  return (
    <div
      className="splitter ratio"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整字幕与问答双栏比例"
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(ratio * 100)}
      data-snap={snapSide || undefined}
      tabIndex={0}
      title="拖动调整两栏宽度 · 双击恢复默认"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
        setSnap(null);
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const leftW = e.clientX - rect.left;
        const rightW = rect.right - e.clientX;
        const effectiveThreshold = Math.min(thresholdPx, Math.floor(rect.width * 0.26));
        if (leftW < effectiveThreshold) {
          setSnap("left");
          return;
        }
        if (rightW < effectiveThreshold) {
          setSnap("right");
          return;
        }
        setSnap(null);
        onChange(Math.min(0.8, Math.max(0.2, leftW / rect.width)));
      }}
      onPointerUp={() => {
        if (!dragging.current) return;
        const snapped = snapRef.current;
        dragging.current = false;
        setSnap(null);
        document.body.classList.remove("resizing");
        if (snapped === "left") onCollapseLeft();
        else if (snapped === "right") onCollapseRight();
      }}
      onPointerCancel={() => {
        dragging.current = false;
        setSnap(null);
        document.body.classList.remove("resizing");
      }}
      onDoubleClick={() => onChange(defaultRatio)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          onChange(Math.min(0.8, Math.max(0.2, ratio + (e.key === "ArrowRight" ? 0.04 : -0.04))));
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onChange(defaultRatio);
        }
      }}
    />
  );
}
