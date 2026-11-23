import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../../lib/api";
import { useStore } from "../../store";

export function NetworkSettingsSection() {
  const { health, hasCookies, saveCookies, bootstrap } = useStore(
    useShallow((s) => ({
      health: s.health,
      hasCookies: s.hasCookies,
      saveCookies: s.saveCookies,
      bootstrap: s.bootstrap,
    })),
  );

  const [proxyInput, setProxyInput] = useState(health?.configuredProxy ?? "");
  const [proxyMsg, setProxyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mirrorInput, setMirrorInput] = useState(health?.githubMirror ?? "");
  const [mirrorMsg, setMirrorMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cookiesInput, setCookiesInput] = useState("");
  const [cookieMsg, setCookieMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setProxyInput(health?.configuredProxy ?? "");
    setMirrorInput(health?.githubMirror ?? "");
  }, [health?.configuredProxy, health?.githubMirror]);

  const handleSaveProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    setProxyMsg(null);
    try {
      const res = await api.saveSettings({ proxy: proxyInput.trim() });
      setProxyMsg({
        ok: true,
        text: res.effectiveProxy ? `已保存，生效代理：${res.effectiveProxy}` : "已保存为直连模式",
      });
      await bootstrap();
    } catch (err) {
      setProxyMsg({ ok: false, text: err instanceof Error ? err.message : "代理保存失败" });
    }
  };

  const handleSaveMirror = async (e: React.FormEvent) => {
    e.preventDefault();
    setMirrorMsg(null);
    try {
      const res = await api.saveSettings({ githubMirror: mirrorInput.trim() });
      setMirrorMsg({
        ok: true,
        text: res.githubMirror ? `已保存自定义镜像：${res.githubMirror}` : "已恢复自动回退模式",
      });
      await bootstrap();
    } catch (err) {
      setMirrorMsg({ ok: false, text: err instanceof Error ? err.message : "镜像保存失败" });
    }
  };

  return (
    <>
      <section className="setup-block">
        <p className="setup-title">本机代理</p>
        <p className="muted small">
          当前生效代理：<code>{health?.effectiveProxy || "无（直连）"}</code>
        </p>
        <form className="key-row" onSubmit={handleSaveProxy}>
          <input
            value={proxyInput}
            onChange={(e) => setProxyInput(e.target.value)}
            placeholder="留空自动跟随系统代理，或填 http://127.0.0.1:7897"
          />
          <button type="submit" className="btn sm primary">
            保存
          </button>
        </form>
        {proxyMsg && <p className={proxyMsg.ok ? "ok-text small" : "error-text small"}>{proxyMsg.text}</p>}
      </section>

      <section className="setup-block">
        <p className="setup-title">GitHub 下载镜像（国内无代理可选）</p>
        <p className="muted small">
          下载 CrispASR / yt-dlp 时直连失败会自动回退内置镜像；可指定自定义镜像前缀（当前：
          <code>{health?.githubMirror || "自动（直连失败后回退内置镜像）"}</code>）。
        </p>
        <form className="key-row" onSubmit={handleSaveMirror}>
          <input
            value={mirrorInput}
            onChange={(e) => setMirrorInput(e.target.value)}
            placeholder="留空自动回退，或填 https://ghfast.top/"
            spellCheck={false}
          />
          <button type="submit" className="btn sm primary">
            保存
          </button>
        </form>
        {mirrorMsg && <p className={mirrorMsg.ok ? "ok-text small" : "error-text small"}>{mirrorMsg.text}</p>}
      </section>

      <section className="setup-block">
        <div className="row-between">
          <p className="setup-title">YouTube 防风控 cookies.txt（按需粘贴）</p>
          <span className={`pill ${hasCookies ? "ok" : ""}`}>
            {hasCookies ? "已保存" : "未配置"}
          </span>
        </div>
        <p className="muted small">
          仅当 yt-dlp 遇到 YouTube 人机校验时使用；仅保存于本机数据目录，绝不回显明文。
        </p>
        <textarea
          className="import-textarea"
          rows={4}
          value={cookiesInput}
          onChange={(e) => setCookiesInput(e.target.value)}
          placeholder="# Netscape HTTP Cookie File ..."
        />
        <div className="row-end">
          {hasCookies && (
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                void saveCookies("").then(() => {
                  setCookiesInput("");
                  setCookieMsg({ ok: true, text: "已清除本地 Cookie" });
                })
              }
            >
              <Trash2 size={13} /> 清除已存 Cookie
            </button>
          )}
          <button
            type="button"
            className="btn sm primary"
            disabled={!cookiesInput.trim()}
            onClick={() =>
              void saveCookies(cookiesInput).then((saved) => {
                setCookiesInput("");
                setCookieMsg({ ok: true, text: saved ? "Cookie 已保存" : "已清除 Cookie" });
              })
            }
          >
            保存 Cookie
          </button>
        </div>
        {cookieMsg && <p className={cookieMsg.ok ? "ok-text small" : "error-text small"}>{cookieMsg.text}</p>}
      </section>
    </>
  );
}
