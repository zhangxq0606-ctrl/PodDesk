import { Fragment, memo, type ReactNode } from "react";
import { parseClock } from "../lib/format";

const INLINE_RE =
  /(\*\*[^*]+\*\*|`[^`]+`|\[\d{1,2}:\d{2}(?::\d{2})?\](?:\s*[-–~至]\s*\[\d{1,2}:\d{2}(?::\d{2})?\])?)/g;

function renderInline(text: string, onSeek: (t: number) => void, key: string): ReactNode[] {
  return text.split(INLINE_RE).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={k}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={k}>{part.slice(1, -1)}</code>;
    }
    const stamp = part.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
    if (stamp) {
      const seconds = parseClock(stamp[1]);
      return seconds == null ? (
        part
      ) : (
        <button
          key={k}
          type="button"
          className="stamp"
          onClick={() => onSeek(seconds)}
          title={`跳转到 ${stamp[1]}`}
        >
          {stamp[1]}
        </button>
      );
    }
    return <Fragment key={k}>{part}</Fragment>;
  });
}

export const Markdown = memo(function Markdown({
  text,
  onSeek,
}: {
  text: string;
  onSeek: (t: number) => void;
}) {
  const blocks: ReactNode[] = [];
  let list: ReactNode[] = [];
  let ordered = false;
  let timeline = true;
  let rows: string[][] = [];
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];

  const flushCode = (k: string) => {
    if (!inCode) return;
    blocks.push(
      <pre key={k} className="md-pre">
        {codeLang ? <span className="md-code-lang">{codeLang}</span> : null}
        <code>{codeLines.join("\n")}</code>
      </pre>,
    );
    inCode = false;
    codeLang = "";
    codeLines = [];
  };

  const flushTable = () => {
    if (!rows.length) return;
    const [head, ...body] = rows;
    const k = `t${blocks.length}`;
    blocks.push(
      <div key={k} className="md-table">
        <table>
          <thead>
            <tr>
              {head.map((c, j) => (
                <th key={j}>{renderInline(c, onSeek, `${k}h${j}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{renderInline(c, onSeek, `${k}${i}-${j}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    rows = [];
  };

  const flush = () => {
    flushTable();
    const cls = timeline && list.length > 0 ? "timeline" : undefined;
    if (list.length) {
      blocks.push(
        ordered ? (
          <ol key={`l${blocks.length}`} className={cls}>
            {list}
          </ol>
        ) : (
          <ul key={`l${blocks.length}`} className={cls}>
            {list}
          </ul>
        ),
      );
    }
    list = [];
    timeline = true;
  };

  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (!inCode) {
        flush();
        inCode = true;
        codeLang = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        flushCode(`code-${i}`);
      }
      return;
    }

    if (inCode) {
      codeLines.push(raw);
      return;
    }

    const cells = trimmed.match(/^\|(.*)\|$/);
    if (cells) {
      if (list.length) flush();
      if (!/^[\s|:-]+$/.test(cells[1])) {
        rows.push(cells[1].split("|").map((c) => c.trim()));
      }
      return;
    }
    flushTable();

    const bullet = line.match(/^\s*(?:[-*•]|(\d+)[.)、])\s+(.*)$/);
    if (bullet) {
      const isOrdered = Boolean(bullet[1]);
      if (list.length && isOrdered !== ordered) flush();
      ordered = isOrdered;
      const stamped = /^\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(bullet[2]);
      timeline = timeline && stamped;
      list.push(
        <li key={i} className={stamped ? "ts-item" : undefined}>
          {renderInline(bullet[2], onSeek, `b${i}`)}
        </li>,
      );
      return;
    }

    if (trimmed.startsWith(">")) {
      flush();
      blocks.push(
        <blockquote key={i}>{renderInline(trimmed.replace(/^>\s*/, ""), onSeek, `q${i}`)}</blockquote>,
      );
      return;
    }

    flush();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push(
        heading[1].length <= 2 ? (
          <h3 key={i}>{renderInline(heading[2], onSeek, `h${i}`)}</h3>
        ) : (
          <h4 key={i}>{renderInline(heading[2], onSeek, `h${i}`)}</h4>
        ),
      );
    } else if (trimmed === "---" || trimmed === "***") {
      blocks.push(<hr key={i} />);
    } else if (trimmed) {
      blocks.push(<p key={i}>{renderInline(line, onSeek, `p${i}`)}</p>);
    }
  });

  flush();
  flushCode("code-end");

  return <div className="markdown">{blocks}</div>;
});
