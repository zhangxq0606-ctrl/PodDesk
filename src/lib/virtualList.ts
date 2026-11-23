export const VIRTUAL_THRESHOLD = 160;
export const VIRTUAL_OVERSCAN = 20;

export interface VirtualWindow {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
}

export function computeWindow(
  heights: Float32Array,
  scrollTop: number,
  viewH: number,
  overscan = VIRTUAL_OVERSCAN,
): VirtualWindow {
  const n = heights.length;
  if (!n) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  const top = Math.max(0, scrollTop);
  const vh = Math.max(1, viewH);

  let y = 0;
  let i = 0;
  while (i < n && y + heights[i] < top) {
    y += heights[i];
    i++;
  }
  const start = Math.max(0, i - overscan);
  let topPad = 0;
  for (let p = 0; p < start; p++) topPad += heights[p];

  let j = i;
  let visibleBottom = y;
  while (j < n && visibleBottom < top + vh) {
    visibleBottom += heights[j];
    j++;
  }
  const end = Math.min(n, j + overscan);
  let bottomPad = 0;
  for (let p = end; p < n; p++) bottomPad += heights[p];
  return { start, end, topPad, bottomPad };
}

export function rowBounds(heights: Float32Array, pos: number): { top: number; bottom: number; height: number } {
  const n = heights.length;
  if (!n || pos < 0) return { top: 0, bottom: 0, height: 0 };
  const clamped = Math.min(pos, n - 1);
  let top = 0;
  for (let i = 0; i < clamped; i++) top += heights[i];
  const height = heights[clamped] ?? 60;
  return { top, bottom: top + height, height };
}
