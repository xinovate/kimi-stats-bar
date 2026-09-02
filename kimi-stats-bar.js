// Kimi Code Web 会话统计条(方案 A:cmux addinitscript 注入版)
// 数据来源:同源 REST /api/v1/sessions/{id}/status + WebSocket /api/v1/ws 会话事件
(function () {
  if (window.__kimiStatsBar) return;
  window.__kimiStatsBar = true;

  var BAR_ID = 'kimi-stats-bar-injected';

  function getToken() {
    try {
      var raw = localStorage.getItem('kimi-web.server-credential');
      if (!raw) return null;
      try { var o = JSON.parse(raw); return o.credential || o.token || raw; } catch (e) { return raw; }
    } catch (e) { return null; }
  }

  function currentSessionId() {
    var m = location.href.match(/session_[0-9a-fA-F-]{8,}/);
    return m ? m[0] : null;
  }

  function fmtK(n) {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function fmtDur(ms) {
    if (ms == null) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  }

  // 取整版:27K / 262K / 5.5M
  function fmtKr(n) {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(Math.round(n));
  }

  // 状态:token 总量优先服务端聚合,否则用 step 重放累计(均跨刷新保留)
  var S = {
    total: null,            // 服务端 usage.total
    turns: 0, steps: 0,
    llmMs: 0,               // Σ(首 token 延迟 + 流式时长)
    ttftSum: 0, ttftN: 0,
    outTok: 0, streamMs: 0, // 本会话注入后的输出 token 与流式时长 → tok/s
    turnStart: 0, turnWallMs: 0,
    inOther: 0, inCacheRead: 0, inCacheCreation: 0, outTokTotal: 0, // 从 step.completed 重放累计
    q5h: null, q7d: null,   // 订阅配额百分比(账号级)
  };

  // 账号配额:5h / 7d 窗口,60s 轮询一次
  function pollQuota() {
    var token = getToken();
    if (!token) return;
    fetch('/api/v1/oauth/usage', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = j && j.data;
        if (!d || d.kind !== 'ok') return;
        if (d.summary && d.summary.limit) S.q7d = Math.round(d.summary.used / d.summary.limit * 100);
        var five = (d.limits || []).find(function (l) { return l.window && l.window.unit === 'hour' && l.window.duration === 5; });
        if (five && five.limit) S.q5h = Math.round(five.used / five.limit * 100);
        render();
      }).catch(function () {});
  }
  pollQuota();
  setInterval(pollQuota, 60000);

  function ensureBar() {
    var el = document.getElementById(BAR_ID);
    if (el) return el;
    var st = document.createElement('style');
    st.textContent =
      '#' + BAR_ID + '{position:fixed;left:0;transform:translateX(-50%);bottom:3px;z-index:99999;' +
      'max-width:94vw;padding:2px 9px;border-radius:999px;' +
      'font:10px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'background:rgba(255,255,255,.55);color:#26262c;border:1px solid rgba(0,0,0,.08);' +
      'backdrop-filter:blur(12px) saturate(1.4);-webkit-backdrop-filter:blur(12px) saturate(1.4);' +
      'box-shadow:0 2px 10px rgba(0,0,0,.08);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;}' +
      '#' + BAR_ID + ' .d{color:#9b9ba4;}' +
      '#' + BAR_ID + ' .v{color:#26262c;font-weight:600;}' +
      '#' + BAR_ID + ' .s{color:#c4c4cc;margin:0 3px;}' +
      '@media (prefers-color-scheme: dark){' +
      '#' + BAR_ID + '{background:rgba(24,24,28,.55);color:#ececf1;border-color:rgba(255,255,255,.12);box-shadow:0 2px 10px rgba(0,0,0,.25);}' +
      '#' + BAR_ID + ' .d{color:#8e8e98;}#' + BAR_ID + ' .v{color:#ececf1;}#' + BAR_ID + ' .s{color:#55555e;}}';
    (document.head || document.documentElement).appendChild(st);
    el = document.createElement('div');
    el.id = BAR_ID;
    document.documentElement.appendChild(el);
    return el;
  }

  // 左侧功能栏宽度:取贴左缘、近全高的 aside/nav 类元素(kimi web 是 <aside class="side">),
  // 找不到返回 0;侧栏折叠/展开时随下次渲染自动跟进
  function sidebarWidth() {
    var els = document.querySelectorAll('aside, nav, [class*="sidebar" i], [class*="side-bar" i]');
    var w = 0;
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.left <= 1 && r.height >= window.innerHeight * 0.6 &&
          r.width >= 40 && r.width <= window.innerWidth * 0.5 && r.width > w) w = r.width;
    }
    return w;
  }

  // 水平居中于「视口减去左侧栏」的内容区,而不是整个窗口
  function positionBar(el) {
    var sw = sidebarWidth();
    el.style.left = Math.round(sw + (window.innerWidth - sw) / 2) + 'px';
  }

  // 双色调片段:英文标签暗,数值亮
  function seg(label, value) {
    return '<span class="d">' + label + '</span> <span class="v">' + value + '</span>';
  }
  var SEP = '<span class="s">·</span>';

  function render() {
    var el = ensureBar();
    positionBar(el);
    var parts = [];
    if (S.q5h != null) parts.push(seg('5h', S.q5h + '%'));
    if (S.q7d != null) parts.push(seg('7d', S.q7d + '%'));
    if (S.turns || S.steps) parts.push(seg('', S.turns + '轮·' + S.steps + '步'));
    if (S.llmMs) {
      parts.push(seg('LLM', fmtDur(S.llmMs)));
      var tool = Math.max(0, S.turnWallMs - S.llmMs);
      parts.push(seg('tool', fmtDur(tool)));
    }
    if (S.ttftN) parts.push(seg('TTFT', (S.ttftSum / S.ttftN / 1000).toFixed(1) + 's'));
    if (S.streamMs >= 50 && S.outTok) parts.push(seg('', (S.outTok / (S.streamMs / 1000)).toFixed(0) + ' tok/s'));
    // token 统计:优先服务端聚合(S.total),否则用 step 重放累计值
    var inAll = S.inOther + S.inCacheRead;
    var hasReplay = inAll > 0 || S.outTokTotal > 0;
    var t = S.total;
    if (t && !hasReplay) {
      inAll = (t.inputOther || 0) + (t.inputCacheRead || 0);
      S.inCacheRead = t.inputCacheRead || 0; S.inCacheCreation = t.inputCacheCreation || 0; S.outTokTotal = t.output || 0;
    }
    if (inAll > 0) parts.push(seg('cache', Math.round(S.inCacheRead / inAll * 100) + '%'));
    if (inAll + S.inCacheCreation + S.outTokTotal > 0) {
      parts.push('<span class="d">↑</span><span class="v">' + fmtKr(inAll + S.inCacheCreation) + '</span> ' +
        '<span class="d">↓</span><span class="v">' + fmtKr(S.outTokTotal) + '</span> ' +
        '<span class="d">Σ</span><span class="v">' + fmtKr(inAll + S.inCacheCreation + S.outTokTotal) + '</span>');
    }
    el.innerHTML = parts.length ? parts.join(SEP) : '<span class="d">kimi stats: waiting…</span>';
  }

  var ws = null, wsSid = null, retryMs = 2000, lastSeq = -1;

  function connect(sid, token) {
    try {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + location.host + '/api/v1/ws', ['kimi-code.bearer.' + token]);
      ws.onopen = function () {
        retryMs = 2000;
        // client_hello 携带订阅;首次用 cursor 0 重放缓冲区历史,断线重连用 lastSeq 增量续传
        var cur = lastSeq >= 0 ? lastSeq : 0;
        ws.send(JSON.stringify({ type: 'client_hello', id: 'stats-hello', payload: { client_id: 'kimi-stats-bar', subscriptions: [sid], cursors: { [sid]: { seq: cur } } } }));
      };
      ws.onmessage = function (e) {
        var ev; try { ev = JSON.parse(e.data); } catch (_) { return; }
        // 应用层心跳:必须回 pong,否则服务端断连
        if (ev.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong', payload: { nonce: ev.payload && ev.payload.nonce } })); } catch (_) {}
          return;
        }
        if (typeof ev.seq === 'number' && ev.seq > lastSeq) lastSeq = ev.seq;
        var p = ev.payload || ev;
        if (!p || !p.type) return;
        if (p.type === 'agent.status.updated') {
          // 只保留 usage.total(服务端聚合兜底);上下文字段官方 UI 已显示,不再采集
          if (p.usage && p.usage.total) S.total = p.usage.total;
          render();
        } else if (p.type === 'turn.started') {
          S.turns++; S.turnStart = Date.now(); render();
        } else if (p.type === 'turn.step.completed') {
          S.steps++;
          if (p.llmFirstTokenLatencyMs) { S.ttftSum += p.llmFirstTokenLatencyMs; S.ttftN++; S.llmMs += p.llmFirstTokenLatencyMs; }
          if (p.llmStreamDurationMs) {
            S.llmMs += p.llmStreamDurationMs; S.streamMs += p.llmStreamDurationMs;
            if (p.usage && p.usage.output) S.outTok += p.usage.output;
          }
          if (p.usage) {
            S.inOther += p.usage.inputOther || 0;
            S.inCacheRead += p.usage.inputCacheRead || 0;
            S.inCacheCreation += p.usage.inputCacheCreation || 0;
            S.outTokTotal += p.usage.output || 0;
          }
          render();
        } else if (p.type === 'turn.ended') {
          // 重放的历史事件带 durationMs;实时事件用本地计时兜底
          if (p.durationMs != null) S.turnWallMs += p.durationMs;
          else if (S.turnStart) S.turnWallMs += Date.now() - S.turnStart;
          S.turnStart = 0;
          render();
        }
      };
      ws.onclose = function () {
        ws = null;
        setTimeout(function () { var s = currentSessionId(); if (s) connect(s, getToken()); }, retryMs);
        retryMs = Math.min(retryMs * 2, 30000);
      };
    } catch (e) { /* 忽略,下轮轮询重试 */ }
  }

  // SPA 路由变化轮询:会话切换时重连;无会话时显示占位条而不是消失
  setInterval(function () {
    var sid = currentSessionId(), token = getToken();
    if (!token) {
      // 非 kimi web 页面(油猴 @match 较宽):彻底退出,不留任何 UI
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      wsSid = null;
      var el0 = document.getElementById(BAR_ID);
      if (el0) el0.remove();
      return;
    }
    if (!sid) {
      wsSid = null;
      var el = ensureBar();
      positionBar(el);
      var q = [];
      if (S.q5h != null) q.push(seg('5h', S.q5h + '%'));
      if (S.q7d != null) q.push(seg('7d', S.q7d + '%'));
      el.innerHTML = q.length
        ? q.join(SEP) + SEP + '<span class="d">no session</span>'
        : '<span class="d">kimi stats</span> <span class="s">·</span> <span class="d">no session</span>';
      return;
    }
    ensureBar(); render();
    if (sid !== wsSid) {
      wsSid = sid; lastSeq = -1;
      S.turns = 0; S.steps = 0; S.llmMs = 0; S.ttftSum = 0; S.ttftN = 0; S.outTok = 0; S.streamMs = 0; S.turnWallMs = 0; S.turnStart = 0;
      S.inOther = 0; S.inCacheRead = 0; S.inCacheCreation = 0; S.outTokTotal = 0; S.total = null;
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      connect(sid, token);
    }
  }, 2000);
})();
