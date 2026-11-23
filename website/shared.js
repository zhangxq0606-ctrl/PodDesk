/* PodDesk 介绍页共享：60fps 丝滑播控 + 三态点亮时间轴 + 真实双边界拖拽调宽 + 人机对话 */
window.PD = (function () {
  const LINES = [
    { t: '38:42', en: 'We have built an entire culture around getting to the point faster.', zh: '我们已经形成了一种文化：一切都为了更快抵达结论。' },
    { t: '40:54', en: 'But the summary is where someone else decides what mattered.', zh: '但摘要意味着，由别人替你决定什么才重要。' },
    { t: '42:18', en: 'The moment you stop summarizing and start asking questions, listening becomes a different activity.', zh: '当你不再急着总结，而是开始追问，收听就成了一件完全不同的事。' },
    { t: '43:36', en: 'You are no longer consuming the episode. You are thinking alongside it.', zh: '你不再只是消费一期节目，而是在与它一起思考。' },
    { t: '45:42', en: 'The best note is often not an answer. It is a better question you can return to.', zh: '最好的笔记常常不是一个答案，而是一个可以反复回来的、更好的问题。' },
  ];

  const THEMES = {
    'graphite-desk':  { n: '石墨仪器', m: 'dark', bg:'#12151a', panel:'#181c22', card:'#1f242b', text:'#e8eaee', t2:'#c3c8d0', muted:'#99a1ad', line:'#2b313a', acc:'#4fb3c2', at:'#6cc6d4' },
    'darkroom-carbon':{ n: '暗室黑曜', m: 'dark', bg:'#0c0d0f', panel:'#131416', card:'#1a1b1e', text:'#ecebe7', t2:'#c4c3be', muted:'#9a9993', line:'#26282c', acc:'#d6a856', at:'#e0b86d' },
    'studio-slate':   { n: '冷灰控台', m: 'dark', bg:'#181a1e', panel:'#1f2227', card:'#262a30', text:'#e9ebef', t2:'#c4c8cf', muted:'#9aa0ab', line:'#31353c', acc:'#7b9cff', at:'#9db6ff' },
    'warm-charcoal':  { n: '净炭书房', m: 'dark', bg:'#131312', panel:'#1a1a18', card:'#222220', text:'#ece9e4', t2:'#c6c2bb', muted:'#9c978f', line:'#2d2c29', acc:'#ea8a5c', at:'#f2a07a' },
  };

  function applyTheme(id, opts) {
    const T = THEMES[id]; if (!T) return;
    const r = document.documentElement.style;
    ['bg','panel','card','text','line','muted'].forEach(k => r.setProperty('--' + k, T[k]));
    r.setProperty('--text2', T.t2); r.setProperty('--acc', T.acc); r.setProperty('--acc-text', T.at);
    document.documentElement.dataset.mode = T.m; document.documentElement.dataset.palette = id;
    if (opts && opts.persist) { try { localStorage.setItem('pd-site-theme', id); } catch (e) {} }
  }

  function applyThemeTo(el, id) {
    const T = THEMES[id]; if (!T || !el) return;
    const r = el.style;
    ['bg','panel','card','text','line','muted'].forEach(k => r.setProperty('--' + k, T[k]));
    r.setProperty('--text2', T.t2); r.setProperty('--acc', T.acc); r.setProperty('--acc-text', T.at);
    el.dataset.mode = T.m; el.dataset.palette = id;
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  /* 三列实机交互器：60fps 连续进度条 + 三态点亮时间轴 + 双边界丝滑拖拽 + 真实人机对话 */
  function win(el, opts) {
    opts = opts || {};
    const bodyEl = el.querySelector('.w-body');
    const rows = [...el.querySelectorAll('.ln')];
    const range = el.querySelector('[data-w-range]');
    const cur = el.querySelector('.cur-t');
    const play = el.querySelector('.play'), backBtn = el.querySelector('[data-back-btn]'), speedBtn = el.querySelector('[data-speed-btn]');
    const langBtns = [...el.querySelectorAll('[data-lang-opt]')];
    const agentSel = el.querySelector('[data-agent-sel]');
    const stream = el.querySelector('.chat-stream');
    const askForm = el.querySelector('.composer-box'), askInput = askForm && askForm.querySelector('input');
    const dlBtns = [...el.querySelectorAll('[data-md-dl]')];

    const SEC_PER_LINE = 2.8;
    const SPEEDS = [1, 1.5, 2];
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let playPos = 2.0;
    let lastIdx = -1;
    let speedIdx = 0;
    let running = true;
    let visible = true;
    let draggingRange = false;
    let lastTs = performance.now();

    function syncRowHighlight(idx) {
      if (idx === lastIdx) return;
      lastIdx = idx;
      rows.forEach((r, i) => { r.dataset.s = i < idx ? 'past' : i === idx ? 'now' : 'next'; });
      if (cur) cur.textContent = LINES[idx].t;
      el.querySelectorAll('[data-live]').forEach(n => n.classList.toggle('hit', +n.dataset.live === idx));
    }

    function syncProgressBar() {
      const pct = Math.min(100, Math.max(0, (playPos / LINES.length) * 100));
      if (range && !draggingRange) {
        range.value = String(Math.round(pct * 10));
        range.style.setProperty('--p', pct.toFixed(2) + '%');
      }
    }

    function go(i) {
      const target = ((i % LINES.length) + LINES.length) % LINES.length;
      playPos = target;
      syncRowHighlight(target);
      syncProgressBar();
    }

    function rafLoop(now) {
      const dt = Math.min(0.05, Math.max(0, (now - lastTs) / 1000));
      lastTs = now;
      if (running && visible && !draggingRange && !reduce) {
        playPos = (playPos + (dt * SPEEDS[speedIdx]) / SEC_PER_LINE) % LINES.length;
        syncRowHighlight(Math.min(LINES.length - 1, Math.floor(playPos)));
        syncProgressBar();
      }
      requestAnimationFrame(rafLoop);
    }
    syncRowHighlight(2);
    syncProgressBar();
    requestAnimationFrame(rafLoop);

    /* ===== 三列双边界丝滑拖拽（setPointerCapture + rAF 零滞后，双击复位，键盘微调） ===== */
    if (bodyEl) {
      const DEF_LEFT = 244, DEF_RIGHT = 460;
      const MIN_LEFT = 196, MAX_LEFT = 320;
      const MIN_RIGHT = 310, MAX_RIGHT = 580;
      const MIN_MID = 300;
      let leftW = DEF_LEFT, rightW = DEF_RIGHT;

      function applyCols() {
        bodyEl.style.setProperty('--w-left', Math.round(leftW) + 'px');
        bodyEl.style.setProperty('--w-right', Math.round(rightW) + 'px');
      }

      function resetCol(which) {
        bodyEl.classList.add('snap-reset');
        if (which === 'left') leftW = DEF_LEFT;
        else rightW = DEF_RIGHT;
        applyCols();
        setTimeout(() => bodyEl.classList.remove('snap-reset'), 280);
      }

      el.querySelectorAll('.w-split').forEach(split => {
        const side = split.dataset.split; // 'left' | 'right'
        let activeId = null, startX = 0, startW = 0, pendingX = null, rafId = 0;

        function commit() {
          rafId = 0;
          if (pendingX === null) return;
          const totalW = bodyEl.clientWidth;
          const dx = pendingX - startX;
          if (side === 'left') {
            const maxAllowed = Math.min(MAX_LEFT, Math.max(MIN_LEFT, totalW - rightW - MIN_MID));
            leftW = Math.min(maxAllowed, Math.max(MIN_LEFT, startW + dx));
          } else {
            const maxAllowed = Math.min(MAX_RIGHT, Math.max(MIN_RIGHT, totalW - leftW - MIN_MID));
            rightW = Math.min(maxAllowed, Math.max(MIN_RIGHT, startW - dx));
          }
          applyCols();
        }

        function stopDrag() {
          if (activeId === null) return;
          activeId = null;
          pendingX = null;
          if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
          split.classList.remove('active');
          document.body.classList.remove('resizing');
        }

        split.addEventListener('pointerdown', e => {
          if (e.button !== 0) return;
          e.preventDefault();
          bodyEl.classList.remove('snap-reset');
          // 同步当前实际渲染列宽（兼容响应式初始值）
          const railEl = el.querySelector('.w-rail'), sideEl = el.querySelector('.w-side');
          if (railEl) leftW = railEl.getBoundingClientRect().width;
          if (sideEl) rightW = sideEl.getBoundingClientRect().width;

          activeId = e.pointerId;
          startX = e.clientX;
          startW = side === 'left' ? leftW : rightW;
          split.setPointerCapture(e.pointerId);
          split.classList.add('active');
          document.body.classList.add('resizing');
        });

        split.addEventListener('pointermove', e => {
          if (e.pointerId !== activeId) return;
          pendingX = e.clientX;
          if (!rafId) rafId = requestAnimationFrame(commit);
        });

        split.addEventListener('pointerup', stopDrag);
        split.addEventListener('pointercancel', stopDrag);
        split.addEventListener('lostpointercapture', stopDrag);
        split.addEventListener('dblclick', () => resetCol(side));

        split.addEventListener('keydown', e => {
          const step = e.shiftKey ? 32 : 16;
          if (e.key === 'Home') { e.preventDefault(); resetCol(side); return; }
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const totalW = bodyEl.clientWidth;
          const delta = e.key === 'ArrowRight' ? step : -step;
          if (side === 'left') {
            const maxAllowed = Math.min(MAX_LEFT, Math.max(MIN_LEFT, totalW - rightW - MIN_MID));
            leftW = Math.min(maxAllowed, Math.max(MIN_LEFT, leftW + delta));
          } else {
            const maxAllowed = Math.min(MAX_RIGHT, Math.max(MIN_RIGHT, totalW - leftW - MIN_MID));
            rightW = Math.min(maxAllowed, Math.max(MIN_RIGHT, rightW - delta));
          }
          applyCols();
        });
      });
    }

    if (range) {
      range.addEventListener('pointerdown', () => { draggingRange = true; });
      const endDrag = () => { draggingRange = false; };
      range.addEventListener('pointerup', endDrag);
      range.addEventListener('pointercancel', endDrag);
      range.addEventListener('blur', endDrag);
      range.addEventListener('input', () => {
        const ratio = Number(range.value) / 1000;
        range.style.setProperty('--p', (ratio * 100).toFixed(2) + '%');
        playPos = Math.min(LINES.length - 0.001, Math.max(0, ratio * LINES.length));
        syncRowHighlight(Math.min(LINES.length - 1, Math.floor(playPos)));
      });
    }

    if (backBtn) backBtn.addEventListener('click', () => go(lastIdx - 1));

    rows.forEach((r, i) => {
      r.addEventListener('click', () => go(i));
      r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(i); } });
    });

    el.addEventListener('click', e => {
      const seekBtn = e.target.closest('[data-seek]');
      if (seekBtn && el.contains(seekBtn)) { go(+seekBtn.dataset.seek); }
    });

    if (play) play.addEventListener('click', () => {
      running = !running;
      play.dataset.on = running ? '1' : '0';
      play.setAttribute('aria-label', running ? '暂停' : '播放');
    });

    if (speedBtn) speedBtn.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      speedBtn.textContent = `${SPEEDS[speedIdx]}×`;
    });

    langBtns.forEach(btn => btn.addEventListener('click', () => {
      el.dataset.lang = btn.dataset.langOpt;
      langBtns.forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
    }));

    if (agentSel) {
      agentSel.addEventListener('change', () => {
        el.querySelectorAll('[data-agent-name]').forEach(n => { n.textContent = agentSel.value; });
      });
    }

    if (askForm && askInput && stream) {
      askForm.addEventListener('submit', e => {
        e.preventDefault();
        const text = askInput.value.trim();
        if (!text) { askInput.focus(); return; }
        const curIdx = Math.max(0, lastIdx);
        const curLine = LINES[curIdx];
        const modelName = agentSel ? agentSel.value : 'Codex';

        const turn = document.createElement('div');
        turn.className = 'chat-turn';
        turn.innerHTML = `<div class="msg-u">${escHtml(text)}</div><div class="msg-a"><div class="msg-a-tag"><i></i><span data-agent-name>${escHtml(modelName)}</span></div><p>回到你正在听的这一句，讲者的意思是：<b>「${escHtml(curLine.zh)}」</b> <button type="button" class="a-chip hit" data-live="${curIdx}" data-seek="${curIdx}">${curLine.t}</button>。实际使用时我会结合整集上下文直接展开回答。</p></div>`;
        stream.appendChild(turn);
        stream.scrollTop = stream.scrollHeight;
        askInput.value = '';
      });
    }

    function exportMd(triggerBtn) {
      const qaLines = stream ? [...stream.querySelectorAll('.chat-turn')].map(t => {
        const u = t.querySelector('.msg-u');
        const a = t.querySelector('.msg-a p');
        return `**Q:** ${u ? u.textContent : ''}\n**A:** ${a ? a.textContent : ''}`;
      }) : [];
      const md = [
        '# 注意力、好奇心，以及慢一点的理解',
        '',
        '> 由 PodDesk 导出 · Markdown',
        '',
        '## 双语文稿',
        ...LINES.map(l => `\n### [${l.t}]\n${l.en}\n${l.zh}`),
        '',
        '## 在场对话',
        qaLines.join('\n\n'),
      ].join('\n');
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'attention-and-curiosity.md';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (triggerBtn) {
        const label = triggerBtn.querySelector('span') || triggerBtn;
        const orig = label.textContent;
        label.textContent = '已导出 .md';
        setTimeout(() => { label.textContent = orig; }, 1600);
      }
    }
    dlBtns.forEach(b => b.addEventListener('click', () => exportMd(b)));

    new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(el);
    el.setState = function (s) { el.dataset.state = s; };
    el.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => {
      el.dataset.state = t.dataset.tab;
      opts.onTab && opts.onTab(+t.dataset.tab);
    }));
    return el;
  }

  return { LINES, THEMES, applyTheme, applyThemeTo, win };
})();

