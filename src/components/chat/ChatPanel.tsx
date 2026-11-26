import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Clock, Copy, Pencil, RefreshCw, SlidersHorizontal, Square, SquarePen, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { countPromptUse, QUICK_PROMPTS, STARTER_PROMPT_IDS } from "../../lib/ai";
import type { Episode } from "../../lib/api";
import { api } from "../../lib/api";
import { ask } from "../../lib/confirm";
import { clock } from "../../lib/format";
import { isBilibiliEpisode } from "../../lib/videoSource";
import {
  loadEpisodeChat,
  saveEpisodeChat,
  saveEpisodeChatArchive,
  sendChatAsk,
  stopChatAsk,
  useJobs,
  type ArchivedChat,
} from "../../lib/jobs";
import { useStore } from "../../store";
import { AskArt } from "../Illustrations";
import { Markdown } from "../Markdown";
import { ChatPrefsModal } from "./ChatPrefsModal";
import { CopyMenu, copyTextSafe } from "./CopyMenu";
import { HistoryMenu } from "./HistoryMenu";
import { ModelPicker } from "./ModelPicker";
import { PromptMenu } from "./PromptMenu";

export function ThinkingHint({
  thinking,
  startedAt,
  idleText,
}: {
  thinking?: boolean;
  startedAt?: number;
  idleText: string;
}) {
  const [secs, setSecs] = useState(() => (startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0));

  useEffect(() => {
    if (!startedAt) {
      setSecs(0);
      return;
    }
    setSecs(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    const timer = window.setInterval(() => {
      setSecs(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (thinking) {
    return <span className="thinking-shine">{secs >= 2 ? `正在深度思考（已 ${secs} 秒）…` : "正在深度思考…"}</span>;
  }
  const cleanIdle = idleText.replace(/…$/, "");
  return <span className="thinking-shine">{secs >= 4 ? `${cleanIdle}（已 ${secs} 秒）…` : idleText}</span>;
}

const PresenceBar = memo(function PresenceBar({
  epId,
  fallbackSec,
  enabled,
  onToggle,
}: {
  epId: string;
  fallbackSec: number;
  enabled: boolean;
  onToggle: () => void;
}) {
  const { posSec, isPlaying } = useStore(
    useShallow((s) => ({
      posSec: s.current?.id === epId ? Math.floor(s.time) : Math.floor(fallbackSec),
      isPlaying: s.current?.id === epId && s.playing,
    })),
  );
  if (posSec <= 3) return null;
  return (
    <button
      type="button"
      className={`presence-bar ${enabled ? (isPlaying ? "is-live" : "") : "is-paused"}`}
      title={enabled ? "点击本次暂停跟随播放位置（适合聊整期话题）" : "点击恢复感知当前播放位置"}
      aria-pressed={enabled}
      onClick={onToggle}
    >
      <Clock size={12} />
      <span>
        {enabled ? `当前播放位置 [${clock(posSec)}] · AI 已感知上下文` : `已暂停跟随 [${clock(posSec)}] · 点击恢复`}
      </span>
    </button>
  );
});

export function ChatPanel({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const officialError = useJobs((s) => s.officialError[ep.id]);
  const chatJob = useJobs((s) => s.chats[ep.id]);
  const draftAsk = useJobs((s) => s.draftAsk);
  const {
    health,
    notify,
    seekToEpisode,
    openSettings,
    getChatProvider,
    isProviderReady,
    chatInstruction,
    chatInstructionEnabled,
  } = useStore(
    useShallow((s) => ({
      health: s.health,
      notify: s.notify,
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
  const [followPlayback, setFollowPlayback] = useState(true);
  const [copiedUserIdx, setCopiedUserIdx] = useState<number | null>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  useEffect(() => {
    setCopiedUserIdx(null);
    setFollowPlayback(true);
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

  const send = (text: string, opts?: { skipPresence?: boolean }) => {
    const q = text.trim();
    if (!q || isBusy) return;
    setInput("");
    setAtBottom(true);
    void sendChatAsk(ep, [...messages, { role: "user", content: q }], {
      followPlayback,
      skipPresence: opts?.skipPresence,
    });
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

            {!transcript &&
              (isBilibiliEpisode(ep) && /登录后|扫码登录/i.test(officialError ?? "") ? (
                <div className="setup-note">
                  <span>未登录 B站暂无法读取官方或 AI 字幕，登录后可自动获取。</span>
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => {
                      if (health?.biliLoginSupported) {
                        void api.openBilibiliLogin().catch((err) => {
                          notify(err instanceof Error ? err.message : "打开 B站登录窗口失败", false);
                        });
                      } else {
                        openSettings("network");
                      }
                    }}
                  >
                    {health?.biliLoginSupported ? "扫码登录 B站" : "去设置 Cookie"}
                  </button>
                </div>
              ) : (
                <p className="setup-note">先获取或生成字幕后，即可开始提问。</p>
              ))}

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
                    send(p.body, { skipPresence: true });
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
                  <button
                    type="button"
                    className={`msg-act ${copiedUserIdx === i ? "is-done" : ""}`}
                    title="复制"
                    onClick={() => {
                      void copyTextSafe(m.content);
                      setCopiedUserIdx(i);
                      window.clearTimeout(copyTimerRef.current);
                      copyTimerRef.current = window.setTimeout(() => setCopiedUserIdx(null), 1400);
                    }}
                  >
                    {copiedUserIdx === i ? <Check size={13} className="check-draw-icon" /> : <Copy size={13} />}
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
            <div className={`msg assistant ${streaming ? "is-streaming" : ""}`}>
              {streaming ? (
                <Markdown text={streaming} onSeek={onSeek} />
              ) : (
                <p className="muted row-tight">
                  <ThinkingHint
                    thinking={chatJob?.thinking}
                    startedAt={chatJob?.startedAt}
                    idleText="正在阅读文字稿并组织回答…"
                  />
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

      {transcript && (
        <PresenceBar
          epId={ep.id}
          fallbackSec={ep.progress}
          enabled={followPlayback}
          onToggle={() => setFollowPlayback((v) => !v)}
        />
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
              send(body, { skipPresence: true });
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
