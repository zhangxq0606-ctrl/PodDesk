import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { ProviderConfig } from "../../lib/api";
import { useStore } from "../../store";

export function shortModelName(m: string): string {
  return m.split("/").pop() || m;
}

export function ModelPicker({ disabled }: { disabled?: boolean }) {
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