/* 暗室高定三列实机模拟 HTML 模板（含双拖拽边界 + 三态连续轨道） */
PD.winHTML = function (o) {
  o = o || {};
  const ln = PD.LINES.map(l => `<div class="ln" role="button" tabindex="0"><span class="ln-t">${l.t}</span><div class="ln-axis" aria-hidden="true"><span class="ln-seg-t"></span><span class="ln-seg-b"></span><span class="ln-dot"></span></div><div class="ln-txt"><div class="zh">${l.zh}</div><div class="en">${l.en}</div></div></div>`).join('');
  return `<div class="win" data-state="1" data-lang="zh" style="${o.style || ''}">
<div class="w-top">
 <span class="w-brand"><span class="w-logo" aria-hidden="true"><i style="height:6px"></i><i style="height:11px"></i><i style="height:8px"></i><i style="height:12px"></i></span><span class="w-name">PodDesk</span></span>
 <button type="button" class="w-exp-btn" data-md-dl><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 20h14"/></svg><span>导出 .md</span></button>
</div>
<div class="w-body">
 <!-- 左列：收听控制台 -->
 <aside class="w-rail" aria-label="播客单集播放控制">
  <div class="w-rail-top">
   <div class="w-cover" aria-hidden="true">
    <span class="w-ring r1"></span><span class="w-ring r2"></span><span class="w-ring r3"></span>
    <span class="w-core-dot"></span>
    <span class="w-cov-tag">THE KNOWLEDGE PROJECT</span>
   </div>
   <div>
    <div class="w-ep-title">注意力、好奇心，以及慢一点的理解</div>
    <div class="w-ep-meta">EP. 142 · 58:24</div>
   </div>
  </div>
  <div class="w-transport">
   <label class="sr-only" for="wb-range">拖动播放进度</label>
   <input id="wb-range" class="w-range" data-w-range type="range" min="0" max="1000" step="1" value="400" />
   <div class="w-times"><b class="cur-t">42:18</b><span>58:24</span></div>
   <div class="w-ctrls">
    <button type="button" class="c-mini" data-back-btn aria-label="回退上一句">-15s</button>
    <button type="button" class="play" data-on="1" aria-label="暂停"><svg viewBox="0 0 12 12"><path class="i-play" d="M2.5 1.2v9.6L10.5 6z"/><path class="i-pause" d="M2.5 1.5h2.6v9H2.5zm4.4 0h2.6v9H6.9z"/></svg></button>
    <button type="button" class="c-mini" data-speed-btn aria-label="切换播放倍速">1×</button>
   </div>
   <div class="w-rail-foot"><i></i><span>本机音频就绪</span></div>
  </div>
 </aside>

 <div class="w-split" data-split="left" role="separator" aria-orientation="vertical" aria-label="调整左侧收听栏宽度，双击复位" tabindex="0"></div>

 <!-- 中列：零重排丝滑精读 + 三态点亮时间轴 -->
 <div class="w-main">
  <div class="w-col-h">
   <span class="w-col-ht"><i></i>文稿</span>
   <div class="w-lang-seg" role="group" aria-label="文稿语言显示">
    <button type="button" data-lang-opt="both" aria-pressed="false">双语</button>
    <button type="button" data-lang-opt="en" aria-pressed="false">原文</button>
    <button type="button" data-lang-opt="zh" aria-pressed="true">译文</button>
   </div>
  </div>
  <div class="lines">${ln}</div>
 </div>

 <div class="w-split" data-split="right" role="separator" aria-orientation="vertical" aria-label="调整右侧问答栏宽度，双击复位" tabindex="0"></div>

 <!-- 右列：自然人机对话流 + 一体式 Codex 输入盒 -->
 <aside class="w-side">
  <div class="w-side-head">
   <div class="tabs">
    <button type="button" class="tab" data-tab="1">问答</button>
    <button type="button" class="tab" data-tab="0">导读</button>
   </div>
  </div>
  <div class="pane p1">
   <div class="chat-stream">
    <div class="chat-turn">
     <div class="msg-u">为什么“追问”比“总结”更重要？</div>
     <div class="msg-a">
      <div class="msg-a-tag"><i></i><span data-agent-name>Codex</span></div>
      <p>摘要是别人替你划重点 <button type="button" class="a-chip" data-live="1" data-seek="1">40:54</button>，而追问让你保留自己的判断。讲者把收听分成两种状态：<b>消费结论</b>，或是<b>与内容一起思考</b> <button type="button" class="a-chip" data-live="2" data-seek="2">42:18</button> <button type="button" class="a-chip" data-live="3" data-seek="3">43:36</button>。</p>
     </div>
    </div>
    <div class="chat-turn">
     <div class="msg-u">那听完这一期该记点什么？</div>
     <div class="msg-a">
      <div class="msg-a-tag"><i></i><span data-agent-name>Codex</span></div>
      <p>不是记一条现成答案，而是留一个<b>能让你反复回看的好问题</b> <button type="button" class="a-chip" data-live="4" data-seek="4">45:42</button>，需要核对时直接点时间戳回到原声。</p>
     </div>
    </div>
   </div>

   <div class="composer-wrap">
    <form class="composer-box" autocomplete="off">
     <label class="sr-only" for="wb-ask-input">基于当前播客提问</label>
     <input id="wb-ask-input" type="text" maxlength="80" placeholder="问点什么，Enter 发送…" />
     <div class="composer-bar">
      <select class="w-agent-sel" data-agent-sel aria-label="切换 AI Agent">
       <option value="Codex">Codex</option>
       <option value="Claude Code">Claude Code</option>
       <option value="DeepSeek">DeepSeek</option>
       <option value="Kimi Code">Kimi Code</option>
      </select>
      <button type="submit" class="ask-send" aria-label="发送问题"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
     </div>
    </form>
   </div>
  </div>
  <div class="pane p0">
   <div class="gt">
    <div class="gt-i"><button type="button" class="a-chip" data-seek="0">38:42</button><b>摘要的隐藏代价</b><span>由别人替你划定重点，意味着放弃了自己的判断。</span></div>
    <div class="gt-i on"><button type="button" class="a-chip" data-seek="2">42:18</button><b>从总结转向追问</b><span>当你开始提出问题，收听才真正变成与内容对话。</span></div>
    <div class="gt-i"><button type="button" class="a-chip" data-seek="4">45:42</button><b>值得带走的笔记</b><span>最好的笔记不是答案，而是能反复回看的更好问题。</span></div>
   </div>
  </div>
 </aside>
</div></div>`;
};
PD.mountWin = function (host, o) { host.innerHTML = PD.winHTML(o); return PD.win(host.firstElementChild, o); };
