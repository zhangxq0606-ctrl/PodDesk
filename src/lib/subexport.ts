import { parseTimestamp } from "./ai";
import type { ChatMessage, Episode, Segment } from "./api";

export type SubFormat = "md" | "txt" | "srt" | "vtt";
export type SubContent = "bilingual" | "original" | "translation";

export interface Cue {
  start: number;
  end: number;
  orig: string;
  zh?: string;
}

export interface ExportMeta {
  title: string;
  show?: string;
  url?: string;
}

function clockOf(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const x = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}

function stamp(t: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const f = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

function linesOf(c: Cue): string[] {
  return [c.zh, c.orig].filter((x): x is string => !!x);
}

export function buildBlocks(
  segments: Segment[],
  zh: (string | null | undefined)[] | null | undefined,
  content: SubContent,
): Cue[] {
  return segments.map((s, i) => {
    const tr = zh?.[i]?.trim() || undefined;
    if (content === "original" || !tr) return { start: s.start, end: s.end, orig: s.text };
    if (content === "translation") return { start: s.start, end: s.end, orig: "", zh: tr };
    return { start: s.start, end: s.end, orig: s.text, zh: tr };
  });
}

export function renderTranscript(format: SubFormat, blocks: Cue[], meta: ExportMeta): string {
  switch (format) {
    case "srt":
      return blocks
        .map((c, i) => `${i + 1}\n${stamp(c.start, ",")} --> ${stamp(c.end, ",")}\n${linesOf(c).join("\n")}\n`)
        .join("\n");
    case "vtt":
      return `WEBVTT\n\n${blocks
        .map(
          (c) =>
            `${stamp(c.start, ".")} --> ${stamp(c.end, ".")}\n${linesOf(c)
              .map((l) => l.replace(/-->/g, "→"))
              .join("\n")}\n`,
        )
        .join("\n")}`;
    case "txt":
      return `${blocks.map((b) => `[${clockOf(b.start)}] ${[b.orig, b.zh].filter(Boolean).join("\n")}`).join("\n\n")}\n`;
    case "md": {
      const head = [
        `# ${meta.title}`,
        "",
        ...(meta.show || meta.url ? [[meta.show, meta.url].filter(Boolean).join(" · "), ""] : []),
      ];
      const body = blocks.map(
        (b) => `**${clockOf(b.start)}** ${[b.orig, b.zh].filter(Boolean).join("  \n")}`,
      );
      return `${[...head, ...body.flatMap((x) => [x, ""])].join("\n")}`;
    }
  }
}

export function safeFileName(title: string, ext: string): string {
  const base =
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "podcast-desk";
  return `${base}.${ext}`;
}

const STAMP_LINK_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
const RANGE_OR_STAMP_RE = /\s*\[\d{1,2}:\d{2}(?::\d{2})?\](?:\s*[-–~至]\s*\[\d{1,2}:\d{2}(?::\d{2})?\])?/g;

export type CopyKind = "stamps" | "plain" | "markdown";

function plainMarkdown(md: string): string {
  return md
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatAnswerCopy(
  md: string,
  kind: CopyKind,
  ep: Pick<Episode, "title" | "showTitle" | "videoId" | "link">,
): string {
  if (kind === "plain") {
    return plainMarkdown(md.replace(RANGE_OR_STAMP_RE, "")).replace(/[ \t]+([，。；、,.;])/g, "$1");
  }
  if (kind === "stamps") {
    return plainMarkdown(md);
  }
  const body = ep.videoId
    ? md.replace(STAMP_LINK_RE, (_, c: string) => `[${c}](https://youtu.be/${ep.videoId}?t=${parseTimestamp(c)})`)
    : md;
  const srcUrl = ep.videoId ? `https://youtu.be/${ep.videoId}` : ep.link;
  const show = ep.showTitle ? `${ep.showTitle} · ` : "";
  return `${body.trim()}\n\n来源：${show}${ep.title}${srcUrl ? `\n${srcUrl}` : ""}`;
}

export function exportChatMarkdown(
  ep: Pick<Episode, "title" | "showTitle" | "videoId" | "link">,
  messages: ChatMessage[],
): string {
  const body = messages
    .map((m) => {
      if (m.role === "user") return `**问：**${m.content}`;
      const content = ep.videoId
        ? m.content.replace(STAMP_LINK_RE, (_, c: string) => `[${c}](https://youtu.be/${ep.videoId}?t=${parseTimestamp(c)})`)
        : m.content;
      return content.trim();
    })
    .join("\n\n---\n\n");
  const srcUrl = ep.videoId ? `https://youtu.be/${ep.videoId}` : ep.link;
  const sourceLine = `来源：${ep.showTitle ? `${ep.showTitle} · ` : ""}${ep.title}${srcUrl ? `\n${srcUrl}` : ""}`;
  return `# ${ep.title}\n\n${body}\n\n${sourceLine}\n`;
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
