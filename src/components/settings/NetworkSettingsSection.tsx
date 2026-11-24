import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, LogOut, Trash2, Upload } from "lucide-react";
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
  const [ytSignedIn, setYtSignedIn] = useState(false);
  const [ytLoading, setYtLoading] = useState(false);
  const [ytMsg, setYtMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const ytSupported = !!health?.ytLoginSupported;

  const refreshYtAuth = useCallback(async () => {
    if (!ytSupported) return;
    try {
      const res = await api.getYouTubeAuth();
      setYtSignedIn(res.signedIn);
    } catch {
      /* ignore */
    }
  }, [ytSupported]);

  useEffect(() => {
    setProxyInput(health?.configuredProxy ?? "");
    setMirrorInput(health?.githubMirror ?? "");
  }, [health?.configuredProxy, health?.githubMirror]);

  useEffect(() => {
    void refreshYtAuth();
    const onChanged = () => void refreshYtAuth();
    window.addEventListener("poddesk:yt-login-changed", onChanged);
    return () => window.removeEventListener("poddesk:yt-login-changed", onChanged);
  }, [refreshYtAuth]);

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

  const handleYtLogin = async () => {
    setYtMsg(null);
    setYtLoading(true);
    try {
      await api.openYouTubeLogin();
      setYtMsg({ ok: true, text: "已打开登录窗口，完成 Google/YouTube 登录后窗口将自动关闭" });
    } catch (err) {
      setYtMsg({ ok: false, text: err instanceof Error ? err.message : "无法打开登录窗口" });
    } finally {
      setYtLoading(false);
    }
  };

  const handleYtLogout = async () => {
    setYtMsg(null);
    setYtLoading(true);
    try {
      await api.logoutYouTube();
      setYtSignedIn(false);
      setYtMsg({ ok: true, text: "已退出桌面端 YouTube 登录态" });
    } catch (err) {
      setYtMsg({ ok: false, text: err instanceof Error ? err.message : "退出登录失败" });
    } finally {
      setYtLoading(false);
    }
  };

  const handleCookieFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      if (!text.trim()) {
        setCookieMsg({ ok: false, text: "所选文件为空" });
        return;
      }
      const saved = await saveCookies(text);
      setCookiesInput("");
      setCookieMsg({ ok: true, text: saved ? `已从 ${file.name} 导入并保存 Cookie` : "已清除 Cookie" });
    } catch (err) {
      setCookieMsg({ ok: false, text: err instanceof Error ? err.message : "读取 Cookie 文件失败" });
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
          下载 CrispASR / yt-dlp / 应用安装包时直连失败会自动回退内置镜像；可指定自定义镜像前缀（当前：
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

      {ytSupported && (
        <section className="setup-block">
          <div className="row-between">
            <p className="setup-title">YouTube 账号登录（推荐）</p>
            <span className={`pill ${ytSignedIn ? "ok" : ""}`}>{ytSignedIn ? "已登录" : "未登录"}</span>
          </div>
          <p className="muted small">
            遇到 YouTube 人机校验时，无需安装浏览器扩展：在此登录一次即可，登录态仅保存在本机桌面窗口，单次调用结束后立即清理临时凭证。
          </p>
          <div className="row-actions">
            <button type="button" className="btn sm primary" onClick={() => void handleYtLogin()} disabled={ytLoading}>
              <LogIn size={13} /> {ytSignedIn ? "重新登录 / 切换账号" : "登录 YouTube"}
            </button>
            {ytSignedIn && (
              <button type="button" className="btn sm" onClick={() => void handleYtLogout()} disabled={ytLoading}>
                <LogOut size={13} /> 退出登录
              </button>
            )}
          </div>
          {ytMsg && <p className={ytMsg.ok ? "ok-text small" : "error-text small"}>{ytMsg.text}</p>}
        </section>
      )}

      <section className="setup-block">
        <div className="row-between">
          <p className="setup-title">YouTube 防风控 cookies.txt（{ytSupported ? "手动兜底" : "按需导入"}）</p>
          <span className={`pill ${hasCookies ? "ok" : ""}`}>{hasCookies ? "已保存" : "未配置"}</span>
        </div>
        <p className="muted small">
          {ytSupported
            ? "若暂不想在应用内登录，可从浏览器导出 Netscape 格式 cookies.txt 导入；仅保存于本机数据目录，绝不回显明文。"
            : "仅当 yt-dlp 遇到 YouTube 人机校验时使用；支持直接上传或粘贴 cookies.txt，绝不回显明文。"}
        </p>

        <details className="cookie-guide">
          <summary>如何在浏览器获取 cookies.txt（3 步）</summary>
          <ol className="cookie-guide-steps">
            <li>
              在 Chrome / Edge 安装开源扩展 <code>Get cookies.txt LOCALLY</code>（不上传任何数据到外部服务器）。
            </li>
            <li>
              打开 <code>youtube.com</code> 并登录你的 Google 账号（可用副账号）。
            </li>
            <li>
              点击扩展图标选择 <strong>Export</strong> 下载 <code>cookies.txt</code>，再点下方「导入文件」或粘贴到文本框保存即可。
            </li>
          </ol>
        </details>

        <input ref={fileRef} type="file" accept=".txt,text/plain" hidden onChange={(e) => void handleCookieFile(e)} />

        <textarea
          className="import-textarea"
          rows={3}
          value={cookiesInput}
          onChange={(e) => setCookiesInput(e.target.value)}
          placeholder="# Netscape HTTP Cookie File ..."
        />
        <div className="row-end">
          <button type="button" className="btn sm" onClick={() => fileRef.current?.click()}>
            <Upload size={13} /> 导入 cookies.txt 文件
          </button>
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
