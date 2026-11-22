import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Clock,
  Copy,
  Download,
  History,
  Loader2,
  MessageSquareText,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CHAT_STYLE_CHIPS, countPromptUse, parseGuideMarkdown, QUICK_PROMPTS, STARTER_PROMPT_IDS } from "../lib/ai";
import type { ChatMessage, Episode, ProviderConfig } from "../lib/api";
import { ask } from "../lib/confirm";
import { clock, formatDate } from "../lib/format";
import {
  fetchOfficialSub,
  loadEpisodeChat,
  loadEpisodeGuide,
  runEpisodeGuide,
  runTranscribe,
  saveEpisodeChat,
  saveEpisodeChatArchive,
  sendChatAsk,
  stopChatAsk,
  stopEpisodeGuide,
  stopTranscribe,
  useJobs,
  type ArchivedChat,
} from "../lib/jobs";
import { CLOUD_ASR_PRESETS } from "../lib/providers";
import { downloadTextFile, exportChatMarkdown, formatAnswerCopy, safeFileName, type CopyKind } from "../lib/subexport";
import { useLayout } from "../lib/layout";
import { useStore } from "../store";
import { AskArt, CassetteArt, PageArt, WaveToTextArt } from "./Illustrations";
import { Markdown } from "./Markdown";

async function copyTextSafe(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    useStore.getState().notify("已复制到剪贴板");
  } catch {
    useStore.getState().notify("复制失败，请手动复制", false);
  }
}

