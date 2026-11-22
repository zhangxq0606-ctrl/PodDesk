import { useMemo, useState, type CSSProperties } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Episode } from "../lib/api";
import { monthKey, monthShort, monthTitle } from "../lib/format";

export function useMonthFilter(episodes: Episode[] | null) {
  const [month, setMonth] = useState<string | null>(null);
  const filtered = useMemo(
    () => (month && episodes ? episodes.filter((e) => e.published && monthKey(e.published) === month) : episodes),
    [episodes, month],
  );
  return { month, setMonth, filtered };
}

export function MonthFilter({
  episodes,
  month,
  onChange,
}: {
  episodes: Episode[] | null;
  month: string | null;
  onChange: (m: string | null) => void;
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of episodes ?? []) {
      if (e.published) {
        const k = monthKey(e.published);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    }
    return m;
  }, [episodes]);

  const years = useMemo(
    () => [...new Set([...counts.keys()].map((k) => Number(k.slice(0, 4))))].sort((a, b) => b - a),
    [counts],
  );

  const [year, setYear] = useState<number | null>(null);
  const currentYear = (year && years.includes(year) ? year : null) ?? (month ? Number(month.slice(0, 4)) : years[0]) ?? new Date().getFullYear();

  if (!episodes?.length || (counts.size < 2 && !month)) return null;

  const max = Math.max(1, ...counts.values());
  const yearTotal = [...counts.entries()]
    .filter(([k]) => k.startsWith(`${currentYear}-`))
    .reduce((n, [, c]) => n + c, 0);
  const idx = years.indexOf(currentYear);

  return (
    <div className="month-filter" role="group" aria-label="按年月定位">
      <div className="mf-head">
        <CalendarDays size={14} className="muted" />
        <button
          type="button"
          className="icon-btn sm"
          disabled={idx < 0 || idx >= years.length - 1}
          onClick={() => setYear(years[idx + 1])}
          aria-label="上一年"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="mf-year">{currentYear}</span>
        <button
          type="button"
          className="icon-btn sm"
          disabled={idx <= 0}
          onClick={() => setYear(years[idx - 1])}
          aria-label="下一年"
        >
          <ChevronRight size={14} />
        </button>
        <span className="muted small">{yearTotal} 集</span>
        <span className="spacer" />
        {month && (
          <button type="button" className="chip sm on mf-clear" onClick={() => onChange(null)}>
            <span>{monthTitle(Number(month.slice(0, 4)), Number(month.slice(5)))}</span>
            <X size={11} />
          </button>
        )}
      </div>
      <div className="mf-grid">
        {Array.from({ length: 12 }, (_, i) => {
          const m = i + 1;
          const k = `${currentYear}-${String(m).padStart(2, "0")}`;
          const n = counts.get(k) ?? 0;
          const ratio = n / max;
          const isSelected = month === k;
          return (
            <button
              key={k}
              type="button"
              className={`mf-cell ${isSelected ? "on" : ""} ${ratio > 0.6 ? "hot" : ""}`}
              disabled={!n && !isSelected}
              onClick={() => onChange(isSelected ? null : k)}
              style={{ "--heat": n ? (0.18 + 0.62 * ratio).toFixed(2) : 0 } as CSSProperties}
              title={n ? `${monthTitle(currentYear, m)} · ${n} 集` : `${monthTitle(currentYear, m)}暂无单集`}
            >
              <span className="mf-m">{monthShort(m)}</span>
              <span className="mf-n">{n || "·"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
