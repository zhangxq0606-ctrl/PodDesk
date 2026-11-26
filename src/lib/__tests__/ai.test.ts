import { describe, expect, it } from "vitest";
import {
  batches,
  buildPresenceNote,
  buildQaSystem,
  cleanShowNotes,
  clock,
  countTranslated,
  hasTimelineHeading,
  isMostlyChinese,
  parseGuideMarkdown,
  parseTimestamp,
  pieces,
  salvage,
  sampleTranscriptForContext,
  STARTER_PROMPT_IDS,
  summaryPrompt,
  transcriptBudget,
  transcriptForModel,
  translationConcurrency,
} from "../ai";
import type { ProviderConfig, Segment } from "../api";

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

    const unpunctuated = pieces(
      "今天这些视频我们就来详细了解一下IP地址的那些事如果只有一台电脑那么这台电脑的数据就会全部存储在这台电脑的硬盘上与其他的电脑不会产生任何的干系",
      true,
    );
    expect(unpunctuated.length).toBeGreaterThanOrEqual(3);
    expect(unpunctuated.every((p) => p.length <= 24)).toBe(true);
    expect(unpunctuated.join("")).toContain("IP地址");
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

    const reordered = salvage('{"t":[{"text":"倒序文本","id":5,"extra":true}]}', [5]);
    expect(reordered.get(5)).toBe("倒序文本");
  });

  it("keeps QA system prompt static and formats presence notes selectively", () => {
    const sysA = buildQaSystem("Ep 1", "Show", "[00:10] Hello");
    const sysB = buildQaSystem("Ep 1", "Show", "[00:10] Hello");
    expect(sysA).toBe(sysB);

    const segs: Segment[] = [
      { start: 10, end: 15, text: "First line" },
      { start: 55, end: 62, text: "Target discussion" },
      { start: 110, end: 115, text: "Later line" },
    ];
    const note = buildPresenceNote(segs, 60, "刚才这里说了啥？", { translation: ["第一句", "目标讨论", "后续"] });
    expect(note).toContain("[01:00]");
    expect(note).toContain("Target discussion ｜ 目标讨论");
    expect(note).not.toContain("Later line");

    expect(buildPresenceNote(segs, 60, "关于 [00:55] 这段话什么意思")).toBe("");
    expect(buildPresenceNote(segs, 60, "请总结全期", { skipPresence: true })).toBe("");

    const withCtx = buildQaSystem("Ep 1", "Show", "[00:10] Hello", undefined, {
      notes: "<p>Guest <b>Alice</b> discusses scaling laws https://example.com</p>",
      ctx: {
        summary: "深度对话节目",
        speakers: [{ name: "Alice", zh: "爱丽丝", role: "研究者" }],
        terms: [{ src: "Scaling Law", zh: "缩放定律" }],
      },
    });
    expect(withCtx).toContain("<episode_context>");
    expect(withCtx).toContain("Alice（爱丽丝） · 研究者");
    expect(withCtx).toContain("Scaling Law → 缩放定律");
    expect(withCtx).toContain("Guest Alice discusses scaling laws");
    expect(withCtx).not.toContain("https://example.com");
  });

  it("adapts summary chapters by duration and samples long transcripts across full timeline", () => {
    expect(summaryPrompt(600)).toContain("3–5 个话题段落");
    expect(summaryPrompt(2400)).toContain("6–10 个话题段落");
    expect(summaryPrompt(7200)).toContain("10–16 个话题段落");
    expect(summaryPrompt(7200)).toContain("严禁写成 [05:10-08:20]");

    expect(cleanShowNotes("<div>Hi &nbsp; <a href='x'>link</a> https://a.co </div>")).toContain("Hi");

    const marathon: Segment[] = Array.from({ length: 120 }, (_, i) => ({
      start: i * 90,
      end: i * 90 + 30,
      text: `Marker_${String(i).padStart(3, "0")} detailed segment content about architecture`,
    }));
    const sampled = transcriptForModel(marathon, null, 2400);
    expect(sampled).toContain("Marker_000");
    expect(sampled).toContain("Marker_060");
    expect(sampled).toContain("Marker_108");
    expect(sampled).toContain("略过中间段落");

    const ctxSample = sampleTranscriptForContext(marathon, 1200);
    expect(ctxSample).toContain("Marker_000");
    expect(ctxSample).toContain("Marker_054");
    expect(ctxSample).toContain("Marker_060");
  });

  it("counts empty translated lines and picks tiered concurrency and budget", () => {
    expect(countTranslated(["你好", "", null, undefined, "世界"])).toBe(3);
    const local: ProviderConfig = { id: "ollama", name: "Ollama", protocol: "openai", group: "local", baseUrl: "", model: "qwen3", needsKey: false };
    const cli: ProviderConfig = { id: "codex", name: "Codex", protocol: "cli", group: "cli", baseUrl: "", model: "", needsKey: false };
    const cloud: ProviderConfig = { id: "deepseek", name: "DeepSeek", protocol: "openai", group: "provider", baseUrl: "", model: "deepseek-chat", needsKey: true };
    expect(translationConcurrency(local)).toBe(1);
    expect(translationConcurrency(cli)).toBe(2);
    expect(translationConcurrency(cloud)).toBe(3);
    expect(transcriptBudget(local)).toBe(48_000);
    expect(transcriptBudget(cloud)).toBe(400_000);
    expect(STARTER_PROMPT_IDS).toEqual(["insights", "action", "debate"]);
  });

  it("detects predominantly Chinese transcripts accurately", () => {
    const zhSegs: Segment[] = [{ start: 0, end: 3, text: "欢迎收听本期中文播客节目" }];
    const enSegs: Segment[] = [{ start: 0, end: 3, text: "Welcome back to another episode of the show" }];
    expect(isMostlyChinese(zhSegs)).toBe(true);
    expect(isMostlyChinese(enSegs)).toBe(false);
  });
});