function CopyMenu({ text, ep }: { text: string; ep: Episode }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const doCopy = (kind: CopyKind) => {
    setOpen(false);
    void copyTextSafe(formatAnswerCopy(text, kind, ep));
    setDone(true);
    window.setTimeout(() => setDone(false), 1400);
  };

  return (
    <div className="msg-copy" ref={boxRef}>
      <button type="button" className="msg-act" title="复制（保留时间戳）" onClick={() => doCopy("stamps")}>
        {done ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <button
        type="button"
        className="msg-act caret"
        title="更多复制格式"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu msg-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => doCopy("stamps")}>
            <Copy size={13} /> <span>复制，保留时间戳</span>
          </button>
          <button type="button" role="menuitem" onClick={() => doCopy("plain")}>
            <Copy size={13} /> <span>复制，去掉时间戳</span>
          </button>
          <button type="button" role="menuitem" onClick={() => doCopy("markdown")}>
            <Copy size={13} /> <span>{ep.videoId ? "复制 Markdown（含 YouTube 时间链）" : "复制 Markdown（附出处）"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function shortModelName(m: string): string {
  return m.split("/").pop() || m;
}

function ModelPicker({ disabled }: { disabled?: boolean }) {
  const {
    agents,
    providerOverrides,
    verifiedAgents,
    chatProviderId,
    chatModel,
    keyStatus,
    selectChatModel,
    openSettings,
    getAllProviders,
    isProviderReady,
  } = useStore(
    useShallow((s) => ({
      agents: s.agents,
      providerOverrides: s.providerOverrides,
      verifiedAgents: s.verifiedAgents,
      chatProviderId: s.chatProviderId,
      chatModel: s.chatModel,
      keyStatus: s.keyStatus,
      selectChatModel: s.selectChatModel,
      openSettings: s.openSettings,
      getAllProviders: s.getAllProviders,
      isProviderReady: s.isProviderReady,
    })),
  );

  const allProviders = useMemo(
    () => getAllProviders(),
    [agents, providerOverrides, verifiedAgents, getAllProviders],
  );

  const groups = useMemo(() => {
    const usable = allProviders
      .filter((p) => isProviderReady(p))
      .sort((a, b) => Number(b.id === chatProviderId) - Number(a.id === chatProviderId));
    return usable.map((p) => ({
      provider: p,
      models:
        p.protocol === "cli"
          ? [
              "",
              ...new Set([
                ...(p.id === chatProviderId && chatModel ? [chatModel] : []),
                ...(p.models ?? []),
              ]),
            ].filter((m, i) => i === 0 || Boolean(m))
          : [
              ...new Set([
                p.model,
                ...(p.id === chatProviderId && chatModel ? [chatModel] : []),
                ...(p.models ?? []),
              ]),
            ].filter(Boolean),
    }));
  }, [allProviders, chatProviderId, chatModel, keyStatus, isProviderReady]);

  const pendingCli = useMemo(
    () => allProviders.filter((p) => p.protocol === "cli" && p.login !== "ready"),
    [allProviders],
  );

  const curProvider = allProviders.find((p) => p.id === chatProviderId);
  const curIsReady = isProviderReady(curProvider);
  const curEffectiveModel =
    curProvider?.protocol === "cli" ? chatModel : chatModel || curProvider?.model || "";

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          models: g.models.filter((m) => {
            if (!words.length) return true;
            const hay = `${m || "默认模型"} ${g.provider.name} ${g.provider.id}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          }),
        }))
        .filter((g) => g.models.length > 0),
    [groups, words],
  );
  const flat = useMemo(
    () => shown.flatMap((g) => g.models.map((model) => ({ provider: g.provider, model }))),
    [shown],
  );
  const isCurrentItem = (o: { provider: ProviderConfig; model: string }) =>
    o.provider.id === chatProviderId && o.model === curEffectiveModel;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const idx = q ? 0 : flat.findIndex(isCurrentItem);
    setActive(Math.max(0, idx));
  }, [q, open]);

  useEffect(() => {
    listRef.current?.querySelector(".mp-row.is-active")?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (groups.length === 0) {
    return (
      <button
        type="button"
        className="mp-trigger"
        disabled={disabled}
        title={pendingCli.length ? `有 ${pendingCli.length} 个本机 AI 待验证，点击去设置` : "去设置连接或配置模型"}
        onClick={() => openSettings("ai", pendingCli[0]?.id ?? null)}
      >
        <span className="mp-name">连接模型</span>
      </button>
    );
  }

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (o: { provider: ProviderConfig; model: string }) => {
    const nextModel = o.provider.protocol === "cli" ? o.model : o.model === o.provider.model ? "" : o.model;
    void selectChatModel(o.provider.id, nextModel);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) {
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flat[active]) choose(flat[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const triggerLabel = !curIsReady
    ? "选择可用模型"
    : curEffectiveModel
      ? shortModelName(curEffectiveModel)
      : curProvider?.name ?? "选择模型";

  const triggerTitle = curProvider
    ? `${curProvider.name}${curEffectiveModel ? ` · ${curEffectiveModel}` : " · 默认模型"}（从下一问生效）`
    : "选择模型";

  let rowIdx = -1;

  return (
    <div className="mp" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="mp-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={triggerTitle}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setQ("");
          setOpen(true);
          window.requestAnimationFrame(() => searchRef.current?.focus());
        }}
      >
        <span className="mp-name">{triggerLabel}</span>
        <ChevronsUpDown size={12} />
      </button>

      {open && (
        <div className="mp-pop" onKeyDown={onKeyDown}>
          <div className="mp-search">
            <Search size={13} />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索已就绪模型..."
              spellCheck={false}
            />
          </div>
          <div className="mp-list" role="listbox" ref={listRef}>
            {flat.length === 0 && <p className="mp-empty">没有匹配的模型</p>}
            {shown.map((g) => (
              <div key={g.provider.id} role="group" aria-label={g.provider.name}>
                <p className="mp-group">{g.provider.name}</p>
                {g.models.map((m) => {
                  const idx = ++rowIdx;
                  const o = { provider: g.provider, model: m };
                  const selected = isCurrentItem(o);
                  return (
                    <button
                      key={`${g.provider.id}-${m || "default"}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      title={m || `${g.provider.name} 默认模型`}
                      className={`mp-row ${selected ? "is-current" : ""} ${idx === active ? "is-active" : ""}`}
                      onMouseEnter={() => setActive(idx)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(o)}
                    >
                      <span className="mp-check">{selected && <Check size={13} />}</span>
                      <span className="mp-model">{m ? shortModelName(m) : "默认模型"}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {pendingCli.length > 0 && (
            <button
              type="button"
              className="mp-foot mp-foot-hint"
              onClick={() => {
                setOpen(false);
                openSettings("ai", pendingCli[0].id);
              }}
            >
              <span>另有 {pendingCli.length} 个本机 AI 未启用 · 去设置</span>
            </button>
          )}
          <button
            type="button"
            className="mp-foot"
            onClick={() => {
              setOpen(false);
              openSettings("ai", chatProviderId);
            }}
          >
            <Plus size={13} /> 管理模型与 API Key
          </button>
        </div>
      )}
    </div>
  );
}

function PromptMenu({ onPick, disabled }: { onPick: (id: string, body: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="mp" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn sm"
        title="快捷提问模板"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <MessageSquareText size={15} />
      </button>
      {open && (
        <div className="mp-pop prompts" role="menu">
          <div className="mp-list">
            {QUICK_PROMPTS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="pm-row"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPick(p.id, p.body);
                }}
              >
                <span className="pm-title">{p.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryMenu({
  archive,
  ep,
  current,
  onRestore,
  onDelete,
}: {
  archive: ArchivedChat[];
  ep: Episode;
  current: ChatMessage[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!archive.length && !current.length) return null;

  const titleOf = (msgs: ChatMessage[]) => msgs.find((m) => m.role === "user")?.content.slice(0, 42) ?? "对话";

  return (
    <div className="mp" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn sm"
        title="本集对话历史与导出"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <History size={15} />
      </button>
      {open && (
        <div className="mp-pop history" role="menu">
          <p className="mp-head">这一集的对话记录</p>
          <div className="mp-list">
            {!archive.length ? (
              <p className="mp-empty">点击「新对话」后，之前的问答会自动归档在这里。</p>
            ) : (
              archive.map((c) => (
                <div key={c.id} className="hist-row">
                  <button
                    type="button"
                    role="menuitem"
                    className="pm-row"
                    onClick={() => {
                      setOpen(false);
                      onRestore(c.id);
                    }}
                  >
                    <span className="hist-title clamp1">{titleOf(c.messages)}</span>
                    <span className="hist-meta">
                      {c.messages.filter((m) => m.role === "user").length} 问 · {formatDate(c.at)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    title="删除这段归档"
                    onClick={() => onDelete(c.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
          {current.length > 0 && (
            <>
              <button
                type="button"
                className="mp-foot"
                onClick={() => {
                  setOpen(false);
                  void copyTextSafe(exportChatMarkdown(ep, current));
                }}
              >
                <Copy size={13} /> 复制当前对话为 Markdown
              </button>
              <button
                type="button"
                className="mp-foot"
                onClick={() => {
                  setOpen(false);
                  downloadTextFile(safeFileName(`${ep.title}-问答笔记`, "md"), exportChatMarkdown(ep, current));
                  useStore.getState().notify("已导出问答笔记 .md 文件");
                }}
              >
                <Download size={13} /> 下载当前对话 (.md)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ChatPrefsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { chatInstruction, chatInstructionEnabled, savePrefs } = useStore(
    useShallow((s) => ({
      chatInstruction: s.prefs.chatInstruction,
      chatInstructionEnabled: s.prefs.chatInstructionEnabled,
      savePrefs: s.savePrefs,
    })),
  );

  const [text, setText] = useState(chatInstruction);
  const [enabled, setEnabled] = useState(chatInstructionEnabled);

  useEffect(() => {
    if (!open) return;
    setText(chatInstruction);
    setEnabled(chatInstructionEnabled);
  }, [open, chatInstruction, chatInstructionEnabled]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const toggleChip = (chipText: string) => {
    if (text.includes(chipText)) {
      const next = text
        .split("\n")
        .map((line) => line.replace(chipText, "").trim())
        .filter(Boolean)
        .join("\n");
      setText(next);
    } else {
      const trimmed = text.trim();
      setText(trimmed ? `${trimmed}\n${chipText}` : chipText);
      setEnabled(true);
    }
  };

  const handleSave = () => {
    savePrefs({
      chatInstruction: text.trim(),
      chatInstructionEnabled: enabled,
    });
    onClose();
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal chat-pref-modal" role="dialog" aria-modal="true" aria-label="回答偏好">
        <div className="modal-head">
          <h3>回答偏好</h3>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="row-between" style={{ marginBottom: 8 }}>
            <span className="chat-pref-label">全局回答指令</span>
            <label className="chat-pref-toggle">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span>启用</span>
            </label>
          </div>
          <textarea
            className="chat-pref-textarea"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：我是独立开发者，跳过基础概念直接讲架构权衡；控制在 300 字以内。"
          />
          <div className="chat-pref-chips">
            <span className="muted small">试试：</span>
            {CHAT_STYLE_CHIPS.map((c) => {
              const active = text.includes(c.text);
              return (
                <button
                  key={c.label}
                  type="button"
                  className={`chip sm ${active ? "on" : ""}`}
                  onClick={() => toggleChip(c.text)}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            仅对之后的问答生效，不影响历史回答与左侧导读。
          </p>
          <div className="modal-foot">
            {text.trim() && (
              <button type="button" className="btn ghost sm" onClick={() => setText("")}>
                清空
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn sm" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn sm primary" onClick={handleSave}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function EpisodeOverviewCard({ ep, showEmptyCta = false }: { ep: Episode; showEmptyCta?: boolean }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const guide = useJobs((s) => s.guides[ep.id]);
  const {
    seekToEpisode,
    openSettings,
    getChatProvider,
    isProviderReady,
    chatProviderId,
    chatModel,
    agents,
    verifiedAgents,
    keyStatus,
    providerOverrides,
  } = useStore(
    useShallow((s) => ({
      seekToEpisode: s.seekToEpisode,
      openSettings: s.openSettings,
      getChatProvider: s.getChatProvider,
      isProviderReady: s.isProviderReady,
      chatProviderId: s.chatProviderId,
      chatModel: s.chatModel,
      agents: s.agents,
      verifiedAgents: s.verifiedAgents,
      keyStatus: s.keyStatus,
      providerOverrides: s.providerOverrides,
    })),
  );
  const { guideOpen, put } = useLayout(
    useShallow((l) => ({ guideOpen: l.guideOpen, put: l.put })),
  );

  useEffect(() => {
    void loadEpisodeGuide(ep.id);
  }, [ep.id]);

  const onSeek = useCallback(
    (t: number) => {
      seekToEpisode(ep, t);
    },
    [ep, seekToEpisode],
  );

  const provider = useMemo(
    () => getChatProvider(),
    [getChatProvider, chatProviderId, chatModel, agents, verifiedAgents, providerOverrides],
  );
  const providerReady = isProviderReady(provider);
  void keyStatus;

  const streaming = guide?.streaming ?? null;
  const summary = guide?.summary ?? null;
  const isStreaming = streaming !== null;
  const rawMd = streaming ?? summary ?? "";
  const parsed = useMemo(() => parseGuideMarkdown(rawMd), [rawMd]);

  if (!isStreaming && !summary) {
    if (!showEmptyCta || !transcript) return null;
    return (
      <section className="overview-card is-empty">
        <div className="overview-head is-static">
          <ScrollText size={14} className="muted" />
          <span className="overview-title">内容精炼</span>
          <span className="muted small clamp1">一句话总结与核心要点</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              if (!providerReady) {
                openSettings("ai", provider?.id);
                return;
              }
              void runEpisodeGuide(ep);
            }}
          >
            <Sparkles size={13} />
            <span>{providerReady ? "生成导读与精炼" : "去设置模型"}</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`overview-card ${guideOpen ? "open" : ""}`}>
      <div
        className="overview-head"
        role="button"
        tabIndex={0}
        aria-expanded={guideOpen}
        onClick={() => put({ guideOpen: !guideOpen })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            put({ guideOpen: !guideOpen });
          }
        }}
      >
        <ScrollText size={14} className="muted" />
        <span className="overview-title">内容精炼</span>
        {isStreaming && <Loader2 size={12} className="spin muted" />}
        <span className="spacer" />
        <ChevronDown size={15} className={`muted guide-chev ${guideOpen ? "flip" : ""}`} />
      </div>

      {guideOpen && (
        <div className="overview-body summary">
          {parsed.overviewMd ? (
            <Markdown text={parsed.overviewMd} onSeek={onSeek} />
          ) : isStreaming ? (
            <p className="muted small row-tight">
              <Loader2 size={13} className="spin" /> 正在提炼全片核心内容…
            </p>
          ) : (
            <p className="muted small">暂无精炼摘要，可在右侧查看章节时间线。</p>
          )}
        </div>
      )}
    </section>
  );
}

export function GuideTimelinePanel({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const officialStatus = useJobs((s) => s.officialStatus[ep.id] ?? "idle");
  const officialError = useJobs((s) => s.officialError[ep.id]);
  const asrJob = useJobs((s) => s.asr[ep.id]);
  const guide = useJobs((s) => s.guides[ep.id]);

  const {
    currentId,
    curTime,
    seekToEpisode,
    openSettings,
    setImportOpen,
    getChatProvider,
    isProviderReady,
    asrChoice,
    asrLang,
    asrStatus,
    asrKeyStatus,
    keyStatus,
    savePrefs,
    chatProviderId,
    chatModel,
    agents,
    verifiedAgents,
    providerOverrides,
  } = useStore(
    useShallow((s) => ({
      currentId: s.current?.id,
      curTime: Math.floor(s.time),
      seekToEpisode: s.seekToEpisode,
      openSettings: s.openSettings,
      setImportOpen: s.setImportOpen,
      getChatProvider: s.getChatProvider,
      isProviderReady: s.isProviderReady,
      asrChoice: s.prefs.asrChoice,
      asrLang: s.prefs.asrLang,
      asrStatus: s.asrStatus,
      asrKeyStatus: s.asrKeyStatus,
      keyStatus: s.keyStatus,
      savePrefs: s.savePrefs,
      chatProviderId: s.chatProviderId,
      chatModel: s.chatModel,
      agents: s.agents,
      verifiedAgents: s.verifiedAgents,
      providerOverrides: s.providerOverrides,
    })),
  );

  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const prevActiveRef = useRef(-1);
  const [offscreen, setOffscreen] = useState<"above" | "below" | null>(null);
  const [showAsrOpts, setShowAsrOpts] = useState(false);

  useEffect(() => {
    followRef.current = true;
    prevActiveRef.current = -1;
    void loadEpisodeGuide(ep.id);
  }, [ep.id]);

  const onSeek = useCallback(
    (t: number) => {
      seekToEpisode(ep, t);
    },
    [ep, seekToEpisode],
  );

  const provider = useMemo(
    () => getChatProvider(),
    [getChatProvider, chatProviderId, chatModel, agents, verifiedAgents, providerOverrides],
  );
  const providerReady = isProviderReady(provider);
  const streaming = guide?.streaming ?? null;
  const summary = guide?.summary ?? null;
  const error = guide?.error ?? null;
  const isStreaming = streaming !== null;
  const rawMd = streaming ?? summary ?? "";
  const parsed = useMemo(() => parseGuideMarkdown(rawMd), [rawMd]);
  const timeline = parsed.timeline;

  const activeIdx = useMemo(() => {
    if (currentId !== ep.id || !timeline.length) return -1;
    let hit = -1;
    for (let i = 0; i < timeline.length; i++) {
      if (timeline[i].sec <= curTime + 0.5) hit = i;
      else break;
    }
    return hit;
  }, [currentId, ep.id, curTime, timeline]);

  const checkActiveVisibility = useCallback(() => {
    const wrap = listRef.current;
    if (!wrap) {
      setOffscreen(null);
      return;
    }
    const activeEl = wrap.querySelector<HTMLElement>("[data-gt-active]");
    if (!activeEl) {
      setOffscreen(null);
      return;
    }
    const box = wrap.getBoundingClientRect();
    const rect = activeEl.getBoundingClientRect();
    if (rect.bottom < box.top + 8) {
      setOffscreen("above");
      followRef.current = false;
    } else if (rect.top > box.bottom - 8) {
      setOffscreen("below");
      followRef.current = false;
    } else {
      setOffscreen(null);
      followRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (activeIdx === prevActiveRef.current) return;
    prevActiveRef.current = activeIdx;
    if (activeIdx < 0 || !followRef.current) return;
    listRef.current
      ?.querySelector<HTMLElement>("[data-gt-active]")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);

  useEffect(() => {
    checkActiveVisibility();
  }, [activeIdx, timeline.length, checkActiveVisibility]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => checkActiveVisibility());
    ro.observe(el);
    return () => ro.disconnect();
  }, [checkActiveVisibility, timeline.length, summary]);

  const handleWheel = () => {
    followRef.current = false;
  };

  const transcriptLoading = transcript === undefined || officialStatus === "loading";
  const guideLoading = !!transcript && !guide?.loaded && !summary && !isStreaming;

  if (asrJob?.running) {
    const pct = typeof asrJob.pct === "number" ? Math.round(asrJob.pct * 100) : null;
    return (
      <div className="panel-empty gt-fade-in">
        <CassetteArt mode="listen" />
        <p className="lead">{asrJob.stage || "正在语音转写…"}</p>
        {pct != null && (
          <div className="progress-block">
            <div className="bar">
              <div style={{ width: `${Math.max(3, pct)}%` }} />
            </div>
            <span>{pct}%</span>
          </div>
        )}
        <button type="button" className="btn sm ghost" onClick={() => stopTranscribe(ep.id)}>
          <Square size={12} /> 取消转写
        </button>
      </div>
    );
  }

  if (transcriptLoading) {
    return (
      <div className="gt-panel">
        <div className="gt-skeleton" aria-busy="true" aria-label="正在读取字幕与导读">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="gt-sk-row">
              <div className="gt-sk-rail">
                <span className="gt-sk-dot" />
                <span className="gt-sk-line" />
              </div>
              <div className="gt-sk-card">
                <div className="sk sk-line sm" style={{ width: "38%" }} />
                <div className="sk sk-line" style={{ width: i % 2 === 0 ? "92%" : "78%" }} />
                <div className="sk sk-line" style={{ width: "64%" }} />
              </div>
            </div>
          ))}
          <p className="muted small gt-sk-hint">正在读取字幕与导读…</p>
        </div>
      </div>
    );
  }

  if (!transcript) {
    if (officialStatus === "searching") {
      return (
        <div className="panel-empty gt-fade-in">
          <Loader2 size={24} className="spin muted" />
          <p className="lead">正在获取官方字幕…</p>
          <p className="muted small">拿到字幕后即可生成精炼梳理与章节导读</p>
        </div>
      );
    }

    const hasMedia = !!(ep.audioUrl || ep.videoId);
    const isCloud = asrChoice.startsWith("cloud:");
    const cloudPreset = isCloud ? CLOUD_ASR_PRESETS.find((p) => p.id === asrChoice.slice(6)) : undefined;
    const localReady = !!(asrStatus?.engineReady && asrStatus?.modelReady);
    const cloudReady =
      !cloudPreset ||
      !cloudPreset.needsKey ||
      !!asrKeyStatus[cloudPreset.id] ||
      (cloudPreset.id === "deepseek" && !!keyStatus.deepseek);

    return (
      <div className="panel-empty gt-fade-in">
        <div className="gen-card">
          <WaveToTextArt />
          <h3 className="gen-title">这一集还没有字幕</h3>
          <p className="muted small">
            {isCloud
              ? `使用「${cloudPreset?.name ?? "云端 ASR"}」转写，拿到文字稿后即可生成导读与问答。`
              : "先通过本机离线转写或导入字幕拿到文字稿，即可生成精炼导读与随时问答。"}
          </p>
          {officialError && <p className="error-text small">官方字幕读取失败：{officialError}</p>}
          {asrJob?.error && (
            <div className="setup-note">
              <span>{asrJob.error}</span>
              <button type="button" className="btn sm primary" onClick={() => openSettings("asr")}>
                去设置
              </button>
            </div>
          )}
          <div className="row-actions center" style={{ marginTop: 6 }}>
            {hasMedia && (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  if ((!isCloud && !localReady) || (isCloud && !cloudReady)) {
                    openSettings("asr");
                    return;
                  }
                  void runTranscribe(ep);
                }}
              >
                <Mic size={15} />
                <span>
                  {!isCloud && !localReady
                    ? "去下载离线 Qwen3-ASR"
                    : isCloud && !cloudReady
                      ? "去填写云端 ASR Key"
                      : "语音转写生成字幕"}
                </span>
              </button>
            )}
            {(ep.videoId || ep.transcriptUrl) && (
              <button type="button" className="btn" onClick={() => void fetchOfficialSub(ep, false)}>
                <RefreshCw size={14} /> 重试官方字幕
              </button>
            )}
            <button type="button" className="btn ghost" onClick={() => setImportOpen(true)}>
              导入字幕 / 文稿
            </button>
          </div>
          {hasMedia && (
            <>
              <button type="button" className="link-btn" onClick={() => setShowAsrOpts((v) => !v)}>
                <span>识别引擎与语言设置</span>
                <ChevronDown size={13} className={showAsrOpts ? "flip" : ""} />
              </button>
              {showAsrOpts && (
                <div className="gen-options">
                  <label>
                    <span>识别引擎</span>
                    <select value={asrChoice} onChange={(e) => savePrefs({ asrChoice: e.target.value })}>
                      <option value="qwen3">本机 Qwen3-ASR 0.6B（{localReady ? "已就绪" : "需下载"}）</option>
                      {CLOUD_ASR_PRESETS.map((p) => (
                        <option key={p.id} value={`cloud:${p.id}`}>
                          云端 · {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>音频语言</span>
                    <select value={asrLang} onChange={(e) => savePrefs({ asrLang: e.target.value })}>
                      <option value="auto">自动识别</option>
                      <option value="zh">中文</option>
                      <option value="en">英文</option>
                      <option value="ja">日文</option>
                    </select>
                  </label>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  if (guideLoading) {
    return (
      <div className="gt-panel">
        <div className="gt-skeleton" aria-busy="true" aria-label="正在加载导读">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="gt-sk-row">
              <div className="gt-sk-rail">
                <span className="gt-sk-dot" />
                <span className="gt-sk-line" />
              </div>
              <div className="gt-sk-card">
                <div className="sk sk-line sm" style={{ width: "38%" }} />
                <div className="sk sk-line" style={{ width: i % 2 === 0 ? "92%" : "78%" }} />
                <div className="sk sk-line" style={{ width: "64%" }} />
              </div>
            </div>
          ))}
          <p className="muted small gt-sk-hint">正在读取已保存的导读…</p>
        </div>
      </div>
    );
  }

  if (!summary && !isStreaming) {
    const modelLabel = provider
      ? `${provider.name}${provider.model ? ` · ${shortModelName(provider.model)}` : ""}`
      : "未配置";
    return (
      <div className="panel-empty gt-fade-in">
        <div className="gt-empty">
          <PageArt />
          <h3 className="gen-title">为这期生成导读与梳理</h3>
          <p className="muted small">
            一次通读全片文字稿（共 {transcript.segments.length} 段），左侧生成全内容精炼梳理，此处生成随播放推进的章节时间线。
          </p>
          {error && (
            <div className="setup-note">
              <span>{error}</span>
              <button type="button" className="btn sm primary" onClick={() => openSettings("ai", provider?.id)}>
                去设置
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              if (!providerReady) {
                openSettings("ai", provider?.id);
                return;
              }
              void runEpisodeGuide(ep);
            }}
          >
            <Sparkles size={15} />
            <span>{providerReady ? "生成导读与梳理" : "去设置验证模型"}</span>
          </button>
          <p className="gt-model-hint">
            当前模型：{modelLabel}
            {!providerReady ? "（尚未验证可用）" : ""}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="gt-panel">
      <div className="gt-scroll-wrap">
        <div className="gt-scroll notranslate" translate="no" ref={listRef} onScroll={checkActiveVisibility} onWheel={handleWheel}>
          {timeline.length > 0 ? (
            <div className="gt-list gt-fade-in">
              {timeline.map((item, idx) => {
                const active = idx === activeIdx;
                const isPast = activeIdx > idx;
                return (
                  <div
                    key={`${item.stamp}-${idx}`}
                    className={`gt-item ${active ? "active" : isPast ? "is-past" : "is-future"}`}
                    data-gt-active={active || undefined}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      followRef.current = true;
                      onSeek(item.sec);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        followRef.current = true;
                        onSeek(item.sec);
                      }
                    }}
                  >
                    <span className="gt-rail" aria-hidden="true">
                      <span className="gt-line-top" />
                      <span className="gt-dot" />
                      <span className="gt-line-bot" />
                    </span>
                    <div className="gt-card">
                      <div className="gt-item-head">
                        <span className="stamp">{item.stamp}</span>
                        <span className="gt-item-title">{item.title}</span>
                      </div>
                      {item.body && <p className="gt-item-body">{item.body}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : parsed.timelineRaw || rawMd ? (
            <div className="summary">
              <Markdown text={parsed.timelineRaw || rawMd} onSeek={onSeek} />
            </div>
          ) : (
            <p className="muted row-tight">
              <Loader2 size={14} className="spin" /> 正在通读整集文字稿并生成导读与时间线…
            </p>
          )}

          {error && (
            <p className="error-text small" style={{ marginTop: 10 }}>
              {error}
            </p>
          )}
        </div>

        {offscreen !== null && activeIdx >= 0 && (
          <button
            type="button"
            className="follow-pill"
            onClick={() => {
              followRef.current = true;
              setOffscreen(null);
              listRef.current
                ?.querySelector<HTMLElement>("[data-gt-active]")
                ?.scrollIntoView({ block: "center", behavior: "smooth" });
            }}
          >
            {offscreen === "above" ? <ArrowUp size={13} /> : <ArrowDown size={13} />} 回到当前章节
          </button>
        )}
      </div>

      <div className="gt-foot">
        {isStreaming ? (
          <>
            <span className="muted small row-tight">
              <Loader2 size={12} className="spin" /> 正在生成中…
            </span>
            <span className="spacer" />
            <button type="button" className="btn sm ghost" onClick={() => stopEpisodeGuide(ep.id)}>
              <Square size={11} /> 停止
            </button>
          </>
        ) : summary ? (
          <>
            <span className="gt-progress">
              {timeline.length > 0
                ? activeIdx >= 0
                  ? `${activeIdx + 1} / ${timeline.length} 章`
                  : `共 ${timeline.length} 章`
                : "已保存"}
            </span>
            <span className="spacer" />
            {(Boolean(error) || timeline.length === 0) && (
              <button
                type="button"
                className="btn sm ghost gt-foot-btn gt-regen-btn"
                title="重新生成导读"
                aria-label="重新生成导读"
                onClick={() => void runEpisodeGuide(ep)}
              >
                <RefreshCw size={13} />
                <span className="gt-btn-label">重新生成</span>
              </button>
            )}
            <button
              type="button"
              className="btn sm gt-foot-btn"
              title="复制导读 Markdown"
              aria-label="复制导读"
              onClick={() => void copyTextSafe(formatAnswerCopy(summary, "markdown", ep))}
            >
              <Copy size={13} />
              <span className="gt-btn-label">复制</span>
            </button>
            <button
              type="button"
              className="btn sm gt-foot-btn"
              title="导出导读 .md 文件"
              aria-label="导出导读"
              onClick={() => {
                downloadTextFile(
                  safeFileName(`${ep.title}-导读`, "md"),
                  formatAnswerCopy(summary, "markdown", ep),
                );
                useStore.getState().notify("已导出导读 .md 文件");
              }}
            >
              <Download size={13} />
              <span className="gt-btn-label">导出</span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function ChatPanel({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const chatJob = useJobs((s) => s.chats[ep.id]);
  const draftAsk = useJobs((s) => s.draftAsk);
  const {
    currentId,
    playbackTime,
    seekToEpisode,
    openSettings,
    getChatProvider,
    isProviderReady,
    chatInstruction,
    chatInstructionEnabled,
  } = useStore(
    useShallow((s) => ({
      currentId: s.current?.id,
      playbackTime: s.time,
      seekToEpisode: s.seekToEpisode,
      openSettings: s.openSettings,
      getChatProvider: s.getChatProvider,
      isProviderReady: s.isProviderReady,
      chatProviderId: s.chatProviderId,
      chatModel: s.chatModel,
      agents: s.agents,
      verifiedAgents: s.verifiedAgents,
      keyStatus: s.keyStatus,
      providerOverrides: s.providerOverrides,
      chatInstruction: s.prefs.chatInstruction,
      chatInstructionEnabled: s.prefs.chatInstructionEnabled,
    })),
  );

  const [input, setInput] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void loadEpisodeChat(ep.id);
  }, [ep.id]);

  useEffect(() => {
    if (!draftAsk || draftAsk.episodeId !== ep.id) return;
    setInput(draftAsk.text);
    useJobs.setState({ draftAsk: null });
    window.setTimeout(() => boxRef.current?.focus(), 0);
  }, [draftAsk, ep.id]);

  const messages = chatJob?.messages ?? [];
  const archive = chatJob?.archive ?? [];
  const streaming = chatJob?.streaming ?? null;
  const chatError = chatJob?.error ?? null;
  const isBusy = streaming !== null;

  useEffect(() => {
    if (atBottom) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages.length, streaming, atBottom]);

  const onSeek = useCallback(
    (t: number) => {
      seekToEpisode(ep, t);
    },
    [ep, seekToEpisode],
  );

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 64);
  };

  const toBottom = () => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    setAtBottom(true);
  };

  const send = (text: string) => {
    const q = text.trim();
    if (!q || isBusy) return;
    setInput("");
    setAtBottom(true);
    void sendChatAsk(ep, [...messages, { role: "user", content: q }]);
  };

  const pairStart = (i: number) =>
    messages[i]?.role === "assistant" && messages[i - 1]?.role === "user" ? i - 1 : i;

  const removePair = (i: number) => {
    const a = pairStart(i);
    const b = messages[a + 1]?.role === "assistant" ? a + 2 : a + 1;
    void saveEpisodeChat(ep.id, [...messages.slice(0, a), ...messages.slice(b)]);
  };

  const retryLast = () => {
    const i = messages.length - 1;
    if (messages[i]?.role === "assistant" && !isBusy) {
      void sendChatAsk(ep, messages.slice(0, i));
    }
  };

  const editQuestion = (i: number) => {
    setInput(messages[i].content);
    void saveEpisodeChat(ep.id, messages.slice(0, i));
    window.setTimeout(() => boxRef.current?.focus(), 0);
  };

  const startNewChat = () => {
    if (!messages.length || isBusy) return;
    const archived: ArchivedChat = { id: `${Date.now()}`, at: Date.now(), messages };
    void saveEpisodeChatArchive(ep.id, [archived, ...archive].slice(0, 30));
    void saveEpisodeChat(ep.id, []);
    setInput("");
    boxRef.current?.focus();
    useStore.getState().notify("旧对话已存入本集历史，已开启新对话");
  };

  const restoreArchive = (id: string) => {
    const hit = archive.find((c) => c.id === id);
    if (!hit) return;
    const rest = archive.filter((c) => c.id !== id);
    const nextArch = messages.length ? [{ id: `${Date.now()}`, at: Date.now(), messages }, ...rest] : rest;
    void saveEpisodeChatArchive(ep.id, nextArch);
    void saveEpisodeChat(ep.id, hit.messages);
  };

  const deleteArchive = (id: string) => {
    void ask({ title: "删除这段历史对话？", ok: "删除", danger: true }).then((yes) => {
      if (yes) void saveEpisodeChatArchive(ep.id, archive.filter((c) => c.id !== id));
    });
  };

  const provider = getChatProvider();
  const ready = isProviderReady(provider);
  const blocked = !transcript || !ready;
  const starterPrompts = useMemo(
    () =>
      STARTER_PROMPT_IDS.map((id) => QUICK_PROMPTS.find((p) => p.id === id)).filter(
        (p): p is (typeof QUICK_PROMPTS)[number] => Boolean(p),
      ),
    [],
  );
  const hasCustomPref = Boolean(chatInstructionEnabled && chatInstruction.trim());
  const posSec = currentId === ep.id ? playbackTime : ep.progress;

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollerRef} onScroll={handleScroll}>
        {!messages.length && streaming === null && (
          <div className="chat-intro">
            <div className="intro-head">
              <AskArt />
              <div>
                <p className="lead">围绕这一集随时发问</p>
                <p className="muted small">回答严格依据文字稿并附可点击 [mm:ss] 时间戳，也可在左侧划词一键追问。</p>
              </div>
            </div>

            {!transcript && <p className="setup-note">先获取或生成字幕后，即可开始提问。</p>}

            {!ready && (
              <div className="setup-note">
                <span>
                  {provider?.protocol === "cli"
                    ? `本机 AI「${provider.name}」尚未验证可用，去设置一键验证或切换其他模型。`
                    : `当前所选模型「${provider?.name ?? "未配置"}」尚未填写 API Key。`}
                </span>
                <button type="button" className="btn sm primary" onClick={() => openSettings("ai", provider?.id)}>
                  去设置
                </button>
              </div>
            )}

            <div className="starter-list">
              {starterPrompts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="starter-pill"
                  title={p.body}
                  disabled={blocked || isBusy}
                  onClick={() => {
                    countPromptUse(p.id);
                    send(p.body);
                  }}
                >
                  <span>{p.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg-wrap user">
              <div className="msg user">
                <p>{m.content}</p>
              </div>
              {!isBusy && (
                <div className="msg-actions user">
                  <button type="button" className="msg-act" title="复制" onClick={() => void copyTextSafe(m.content)}>
                    <Copy size={13} />
                  </button>
                  <button type="button" className="msg-act" title="编辑后重问" onClick={() => editQuestion(i)}>
                    <Pencil size={13} />
                  </button>
                  <button type="button" className="msg-act" title="删除这一问一答" onClick={() => removePair(i)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div key={i} className="msg-wrap assistant">
              <div className="msg assistant">
                <Markdown text={m.content} onSeek={onSeek} />
              </div>
              {!isBusy && (
                <div className="msg-actions">
                  <CopyMenu text={m.content} ep={ep} />
                  {i === messages.length - 1 && !blocked && (
                    <button type="button" className="msg-act" title="重新回答" onClick={retryLast}>
                      <RefreshCw size={13} />
                    </button>
                  )}
                  <button type="button" className="msg-act" title="删除这一问一答" onClick={() => removePair(i)}>
                    <Trash2 size={13} />
                  </button>
                  {m.model && <span className="msg-model">{m.model}</span>}
                </div>
              )}
            </div>
          ),
        )}

        {streaming !== null && (
          <div className="msg-wrap assistant">
            <div className="msg assistant">
              {streaming ? (
                <Markdown text={streaming} onSeek={onSeek} />
              ) : (
                <p className="muted row-tight">
                  <Loader2 size={14} className="spin" /> 正在阅读文字稿并组织回答...
                </p>
              )}
            </div>
          </div>
        )}

        {chatError && (
          <div className="setup-note">
            <span>{chatError}</span>
            <button type="button" className="btn sm primary" onClick={() => openSettings("ai")}>
              去设置
            </button>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {!atBottom && (messages.length > 0 || streaming !== null) && (
        <button type="button" className="to-bottom" title="回到底部" onClick={toBottom}>
          <ArrowDown size={15} />
        </button>
      )}

      {posSec > 3 && transcript && (
        <div className="presence-bar">
          <Clock size={12} />
          <span>当前播放位置 [{clock(posSec)}] · AI 已感知上下文</span>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) boxRef.current?.focus();
        }}
      >
        <textarea
          ref={boxRef}
          value={input}
          rows={1}
          disabled={!transcript || isBusy}
          placeholder={
            !transcript
              ? "拿到文字稿后即可提问..."
              : !ready
                ? "请先在左下角切换或配置可用模型..."
                : "问点什么，Enter 发送，Shift+Enter 换行"
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <div className="composer-bar">
          <ModelPicker disabled={isBusy} />
          <PromptMenu
            disabled={blocked || isBusy}
            onPick={(id, body) => {
              countPromptUse(id);
              send(body);
            }}
          />
          <button
            type="button"
            className={`icon-btn sm pref-btn ${hasCustomPref ? "is-active" : ""}`}
            title={hasCustomPref ? "回答偏好（已启用自定义指令）" : "回答偏好"}
            aria-label="回答偏好"
            onClick={() => setPrefsOpen(true)}
          >
            <SlidersHorizontal size={14} />
            {hasCustomPref && <span className="pref-dot" aria-hidden="true" />}
          </button>
          <span className="spacer" />
          <HistoryMenu
            archive={archive}
            ep={ep}
            current={messages}
            onRestore={restoreArchive}
            onDelete={deleteArchive}
          />
          {messages.length > 0 && !isBusy && (
            <button
              type="button"
              className="btn ghost sm new-chat"
              title="归档当前对话并开启新对话"
              onClick={startNewChat}
            >
              <SquarePen size={13} /> 新对话
            </button>
          )}
          {isBusy ? (
            <button type="button" className="send stop" title="停止回答" onClick={() => stopChatAsk(ep.id)}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              className="send"
              title="发送"
              disabled={!input.trim() || blocked}
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </form>
      <ChatPrefsModal open={prefsOpen} onClose={() => setPrefsOpen(false)} />
    </div>
  );
}
