import { describe, expect, it } from "vitest";
import { buildBlocks, exportChatMarkdown, formatAnswerCopy, renderTranscript, safeFileName } from "../subexport";
import type { Segment } from "../api";

describe("subexport utilities", () => {
  const segs: Segment[] = [
    { start: 1.5, end: 4.25, text: "Hello world --> test" },
    { start: 65, end: 70, text: "Second line" },
  ];

  it("builds bilingual, original, and translation cue blocks with fallback", () => {
    expect(buildBlocks(segs, ["你好世界", null], "bilingual")).toEqual([
      { start: 1.5, end: 4.25, orig: "Hello world --> test", zh: "你好世界" },
      { start: 65, end: 70, orig: "Second line" },
    ]);
    expect(buildBlocks(segs, ["你好世界", "第二行"], "original")).toEqual([
      { start: 1.5, end: 4.25, orig: "Hello world --> test" },
      { start: 65, end: 70, orig: "Second line" },
    ]);
    expect(buildBlocks(segs, ["你好世界", null], "translation")).toEqual([
      { start: 1.5, end: 4.25, orig: "", zh: "你好世界" },
      { start: 65, end: 70, orig: "Second line" },
    ]);
  });

  it("renders srt, vtt, txt, and md transcripts properly", () => {
    const blocks = buildBlocks(segs, ["你好世界", "第二行"], "bilingual");
    const meta = { title: "Ep 1", show: "Show A", url: "https://example.com" };

    const srt = renderTranscript("srt", blocks, meta);
    expect(srt).toContain("1\n00:00:01,500 --> 00:00:04,250\n你好世界\nHello world --> test");

    const vtt = renderTranscript("vtt", blocks, meta);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.500 --> 00:00:04.250\n你好世界\nHello world → test");

    const txt = renderTranscript("txt", blocks, meta);
    expect(txt).toContain("[00:01] Hello world --> test\n你好世界");

    const md = renderTranscript("md", blocks, meta);
    expect(md).toContain("# Ep 1\n\nShow A · https://example.com");
    expect(md).toContain("**01:05** Second line  \n第二行");
  });

  it("sanitizes filenames safely across Windows reserved characters", () => {
    expect(safeFileName('Episode 1: "Test" <A/B>?', "md")).toBe("Episode 1 Test A B.md");
    expect(safeFileName("   ", "srt")).toBe("podcast-desk.srt");
  });

  it("formats answers in plain, stamps, and YouTube markdown copy modes", () => {
    const ep = {
      title: "Deep Dive",
      showTitle: "Tech Talk",
      videoId: "abc123",
      link: "https://youtu.be/abc123",
    };
    const answer = "## 总结\n- **重点**：核心设计 [02:05] 与对比 [03:00] - [03:20]。";

    const plain = formatAnswerCopy(answer, "plain", ep);
    expect(plain).toBe("总结\n• 重点：核心设计 与对比。");

    const stamps = formatAnswerCopy(answer, "stamps", ep);
    expect(stamps).toContain("[02:05]");
    expect(stamps).not.toContain("**");

    const markdown = formatAnswerCopy(answer, "markdown", ep);
    expect(markdown).toContain("[02:05](https://youtu.be/abc123?t=125)");
    expect(markdown).toContain("来源：Tech Talk · Deep Dive\nhttps://youtu.be/abc123");
  });

  it("exports full chat logs as markdown with source attribution", () => {
    const out = exportChatMarkdown(
      { title: "Demo", showTitle: "Pod", videoId: undefined, link: "https://pod.fm/1" },
      [
        { role: "user", content: "讲了什么？" },
        { role: "assistant", content: "谈到了 [01:30] 的结论。" },
      ],
    );
    expect(out).toContain("# Demo");
    expect(out).toContain("**问：**讲了什么？");
    expect(out).toContain("谈到了 [01:30] 的结论。");
    expect(out).toContain("来源：Pod · Demo\nhttps://pod.fm/1");
  });
});
