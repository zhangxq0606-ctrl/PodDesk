import { useShallow } from "zustand/react/shallow";
import { useStore } from "../../store";

const SHORTCUTS: [string, string][] = [
  ["Space", "播放 / 暂停"],
  ["← / →", "后退 10 秒 / 前进 10 秒"],
  ["[ / ]", "减速 / 加速播放"],
  ["M", "静音 / 取消静音"],
  ["C", "切换双语 / 中文 / 原文 / 关闭"],
  ["Ctrl + L", "聚焦顶部搜索 / 链接框"],
  ["Ctrl + F", "在当前文字稿内搜索"],
  ["Ctrl + B", "展开 / 收起左侧栏"],
  ["Ctrl + \\", "展开 / 收起右侧栏"],
];

export function ReadingSettingsSection() {
  const { audioNextLine, autoTranslateTitles, savePrefs } = useStore(
    useShallow((s) => ({
      audioNextLine: s.prefs.audioNextLine,
      autoTranslateTitles: s.prefs.autoTranslateTitles,
      savePrefs: s.savePrefs,
    })),
  );

  return (
    <>
      <section className="setup-block">
        <p className="setup-title">播放与字幕习惯</p>
        <label className="check">
          <input
            type="checkbox"
            checked={audioNextLine}
            onChange={(e) => savePrefs({ audioNextLine: e.target.checked })}
          />
          <span>纯音频舞台提前预告下一句字幕</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={autoTranslateTitles}
            onChange={(e) => savePrefs({ autoTranslateTitles: e.target.checked })}
          />
          <span>自动翻译外文标题与频道简介（双语对照，结果本地缓存）</span>
        </label>
        <p className="muted small">
          主题风格与字幕/问答字号已移至左侧「外观」页签统一调整。
        </p>
      </section>

      <section className="setup-block">
        <p className="setup-title">全局快捷键</p>
        <div className="shortcut-grid">
          {SHORTCUTS.map(([keys, desc]) => (
            <div key={keys} className="shortcut-row">
              <kbd>{keys}</kbd>
              <span>{desc}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
