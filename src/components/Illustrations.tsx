type ArtProps = { className?: string };

const svgFrame = (w: number, h: number, name: string, className?: string) => ({
  viewBox: `0 0 ${w} ${h}`,
  width: w,
  height: h,
  fill: "none" as const,
  "aria-hidden": true as const,
  focusable: "false" as const,
  className: `ia ${name}${className ? ` ${className}` : ""}`,
});

/** Custom PodDesk geometric brand mark: acoustic desk + warm accent dot. */
export function BrandMark({ className }: ArtProps) {
  return (
    <svg
      viewBox="0 0 28 28"
      width={28}
      height={28}
      fill="none"
      aria-hidden
      focusable="false"
      className={`brand-svg${className ? ` ${className}` : ""}`}
    >
      <rect x="2" y="2" width="24" height="24" rx="7" className="bm-box" />
      <path d="M9.5 11.5v5M13.5 8.5v11M17.5 11v6" className="bm-wave" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="20.5" cy="8.5" r="2.2" className="bm-dot" />
    </svg>
  );
}

/** Subtle 3-bar playing indicator. */
export function EqBars({ className }: ArtProps) {
  return (
    <svg {...svgFrame(14, 14, "ia-eq-mini", className)}>
      <path className="eq1" d="M3 4v7" />
      <path className="eq2 a" d="M7 2v10" />
      <path className="eq3" d="M11 5v6" />
    </svg>
  );
}

/** Soundwaves turning into bilingual subtitle lines. */
export function WaveToTextArt({ className }: ArtProps) {
  return (
    <svg {...svgFrame(136, 56, "ia-w2t", className)}>
      <g className="ia-eq">
        <path d="M6 24v8" />
        <path d="M12 18v20" />
        <path d="M18 12v32" />
        <path d="M24 20v16" />
        <path d="M30 25v6" />
      </g>
      <g className="ia-flow">
        <circle cx="43" cy="28" r="1.4" className="s" />
        <circle cx="50" cy="28" r="1.4" className="s" />
        <circle cx="57" cy="28" r="1.4" className="s" />
      </g>
      <rect x="66" y="12" width="64" height="32" rx="7" />
      <path className="a" d="M74 23h6" />
      <g className="ia-sub">
        <path d="M86 23h36" />
        <path className="s" d="M74 33h40" />
      </g>
    </svg>
  );
}

const reelSpokes = (x: number) => `M${x} 26.5V24M${x + 3} 31.8l2.2 1.2M${x - 3} 31.8l-2.2 1.2`;

/** Minimalist tape cassette while transcribing. */
export function CassetteArt({
  mode = "listen",
  className,
}: ArtProps & { mode?: "idle" | "fetch" | "listen" }) {
  return (
    <svg {...svgFrame(112, 68, `ia-tape is-${mode}`, className)}>
      <rect x="6" y="6" width="100" height="56" rx="7" />
      <rect className="s" x="22" y="18" width="68" height="24" rx="12" />
      <g className="ia-reel">
        <circle cx="36" cy="30" r="7" />
        <path d={reelSpokes(36)} />
      </g>
      <g className="ia-reel">
        <circle cx="76" cy="30" r="7" />
        <path d={reelSpokes(76)} />
      </g>
      <path className="s" d="M28 62l5-9h46l5 9" />
      <circle className="f a ia-rec" cx="96" cy="14" r="2" />
    </svg>
  );
}

/** Editorial page with timeline dots for Guide empty state. */
export function PageArt({ className }: ArtProps) {
  return (
    <svg {...svgFrame(96, 64, "ia-page", className)}>
      <rect x="18" y="4" width="60" height="56" rx="6" />
      <path className="s" d="M30 18v32" />
      <g>
        <path d="M38 16h28" />
        <path className="s" d="M38 22h20" />
        <path d="M38 33h30" />
        <path className="s" d="M38 39h16" />
        <path d="M38 50h24" />
      </g>
      <g>
        <circle cx="30" cy="16" r="2.3" />
        <circle className="a f" cx="30" cy="33" r="2.5" />
        <circle cx="30" cy="50" r="2.3" />
      </g>
    </svg>
  );
}

/** Speech bubble with acoustic bars for Q&A empty state. */
export function AskArt({ className }: ArtProps) {
  return (
    <svg {...svgFrame(40, 40, "ia-ask", className)}>
      <path d="M10 6h20a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6H17l-7 6v-6a6 6 0 0 1-6-6V12a6 6 0 0 1 6-6z" />
      <g>
        <path d="M13 15v4" />
        <path d="M18 12v10" />
        <path className="a" d="M23 14v6" />
        <path d="M28 16v2" />
      </g>
    </svg>
  );
}

/** Minimalist audio desk & open notebook line art for empty Home state. */
export function DeskArt({ className }: ArtProps) {
  return (
    <svg {...svgFrame(128, 72, "ia-desk", className)}>
      <rect x="14" y="14" width="52" height="44" rx="6" />
      <path className="s" d="M40 14v44" />
      <path d="M22 25h11M22 33h11M22 41h8" />
      <path className="a" d="M47 25h11" />
      <path className="s" d="M47 33h11M47 41h9" />
      <path d="M80 42v-8a16 16 0 0 1 32 0v8" />
      <rect x="76" y="39" width="7" height="14" rx="3.5" />
      <rect x="109" y="39" width="7" height="14" rx="3.5" />
      <circle className="a f" cx="96" cy="24" r="2.2" />
    </svg>
  );
}

export function SkeletonFeed({ count = 5 }: { count?: number }) {
  return (
    <div className="ep-feed sk-wrap" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ep-item-row sk-row">
          <div className="sk sk-thumb" />
          <div className="ep-body-col">
            <div className="sk sk-line xs" style={{ width: "32%" }} />
            <div className="sk sk-line lg" style={{ width: `${72 + (i % 3) * 8}%` }} />
            <div className="sk sk-line sm" style={{ width: "44%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonEpisode() {
  return (
    <div className="episode sk-wrap" aria-hidden>
      <div className="ep-body">
        <div className="ep-leftcol">
          <div className="ep-left">
            <div className="sk sk-line xs" style={{ width: "26%" }} />
            <div className="sk sk-line xl" style={{ width: "78%" }} />
            <div className="sk sk-video" />
            <div className="sk sk-line" style={{ width: "100%", height: 48 }} />
          </div>
        </div>
        <div className="ep-right" style={{ padding: 18, gap: 12 }}>
          <div className="sk sk-line lg" style={{ width: "55%" }} />
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="sk sk-line" style={{ width: `${65 + (i % 4) * 8}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
