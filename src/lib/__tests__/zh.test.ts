import { describe, expect, it } from "vitest";
import { isMostlyChineseText, isPureTransliteration, shouldTranslateTitle } from "../zh";

describe("foreign title translation filters", () => {
  it("recognizes Chinese titles and skips translating them", () => {
    expect(isMostlyChineseText("这一期聊聊独立开发者的长期主义")).toBe(true);
    expect(shouldTranslateTitle("这一期聊聊独立开发者的长期主义")).toBe(false);
    expect(shouldTranslateTitle("AI 时代如何重构生产力")).toBe(false); // already mostly Chinese
    expect(shouldTranslateTitle("This One AI Prompt Will Organise Your Entire Life")).toBe(true);
    expect(shouldTranslateTitle("458: Scaling Laws & Systems")).toBe(true);
    expect(shouldTranslateTitle("   ")).toBe(false);
    expect(shouldTranslateTitle("123")).toBe(false);
  });

  it("suppresses pure person-name transliterations for show names", () => {
    expect(isPureTransliteration("阿里·阿布达尔")).toBe(true);
    expect(isPureTransliteration("莱克斯 · 弗里德曼")).toBe(true);
    expect(isPureTransliteration("独立开发者电台")).toBe(false);
    expect(isPureTransliteration("Lex Fridman 播客精选")).toBe(false);
  });
});
