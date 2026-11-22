export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function parseClock(text: string): number | null {
  const parts = text.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
}

export function formatDate(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff} 天前`;
  const thisYear = d.getFullYear() === now.getFullYear();
  return thisYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatPublishDate(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function groupLabel(ms?: number | null): string {
  if (!ms) return "更早";
  const d = new Date(ms);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return "本周";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "本月";
  return d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1} 月`
    : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthShort(m: number): string {
  return `${m}月`;
}

export function monthTitle(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
}

export function formatBytes(n?: number): string {
  if (!n || n <= 0) return "0 MB";
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function notesText(html?: string | null): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(
    html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n"),
    "text/html",
  );
  return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}
