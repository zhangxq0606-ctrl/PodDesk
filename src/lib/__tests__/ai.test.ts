import { describe, expect, it } from "vitest";
import { batches, clock, hasTimelineHeading, isMostlyChinese, parseGuideMarkdown, parseTimestamp, pieces, salvage } from "../ai";
import type { Segment } from "../api";

describe("ai utilities", () => {
  it("formats clock strings and parses timestamps symmetrically", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(65)).toBe("01:05");
    expect(clock(3661)).toBe("1:01:01");

    expect(parseTimestamp("01:05")).toBe(65);
    expect(parseTimestamp("1:01:01")).toBe(3661);
    expect(parseTimestamp("bad:ts")).toBe(0);
  });

  it("parses guide markdown into overview and structured timeline items", () => {
    const md = [
      "## 一句话总结",
      "主持人围绕 AI Agent 架构进行了深度复盘。",
      "",
      "## 核心要点",
      "- **本地优先**：降低云端成本 [04:12]",
      "",
      "## 章节时间线",
      "- [00:00] **开场引入**：介绍本期主题",
      "- [1:02:05] **实践总结**：分享工程经验",
      "3) [05:30] 扩展讨论: 工具链演化",
    ].join("\n");

    const parsed = parseGuideMarkdown(md);
    expect(parsed.overviewMd).toContain("## 一句话总结");
    expect(parsed.overviewMd).toContain("## 核心要点");
    expect(parsed.overviewMd).not.toContain("## 章节时间线");
    expect(parsed.timeline).toEqual([
      { sec: 0, stamp: "00:00", title: "开场引入", body: "介绍本期主题" },
      { sec: 3725, stamp: "1:02:05", title: "实践总结", body: "分享工程经验" },
      { sec: 330, stamp: "05:30", title: "扩展讨论", body: "工具链演化" },
    ]);
    expect(parseGuideMarkdown("   ")).toEqual({ overviewMd: "", timeline: [], timelineRaw: "" });
  });

  it("handles partial streaming guide markdown cleanly before timeline completion", () => {
    const partialNoTimeline = "## 一句话总结\n嘉宾剖析了推理算力经济学。\n\n## 核心要点\n- **推理成本下降**：";
    expect(hasTimelineHeading(partialNoTimeline)).toBe(false);
    const p1 = parseGuideMarkdown(partialNoTimeline);
    expect(p1.timeline).toEqual([]);
    expect(p1.overviewMd).toContain("嘉宾剖析了推理算力经济学");

    const partialUnclosedBold = `${partialNoTimeline}\n\n## 章节时间线\n- [01:20] **模型规模与效`;
    expect(hasTimelineHeading(partialUnclosedBold)).toBe(true);
    const p2 = parseGuideMarkdown(partialUnclosedBold);
    expect(p2.timeline).toEqual([{ sec: 80, stamp: "01:20", title: "模型规模与效", body: "" }]);
  });

  it("splits English and Chinese text cleanly into reading-sized pieces", () => {
    const en = pieces("Dr. Smith visited the U.S. lab in 2025. Costs fell 1.5x! Everyone cheered.", false);
    expect(en).toEqual(["Dr. Smith visited the U.S. lab in 2025.", "Costs fell 1.5x!", "Everyone cheered."]);

    const zh = pieces("第一句话很短。第二句话接着讲完！第三句继续。", true);
    expect(zh).toEqual(["第一句话很短。", "第二句话接着讲完！", "第三句继续。"]);
  });

  it("chunks untranslated segments by line count, char cap, and gaps", () => {
    const segs: Segment[] = [
      { start: 0, end: 2, text: "Alpha line" },
      { start: 2, end: 4, text: "Beta line" },
      { start: 4, end: 6, text: "Gamma line" },
      { start: 6, end: 8, text: "Delta line" },
      { start: 8, end: 10, text: "Epsilon extra long sentence" },
    ];
    const done = [null, "已译", null, null, null];
    const res = batches(segs, done, { lines: 2, chars: 25, before: 1, after: 1 });
    expect(res).toEqual([
      { ids: [0] },
      { ids: [2, 3] },
      { ids: [4] },
    ]);
  });

  it("recovers translations from clean JSON, fenced JSON, and truncated streams", () => {
    const clean = salvage('```json\n{"t":[{"id":0,"text":"你好"},{"id":2,"text":"再见"},{"id":9,"text":"忽略"}]}\n```', [0, 1, 2]);
    expect([...clean.entries()]).toEqual([
      [0, "你好"],
      [2, "再见"],
    ]);

    const partial = salvage('{"t":[{"id":1,"text":"第一句"},{"id":2,"text":"第', [1, 2, 3]);
    expect(partial.get(1)).toBe("第一句");
    expect(partial.has(2)).toBe(false);
  });

  it("detects predominantly Chinese transcripts accurately", () => {
    const zhSegs: Segment[] = [{ start: 0, end: 3, text: "欢迎收听本期中文播客节目" }];
    const enSegs: Segment[] = [{ start: 0, end: 3, text: "Welcome back to another episode of the show" }];
    expect(isMostlyChinese(zhSegs)).toBe(true);
    expect(isMostlyChinese(enSegs)).toBe(false);
  });
});
