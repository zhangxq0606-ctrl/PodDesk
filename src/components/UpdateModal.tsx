import { useEffect } from "react";
import { CheckCircle2, Copy, Download, ExternalLink, RefreshCw, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { copyTextSafe } from "./chat/CopyMenu";
import { Markdown } from "./Markdown";

const MAC_QUARANTINE_CMD = "xattr -dr com.apple.quarantine /Applications/PodDesk.app";
const noopSeek = () => {};

function formatAssetSize(bytes?: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function UpdateModal() {
  const { open, setOpen, updateInfo, checkingUpdate, checkUpdate } = useStore(
    useShallow((s) => ({
      open: s.updateModalOpen,
      setOpen: s.setUpdateModalOpen,
      updateInfo: s.updateInfo,
      checkingUpdate: s.checkingUpdate,
      checkUpdate: s.checkUpdate,
    })),
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open || !updateInfo) return null;

  const sizeLabel = formatAssetSize(updateInfo.assetSize);
  const dateLabel = updateInfo.publishedAt ? updateInfo.publishedAt.slice(0, 10) : null;
  const showMacGuide =
    updateInfo.platform === "macos-arm64" ||
    (typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac"));

  return (
    <div
      className="modal-back"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="updateModalTitle"
    >
      <div className="modal update-modal">
        <div className="modal-head">
          <h3 id="updateModalTitle">
            {updateInfo.hasUpdate
              ? `发现新版本 v${updateInfo.latestVersion}`
              : `当前已是最新版本 v${updateInfo.currentVersion}`}
          </h3>
          <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body update-modal-body">
          <div className="update-version-row">
            <span className="update-version-badge">当前 v{updateInfo.currentVersion}</span>
            <span className="muted">→</span>
            <span className={`update-version-badge ${updateInfo.hasUpdate ? "is-new" : ""}`}>
              最新 v{updateInfo.latestVersion}
            </span>
            {dateLabel ? <span className="muted small">发布于 {dateLabel}</span> : null}
            {sizeLabel ? <span className="muted small">· {sizeLabel}</span> : null}
          </div>

          {updateInfo.title && updateInfo.title !== updateInfo.tagName ? (
            <p className="update-release-title">{updateInfo.title}</p>
          ) : null}

          <div className="update-notes markdown">
            <Markdown text={updateInfo.notes || "暂无更新说明。"} onSeek={noopSeek} />
          </div>

          {showMacGuide && (
            <div className="update-mac-hint">
              <p className="update-mac-title">macOS 安装提示</p>
              <p className="muted small">
                开源版本暂未购买 Apple 开发者公证，若替换安装后首次启动提示“已损坏，无法打开 / 移到废纸篓”，在「终端」执行下方命令即可放行：
              </p>
              <div className="cmd-copy-row">
                <code className="cmd-copy-code">{MAC_QUARANTINE_CMD}</code>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void copyTextSafe(MAC_QUARANTINE_CMD)}
                >
                  <Copy size={13} />
                  <span>复制</span>
                </button>
              </div>
            </div>
          )}

          <div className="modal-foot update-foot">
            <button
              type="button"
              className="btn ghost"
              onClick={() => void checkUpdate(true)}
              disabled={checkingUpdate}
            >
              <RefreshCw size={14} className={checkingUpdate ? "spin" : undefined} />
              <span>{checkingUpdate ? "检查中..." : "重新检查"}</span>
            </button>
            <div className="row-actions">
              <a
                className="btn ghost"
                href={updateInfo.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={14} />
                <span>Release 说明</span>
              </a>
              {updateInfo.mirrorDownloadUrl ? (
                <a
                  className="btn"
                  href={updateInfo.mirrorDownloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download size={14} />
                  <span>国内镜像下载</span>
                </a>
              ) : null}
              {updateInfo.hasUpdate ? (
                <a
                  className="btn primary"
                  href={updateInfo.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download size={14} />
                  <span>下载安装包</span>
                </a>
              ) : (
                <span className="muted small row-tight">
                  <CheckCircle2 size={14} />
                  <span>无需升级</span>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
