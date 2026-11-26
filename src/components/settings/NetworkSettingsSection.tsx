import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Check, ChevronDown, Copy, Loader2, LogIn, LogOut, Trash2, Upload, XCircle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api, type NetCheckItem, type NetworkReport } from "../../lib/api";
import { useStore } from "../../store";

const NET_CHECK_LABELS: Record<NetCheckItem["id"], string> = {
  proxy: "当前代理",
  youtube: "YouTube 主站",
  video: "YouTube 视频流节点",
  ytdlpSource: "yt-dlp 下载源",
  ytdlp: "本地 yt-dlp 组件",
};

function webviewProxyLabel(status: string): string {
  switch (status) {
    case "app":
      return "桌面播放器已启用应用内代理";
    case "system":
      return "桌面播放器跟随系统代理";
    case "restart":
      return "应用内代理已修改，需重启 PodDesk 后播放器生效";
    case "unsupported-os":
      return "当前系统版本不支持注入桌面代理，播放器将继续走系统代理";
    case "unsupported-proxy":
      return "当前代理格式不被桌面 WebView 支持（仅支持带端口的 http/socks5），播放器走系统代理";
    case "browser":
      return "浏览器工作台直接跟随系统/浏览器代理";
    default:
      return status;
  }
}

export function NetworkSettingsSection() {
  const { health, hasCookies, saveCookies, bootstrap, networkDiagSeq, notify } = useStore(
    useShallow((s) => ({
      health: s.health,
      hasCookies: s.hasCookies,
      saveCookies: s.saveCookies,
      bootstrap: s.bootstrap,
      networkDiagSeq: s.networkDiagSeq,
      notify: s.notify,
    })),
  );

  const [proxyInput, setProxyInput] = useState(health?.configuredProxy ?? "");
  const [proxyMsg, setProxyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mirrorInput, setMirrorInput] = useState(health?.githubMirror ?? "");
  const [mirrorMsg, setMirrorMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cookiesInput, setCookiesInput] = useState("");
  const [cookieMsg, setCookieMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cookieOpen, setCookieOpen] = useState(false);
  const [ytSignedIn, setYtSignedIn] = useState(false);
  const [ytLoading, setYtLoading] = useState(false);
  const [ytMsg, setYtMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [biliSignedIn, setBiliSignedIn] = useState(false);
  const [biliLoading, setBiliLoading] = useState(false);
  const [biliMsg, setBiliMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagReport, setDiagReport] = useState<NetworkReport | null>(null);
  const [diagErr, setDiagErr] = useState<string | null>(null);
  const [diagCopied, setDiagCopied] = useState(false);
  const lastSeqRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const ytSupported = !!health?.ytLoginSupported;
  const biliSupported = !!health?.biliLoginSupported;

  const refreshYtAuth = useCallback(async () => {
    if (!ytSupported) return;
    try {
      const res = await api.getYouTubeAuth();
      setYtSignedIn(res.signedIn);
    } catch {
      /* ignore */
    }
  }, [ytSupported]);

  const refreshBiliAuth = useCallback(async () => {
    if (!biliSupported) return;
    try {
      const res = await api.getBilibiliAuth();
      setBiliSignedIn(res.signedIn);
    } catch {
      /* ignore */
    }
  }, [biliSupported]);

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

  useEffect(() => {
    void refreshBiliAuth();
    const onChanged = () => void refreshBiliAuth();
    window.addEventListener("poddesk:bili-login-changed", onChanged);
    return () => window.removeEventListener("poddesk:bili-login-changed", onChanged);
  }, [refreshBiliAuth]);

  const runDiagnostics = useCallback(async () => {
    setDiagRunning(true);
    setDiagErr(null);
    setDiagCopied(false);
    try {
      const res = await api.networkCheck();
      setDiagReport(res);
    } catch (err) {
      setDiagErr(err instanceof Error ? err.message : "网络诊断执行失败");
    } finally {
      setDiagRunning(false);
    }
  }, []);

  useEffect(() => {
    if (networkDiagSeq > lastSeqRef.current) {
      lastSeqRef.current = networkDiagSeq;
      void runDiagnostics();
    }
  }, [networkDiagSeq, runDiagnostics]);

  const copyDiagReport = async () => {
    if (!diagReport) return;
    const lines = [
      `PodDesk v${health?.version ?? "0.2.4"} 网络诊断报告`,
      `播放器代理状态: ${webviewProxyLabel(diagReport.webviewProxy)}`,
      `GitHub 镜像: ${diagReport.githubMirror || "自动（直连优先，失败后回退）"}`,
      ...diagReport.checks.map((c) => {
        const name = NET_CHECK_LABELS[c.id] ?? c.id;
        const ms = typeof c.ms === "number" ? ` (${c.ms} ms)` : "";
        return `- ${name}: ${c.ok ? "正常" : "异常"}${ms}${c.detail ? ` · ${c.detail}` : ""}`;
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setDiagCopied(true);
      notify("已复制脱敏诊断报告");
    } catch {
      notify("复制诊断报告失败", false);
    }
  };

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

  const handleBiliLogin = async () => {
    setBiliMsg(null);
    setBiliLoading(true);
    try {
      await api.openBilibiliLogin();
      setBiliMsg({ ok: true, text: "已打开 B站扫码登录窗口，完成登录后窗口将自动关闭" });
    } catch (err) {
      setBiliMsg({ ok: false, text: err instanceof Error ? err.message : "无法打开 B站登录窗口" });
    } finally {
      setBiliLoading(false);
    }
  };

  const handleBiliLogout = async () => {
    setBiliMsg(null);
    setBiliLoading(true);
    try {
      await api.logoutBilibili();
      setBiliSignedIn(false);
      setBiliMsg({ ok: true, text: "已退出桌面端 B站登录态" });
    } catch (err) {
      setBiliMsg({ ok: false, text: err instanceof Error ? err.message : "退出登录失败" });
    } finally {
      setBiliLoading(false);
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

  const renderCookieContent = () => (
    <>
      <p className="s-row-desc">
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
            打开 <code>youtube.com</code> 或 <code>bilibili.com</code> 并登录账号。
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
    </>
  );

  return (
    <div className="settings-pane">
      <div className="settings-head">
        <div>
          <h4>网络与风控</h4>
          <p>配置本机代理、下载镜像通道，以及排查网络连通与平台账号登录状态</p>
        </div>
      </div>

      <section className="s-group">
        <div className="s-group-head">
          <span className="s-group-title">代理与下载通道</span>
        </div>
        <div className="s-card">
          <div className="s-row-col">
            <div className="row-between">
              <span className="s-row-label">本机代理</span>
              <span className="s-row-desc">
                当前生效：<code>{health?.effectiveProxy || "无（直连）"}</code>
              </span>
            </div>
            <form className="key-row" onSubmit={handleSaveProxy}>
              <input
                value={proxyInput}
                onChange={(e) => setProxyInput(e.target.value)}
                placeholder="留空自动跟随系统代理，或填 http://127.0.0.1:7897"
              />
              <button type="submit" className="btn sm">
                保存
              </button>
            </form>
            {proxyMsg && <p className={proxyMsg.ok ? "ok-text small" : "error-text small"}>{proxyMsg.text}</p>}
          </div>

          <div className="s-row-col">
            <div className="row-between">
              <span className="s-row-label">GitHub 下载镜像（国内无代理可选）</span>
              <span className="s-row-desc">
                当前：<code>{health?.githubMirror || "自动（直连失败回退内置镜像）"}</code>
              </span>
            </div>
            <form className="key-row" onSubmit={handleSaveMirror}>
              <input
                value={mirrorInput}
                onChange={(e) => setMirrorInput(e.target.value)}
                placeholder="留空自动回退，或填 https://ghfast.top/"
                spellCheck={false}
              />
              <button type="submit" className="btn sm">
                保存
              </button>
            </form>
            {mirrorMsg && <p className={mirrorMsg.ok ? "ok-text small" : "error-text small"}>{mirrorMsg.text}</p>}
          </div>
        </div>
      </section>

      <section className="s-group">
        <div className="s-group-head">
          <span className="s-group-title">网络诊断</span>
        </div>
        <div className="s-card">
          <div className="s-row">
            <div className="s-row-meta">
              <span className="s-row-label">连通性体检</span>
              <span className="s-row-desc">一次检测 YouTube、视频流节点、yt-dlp 与播放器代理通路，复制结果自动脱敏</span>
            </div>
            <div className="row-actions">
              {diagReport && (
                <button type="button" className="btn sm" onClick={() => void copyDiagReport()}>
                  {diagCopied ? <Check size={13} /> : <Copy size={13} />}
                  <span>{diagCopied ? "已复制" : "复制报告"}</span>
                </button>
              )}
              <button type="button" className="btn sm primary" onClick={() => void runDiagnostics()} disabled={diagRunning}>
                {diagRunning ? <Loader2 size={13} className="spin" /> : <Activity size={13} />}
                <span>{diagRunning ? "检测中..." : "运行诊断"}</span>
              </button>
            </div>
          </div>

          {diagErr && (
            <div className="s-row">
              <p className="error-text small">{diagErr}</p>
            </div>
          )}

          {diagReport && (
            <div className="netcheck-list">
              <div className="netcheck-row">
                <span className="netcheck-name">播放器代理</span>
                <span className="netcheck-detail">{webviewProxyLabel(diagReport.webviewProxy)}</span>
              </div>
              {diagReport.checks.map((item) => (
                <div key={item.id} className="netcheck-row">
                  <span className={`netcheck-badge ${item.ok ? "ok" : "bad"}`}>
                    {item.ok ? <Check size={12} /> : <XCircle size={12} />}
                  </span>
                  <span className="netcheck-name">{NET_CHECK_LABELS[item.id] ?? item.id}</span>
                  <span className="netcheck-detail">
                    {item.detail || (item.ok ? "连接正常" : "不可达")}
                    {typeof item.ms === "number" ? ` · ${item.ms} ms` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="s-group">
        <div className="s-group-head">
          <span className="s-group-title">平台账号登录与防风控</span>
        </div>

        {(ytSupported || biliSupported) && (
          <div className="s-card">
            {ytSupported && (
              <div className="s-row">
                <div className="s-row-meta">
                  <span className="s-row-label row-tight">
                    <span>YouTube 账号登录（推荐）</span>
                    <span className={`pill ${ytSignedIn ? "ok" : ""}`}>{ytSignedIn ? "已登录" : "未登录"}</span>
                  </span>
                  <span className="s-row-desc">
                    遇到人机校验时在此登录一次即可；登录态仅保存在本机桌面窗口，单次调用后自动清理临时凭证
                  </span>
                  {ytMsg && <p className={ytMsg.ok ? "ok-text small" : "error-text small"}>{ytMsg.text}</p>}
                </div>
                <div className="row-actions">
                  <button type="button" className="btn sm primary" onClick={() => void handleYtLogin()} disabled={ytLoading}>
                    <LogIn size={13} /> {ytSignedIn ? "切换账号" : "登录 YouTube"}
                  </button>
                  {ytSignedIn && (
                    <button type="button" className="btn sm" onClick={() => void handleYtLogout()} disabled={ytLoading}>
                      <LogOut size={13} /> 退出登录
                    </button>
                  )}
                </div>
              </div>
            )}

            {biliSupported && (
              <div className="s-row">
                <div className="s-row-meta">
                  <span className="s-row-label row-tight">
                    <span>B站账号扫码登录（推荐）</span>
                    <span className={`pill ${biliSignedIn ? "ok" : ""}`}>{biliSignedIn ? "已登录" : "未登录"}</span>
                  </span>
                  <span className="s-row-desc">
                    登录后可直出 B站官方与 AI 字幕（跳过语音转写模型）并解锁更高画质，凭证仅存本机桌面窗口
                  </span>
                  {biliMsg && <p className={biliMsg.ok ? "ok-text small" : "error-text small"}>{biliMsg.text}</p>}
                </div>
                <div className="row-actions">
                  <button type="button" className="btn sm primary" onClick={() => void handleBiliLogin()} disabled={biliLoading}>
                    <LogIn size={13} /> {biliSignedIn ? "切换账号" : "扫码登录 B站"}
                  </button>
                  {biliSignedIn && (
                    <button type="button" className="btn sm" onClick={() => void handleBiliLogout()} disabled={biliLoading}>
                      <LogOut size={13} /> 退出登录
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {ytSupported ? (
          <div className="s-disclosure">
            <button
              type="button"
              className="s-disclosure-head"
              aria-expanded={cookieOpen}
              onClick={() => setCookieOpen((v) => !v)}
            >
              <div className="s-row-meta">
                <span className="s-row-label">手动兜底：导入 cookies.txt</span>
                <span className="s-row-desc">不方便在应用内登录时，可从浏览器导出 Cookie 文件作为兜底</span>
              </div>
              <div className="s-disclosure-right">
                <span className={`pill ${hasCookies ? "ok" : ""}`}>{hasCookies ? "已保存" : "未配置"}</span>
                <ChevronDown size={14} className={cookieOpen ? "flip" : ""} />
              </div>
            </button>
            {cookieOpen && <div className="s-disclosure-body">{renderCookieContent()}</div>}
          </div>
        ) : (
          <div className="s-card">
            <div className="s-row-col">
              <div className="row-between">
                <span className="s-row-label">YouTube 防风控 cookies.txt（按需导入）</span>
                <span className={`pill ${hasCookies ? "ok" : ""}`}>{hasCookies ? "已保存" : "未配置"}</span>
              </div>
              {renderCookieContent()}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
