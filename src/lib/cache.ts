const scrollPos = new Map<string, number>();

export function saveScroll(key: string, top: number): void {
  scrollPos.set(key, Math.max(0, top));
}

export function readScroll(key: string): number {
  return scrollPos.get(key) ?? 0;
}
