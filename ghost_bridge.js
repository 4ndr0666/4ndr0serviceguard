// ghost_bridge.js — 4ndr0serviceguard Bootstrap Bridge v7.3 (ISOLATED world)
//
// Three responsibilities, in injection order:
//
//   1. ID PUBLISH (v7.1 baseline, preserved verbatim): publish the extension
//      ID into the DOM at document_start so the MAIN-world Ghost Core (which
//      has no access to chrome.* APIs) can address the background service
//      worker through the externally_connectable messaging stub. The ID is
//      public information; tampering with the attribute can only degrade the
//      Ghost Core's channel, which fails safe (default-deny).
//
//   2. QUICK BAR (v7.3.0): renders the in-page interactive decision surface
//      when the background gate needs an authorize/spoof/deny verdict. This
//      replaces focus-stealing OS popup windows with a 3lectric-Glass bar in
//      the page's own viewport: one click or one keystroke (A/S/D, Enter,
//      Esc), a 30 s auto-deny countdown, and an optional remembered scope
//      (this connection / this site / this endpoint). The bar lives in a
//      CLOSED shadow root and every handler rejects synthetic (isTrusted ===
//      false) events, so the page cannot press its own authorize button.
//      Settlement travels over the INTERNAL chrome.runtime channel — page
//      scripts cannot forge it (external senders are rejected by the router).
//
//   3. POLICY REQUEST BRIDGE (v7.3.0): the helper userscript defers to the
//      extension whenever the extension governs a page, but its menu
//      commands used to edit only GM-local lists — the extension never
//      learned about them, which is the root cause of the "blacklisting does
//      not stop the popup" field report. The userscript now posts a
//      policyRequest window message; the bridge answers with a CONFIRM bar
//      (same isTrusted gate) and only a genuine click writes the real
//      extension list over the internal channel. Forged request spam is
//      contained by per-session caps, a show-rate floor and auto-dismiss.

(function () {
  'use strict';

  // === 1. ID PUBLISH (v7.1 baseline, preserved) ===

  const ATTR = 'data-4ndr0-ext';
  const MAX_ATTEMPTS = 20;
  const RETRY_MS = 10;

  function publish() {
    try {
      const root = document.documentElement;
      if (root && !root.hasAttribute(ATTR)) {
        root.setAttribute(ATTR, chrome.runtime.id || '');
      }
      return !!(root && root.hasAttribute(ATTR));
    } catch (e) {
      console.debug('[Ψ-Bridge] ID publish failed:', e);
      return false;
    }
  }

  if (!publish()) {
    // documentElement not yet available (rare timing windows) — bounded retry.
    let attempts = 0;
    const timer = setInterval(() => {
      if (publish() || ++attempts >= MAX_ATTEMPTS) clearInterval(timer);
    }, RETRY_MS);
  }

  // === QUICK BAR RUNTIME ===

  const QB_HOST_ID = '__4ndr0guard_qb_host';
  const QB_COUNTDOWN_S = 30;     // auto-deny countdown (default-deny doctrine)
  const QB_QUEUE_CAP = 4;        // 1 visible + 3 queued asks per frame
  const CB_SESSION_CAP = 6;      // confirm bars per page load (anti-spam)
  const CB_MIN_INTERVAL_MS = 1500;
  const CB_QUEUE_CAP = 2;
  const CB_AUTO_DISMISS_S = 12;

  const askQueue = [];
  let qbActive = null;           // { reqId, scope, timer, controller }

  function trusted(e) {
    return !!(e && e.isTrusted !== false);
  }

  function hostnameOf(value) {
    try { return new URL(String(value), location.href).hostname; }
    catch (e) { return ''; }
  }

  function truncate(value, max) {
    const s = String(value || '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function glyphSvg() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 128 128');
    svg.setAttribute('class', 'glyph');
    const ring1 = document.createElementNS(NS, 'path');
    ring1.setAttribute('d', 'M 64,12 A 52,52 0 1 1 63.9,12 Z');
    ring1.setAttribute('stroke-dasharray', '21.78 21.78');
    ring1.setAttribute('stroke-width', '2');
    ring1.setAttribute('class', 'glyph-ring-1');
    const ring2 = document.createElementNS(NS, 'path');
    ring2.setAttribute('d', 'M 64,20 A 44,44 0 1 1 63.9,20 Z');
    ring2.setAttribute('stroke-dasharray', '10 10');
    ring2.setAttribute('stroke-width', '1.5');
    ring2.setAttribute('opacity', '0.7');
    const hex = document.createElementNS(NS, 'path');
    hex.setAttribute('d', 'M64 30 L91.3 47 L91.3 81 L64 98 L36.7 81 L36.7 47 Z');
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', '64');
    text.setAttribute('y', '67');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('font-size', '56');
    text.setAttribute('font-weight', '700');
    text.setAttribute('font-family', "'Cinzel Decorative', serif");
    text.textContent = 'Ψ';
    svg.appendChild(ring1);
    svg.appendChild(ring2);
    svg.appendChild(hex);
    svg.appendChild(text);
    return svg;
  }

  // 3lectric-Glass (4NDR0666OS UI/UX spec) translated for an in-page shadow
  // surface: Glass Level 2 panel, near-opaque header with the 2px cyan
  // termination line, Electric Cyan accents, JetBrains Mono local stack (no
  // remote font fetches from page context — stealth), rectangular brutalist
  // buttons, 150ms ease-in-out transitions, destructive #ff0055 for DENY.
  function barStyle() {
    const style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '* { box-sizing: border-box; font-family: "JetBrains Mono", "Fira Mono", ui-monospace, monospace; }',
      '.panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;',
      '  width: 340px; background: rgba(10, 19, 26, 0.65);',
      '  border: 1px solid rgba(0, 229, 255, 0.3); border-radius: 4px;',
      '  box-shadow: 0 0 20px rgba(0, 229, 255, 0.15);',
      '  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);',
      '  color: #00E5FF; font-size: 12px; }',
      '.header { display: flex; align-items: center; gap: 10px; padding: 10px;',
      '  background: rgba(10, 19, 26, 0.95); border-bottom: 2px solid #00E5FF;',
      '  border-radius: 4px 4px 0 0; }',
      '.glyph { width: 34px; height: 34px; flex-shrink: 0; stroke: #00E5FF;',
      '  fill: none; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }',
      '.glyph text { fill: #00E5FF; }',
      '.title { font-family: "Orbitron", "JetBrains Mono", sans-serif;',
      '  font-size: 13px; font-weight: 700; color: #67E8F9; letter-spacing: 1px; }',
      '.subtitle { font-size: 9px; color: rgba(0, 229, 255, 0.7); letter-spacing: 2px; margin-top: 2px; }',
      '.count { margin-left: auto; font-size: 10px; color: #ffaa00;',
      '  border: 1px solid rgba(255, 170, 0, 0.4); padding: 3px 6px; }',
      '.body { padding: 12px 12px 0 12px; }',
      '.row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 11px; }',
      '.row .k { color: rgba(0, 229, 255, 0.7); text-transform: uppercase; letter-spacing: 1px; font-size: 10px; }',
      '.row .v { color: #67E8F9; text-align: right; word-break: break-all; }',
      '.row .v.alert { color: #ffaa00; }',
      '.actions { display: flex; gap: 6px; padding: 12px 12px 0 12px; }',
      '.actions button { flex: 1; padding: 10px 4px; background: rgba(10, 19, 26, 0.65);',
      '  border: 1px solid rgba(0, 229, 255, 0.4); border-radius: 0; color: #00E5FF;',
      '  font-weight: bold; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase;',
      '  cursor: pointer; transition: all 150ms ease-in-out; }',
      '.actions button:hover { background: rgba(0, 229, 255, 0.2);',
      '  border-color: #00E5FF; box-shadow: 0 0 20px rgba(0, 229, 255, 0.5); color: #67E8F9; }',
      '.actions button:active { background: rgba(0, 229, 255, 0.3); color: #ffffff; }',
      '.actions button.destructive { border-color: #ff0055; color: #ff0055; }',
      '.actions button.destructive:hover { background: rgba(255, 0, 85, 0.3);',
      '  border-color: #ff0055; box-shadow: 0 0 25px #ff0055; color: #ffffff; }',
      '.scopes { display: flex; gap: 6px; padding: 8px 12px 0 12px; }',
      '.scopes button { flex: 1; padding: 6px 4px; background: rgba(10, 19, 26, 0.55);',
      '  border: 1px solid rgba(0, 229, 255, 0.25); border-radius: 0; color: rgba(0, 229, 255, 0.7);',
      '  font-size: 9px; letter-spacing: 0.05em; text-transform: uppercase; cursor: pointer;',
      '  transition: all 150ms ease-in-out; }',
      '.scopes button.on { background: rgba(0, 229, 255, 0.2); border-color: #00E5FF; color: #67E8F9; }',
      '.scopes button:hover { color: #67E8F9; border-color: rgba(0, 229, 255, 0.5); }',
      '.hint { padding: 8px 12px 12px 12px; font-size: 9px; line-height: 1.6;',
      '  color: rgba(0, 229, 255, 0.7); }',
      '.hint b { color: #67E8F9; font-weight: bold; }'
    ].join('\n');
    return style;
  }

  function removeBar() {
    const host = document.getElementById(QB_HOST_ID);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (qbActive) {
      if (qbActive.timer) clearInterval(qbActive.timer);
      if (qbActive.controller) qbActive.controller.abort();
      qbActive = null;
    }
  }

  // Renders the ask bar. Returns true when the bar (or a queue slot) accepted it.
  function showQuickBar(ask) {
    if (!document.documentElement) return false;
    if (qbActive) {
      if (askQueue.length >= QB_QUEUE_CAP - 1) return false;
      askQueue.push(ask);
      return true;
    }

    const siteHost = hostnameOf(ask.origin) || hostnameOf(ask.url);
    const endpointHost = hostnameOf(ask.url);
    const scopeDomain = {
      connection: '',
      site: siteHost,
      endpoint: endpointHost
    };

    const host = document.createElement('div');
    host.id = QB_HOST_ID;
    const root = host.attachShadow({ mode: 'closed' });
    root.appendChild(barStyle());

    const panel = document.createElement('div');
    panel.className = 'panel';

    // Header (spec 4.3) + live countdown chip
    const header = document.createElement('div');
    header.className = 'header';
    header.appendChild(glyphSvg());
    const headerText = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'GATEKEEPER';
    const subtitle = document.createElement('div');
    subtitle.className = 'subtitle';
    subtitle.textContent = 'AUTHORIZATION REQUIRED';
    headerText.appendChild(title);
    headerText.appendChild(subtitle);
    header.appendChild(headerText);
    const count = document.createElement('div');
    count.className = 'count';
    header.appendChild(count);
    panel.appendChild(header);

    // Data rows
    const body = document.createElement('div');
    body.className = 'body';
    function row(label, value, alert) {
      const r = document.createElement('div');
      r.className = 'row';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'v' + (alert ? ' alert' : '');
      v.textContent = value;
      r.appendChild(k);
      r.appendChild(v);
      return r;
    }
    body.appendChild(row('TYPE', String(ask.type || 'UNKNOWN')));
    body.appendChild(row('SITE', siteHost || 'unknown'));
    body.appendChild(row('TARGET', truncate(ask.url, 52), true));
    panel.appendChild(body);

    // Primary actions — one click each (spec 4.4 / 4.5)
    let scope = 'connection';
    let settled = false;

    function settle(action) {
      if (settled) return; // single-settlement guard
      settled = true;
      const message = {
        action: 'resolvePermission',
        id: ask.reqId,
        allowed: action === 'allow',
        // NOTE: `decision`, not `action` — `action` is the router dispatch
        // key; a duplicate key would silently misroute the settlement.
        decision: action
      };
      if (scope === 'site' && scopeDomain.site) {
        message.remember = 'site';
        message.domain = scopeDomain.site;
      } else if (scope === 'endpoint' && scopeDomain.endpoint) {
        message.remember = 'endpoint';
        message.domain = scopeDomain.endpoint;
      }
      try {
        chrome.runtime.sendMessage(message, () => {
          void chrome.runtime.lastError; // gate may already be settled (race)
        });
      } catch (e) {
        console.debug('[Ψ-Bridge] quick-bar resolve failed:', e);
      }
      removeBar();
      renderNextAsk();
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    function actBtn(label, cls, action) {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', (e) => {
        if (!trusted(e)) return; // synthetic clicks are rejected
        settle(action);
      });
      return b;
    }
    actions.appendChild(actBtn('AUTHORIZE ·A', '', 'allow'));
    actions.appendChild(actBtn('SPOOF ·S', '', 'spoof'));
    actions.appendChild(actBtn('DENY ·D', 'destructive', 'deny'));
    panel.appendChild(actions);

    // Remembered-scope selector (default: this connection only)
    const scopes = document.createElement('div');
    scopes.className = 'scopes';
    function scopeBtn(key, label) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = key === 'connection' ? 'on' : '';
      b.addEventListener('click', (e) => {
        if (!trusted(e)) return;
        scope = key;
        Array.prototype.forEach.call(scopes.children, (c) => {
          c.classList.toggle('on', c === b);
        });
      });
      return b;
    }
    scopes.appendChild(scopeBtn('connection', 'THIS CONNECTION'));
    scopes.appendChild(scopeBtn('site', 'SITE · ' + truncate(siteHost || '—', 14)));
    scopes.appendChild(scopeBtn('endpoint', 'ENDPOINT · ' + truncate(endpointHost || '—', 12)));
    panel.appendChild(scopes);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'ENTER authorize · ESC deny · SPOOF = silent live socket · DENY = native failure · SITE = never ask again';
    panel.appendChild(hint);

    root.appendChild(panel);
    document.documentElement.appendChild(host);

    // Keyboard: A/S/D actions, Enter authorize, Esc deny — genuine keys only.
    qbActive = { reqId: ask.reqId, timer: null, controller: new AbortController() };
    const onKey = (e) => {
      if (!trusted(e)) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''))) return;
      const k = String(e.key || '').toLowerCase();
      if (k === 'a') { e.preventDefault(); settle('allow'); }
      else if (k === 's') { e.preventDefault(); settle('spoof'); }
      else if (k === 'd') { e.preventDefault(); settle('deny'); }
      else if (e.key === 'Enter') { e.preventDefault(); settle('allow'); }
      else if (e.key === 'Escape') { e.preventDefault(); settle('deny'); }
    };
    document.addEventListener('keydown', onKey, {
      capture: true,
      signal: qbActive.controller.signal
    });

    // Countdown — default-deny on expiry, then serve the queue.
    let left = QB_COUNTDOWN_S;
    count.textContent = left + 's';
    qbActive.timer = setInterval(() => {
      left -= 1;
      count.textContent = left + 's';
      if (left <= 0) settle('deny'); // auto-deny once (no remembered grant)
    }, 1000);

    return true;
  }

  function renderNextAsk() {
    if (qbActive) return;
    const next = askQueue.shift();
    if (next) showQuickBar(next);
  }

  // === CONFIRM BAR (userscript policy requests) ===

  const CB_HOST_ID = '__4ndr0guard_cb_host';
  const confirmQueue = [];
  let cbActive = null;
  let cbSessionCount = 0;
  let cbLastShownAt = 0;

  const KIND_TEXT = {
    whitelist: 'AUTHORIZE (whitelist)',
    spooflist: 'SPOOF (spooflist)',
    blacklist: 'BLOCK (blacklist)',
    reset: 'RESET — remove from all lists',
    toggle: 'MASTER TOGGLE'
  };
  const KIND_ACTION = {
    whitelist: 'addWhitelist',
    spooflist: 'addSpooflist',
    blacklist: 'addBlacklist',
    reset: 'removeDomain',
    toggle: 'toggle'
  };

  function removeConfirmBar() {
    const host = document.getElementById(CB_HOST_ID);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (cbActive) {
      if (cbActive.timer) clearInterval(cbActive.timer);
      if (cbActive.controller) cbActive.controller.abort();
      cbActive = null;
    }
  }

  function showConfirmBar(request) {
    if (!document.documentElement) return false;
    if (cbActive) {
      if (confirmQueue.length >= CB_QUEUE_CAP) return false;
      confirmQueue.push(request);
      return true;
    }
    if (cbSessionCount >= CB_SESSION_CAP) return false; // page spam contained
    const now = Date.now();
    if (now - cbLastShownAt < CB_MIN_INTERVAL_MS) {
      if (confirmQueue.length >= CB_QUEUE_CAP) return false;
      confirmQueue.push(request);
      return true;
    }
    cbLastShownAt = now;
    cbSessionCount += 1;

    const kind = KIND_ACTION[request.kind] ? request.kind : null;
    if (!kind) return false;
    const domain = String(request.domain || '');

    const host = document.createElement('div');
    host.id = CB_HOST_ID;
    const root = host.attachShadow({ mode: 'closed' });
    root.appendChild(barStyle());

    const panel = document.createElement('div');
    panel.className = 'panel';

    const header = document.createElement('div');
    header.className = 'header';
    header.appendChild(glyphSvg());
    const headerText = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'POLICY REQUEST';
    const subtitle = document.createElement('div');
    subtitle.className = 'subtitle';
    subtitle.textContent = 'PAGE → EXTENSION BRIDGE';
    headerText.appendChild(title);
    headerText.appendChild(subtitle);
    header.appendChild(headerText);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'body';
    const r = document.createElement('div');
    r.className = 'row';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = 'REQUEST';
    const v = document.createElement('span');
    v.className = 'v alert';
    v.textContent = (KIND_TEXT[kind] || kind) + (domain ? ' · ' + truncate(domain, 26) : '');
    r.appendChild(k);
    r.appendChild(v);
    body.appendChild(r);
    const note = document.createElement('div');
    note.className = 'row';
    const nk = document.createElement('span');
    nk.className = 'k';
    nk.textContent = 'SOURCE';
    const nv = document.createElement('span');
    nv.className = 'v';
    nv.textContent = 'userscript menu (untrusted until confirmed)';
    note.appendChild(nk);
    note.appendChild(nv);
    body.appendChild(note);
    panel.appendChild(body);

    let done = false;
    function finish(confirmed) {
      if (done) return;
      done = true;
      if (confirmed) {
        const message = { action: KIND_ACTION[kind] };
        if (kind === 'reset') message.domain = domain;
        else if (kind === 'toggle') message.enabled = request.value !== false;
        else message.domain = domain;
        try {
          chrome.runtime.sendMessage(message, () => {
            void chrome.runtime.lastError;
          });
        } catch (e) {
          console.debug('[Ψ-Bridge] policy confirm send failed:', e);
        }
      }
      removeConfirmBar();
      if (confirmQueue.length) {
        const next = confirmQueue.shift();
        // Slight delay so the min-show-interval floor stays meaningful.
        setTimeout(() => { showConfirmBar(next); }, CB_MIN_INTERVAL_MS);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'CONFIRM';
    okBtn.addEventListener('click', (e) => { if (trusted(e)) finish(true); });
    const noBtn = document.createElement('button');
    noBtn.className = 'destructive';
    noBtn.textContent = 'IGNORE';
    noBtn.addEventListener('click', (e) => { if (trusted(e)) finish(false); });
    actions.appendChild(okBtn);
    actions.appendChild(noBtn);
    panel.appendChild(actions);

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'ENTER confirm · ESC ignore · auto-ignore in ' + CB_AUTO_DISMISS_S + 's';
    panel.appendChild(hint);

    root.appendChild(panel);
    document.documentElement.appendChild(host);

    cbActive = { timer: null, controller: new AbortController() };
    const onKey = (e) => {
      if (!trusted(e)) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''))) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    document.addEventListener('keydown', onKey, {
      capture: true,
      signal: cbActive.controller.signal
    });

    let left = CB_AUTO_DISMISS_S;
    cbActive.timer = setInterval(() => {
      left -= 1;
      if (left <= 0) finish(false); // timeout = ignore (never confirm by default)
    }, 1000);

    return true;
  }

  // Userscript → extension policy requests. The message itself is forgeable
  // by the page (any script can postMessage); the CONFIRM click is what makes
  // it user-genuine. Kinds are whitelisted; anything else is dropped.
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.__4ndr0guard !== 'policyRequest') return;
    if (typeof d.kind !== 'string' || !KIND_ACTION[d.kind]) return;
    if (d.kind !== 'toggle' && typeof d.domain !== 'string') return;
    showConfirmBar({ kind: d.kind, domain: d.domain, value: d.value });
  });

  // === BACKGROUND → BRIDGE CHANNEL ===

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const action = request && request.action;
    if (action === 'ghostQuickAsk') {
      // Synchronous render acknowledgment — the gate falls back to the
      // prompt window when the bar cannot accept the ask.
      const shown = showQuickBar({
        reqId: request.reqId,
        type: request.type,
        url: request.url,
        origin: request.origin
      });
      sendResponse({ status: shown ? 'shown' : 'unavailable' });
      return false;
    }
    if (action === 'ghostQuickDismiss') {
      // The request settled elsewhere (window fallback race, tab close) —
      // pull the bar without resolving anything.
      if (qbActive && qbActive.reqId === request.reqId) {
        removeBar();
        renderNextAsk();
      } else {
        const idx = askQueue.findIndex((a) => a.reqId === request.reqId);
        if (idx !== -1) askQueue.splice(idx, 1);
      }
      sendResponse({ status: 'dismissed' });
      return false;
    }
    return false; // not ours — other listeners (none) may take it
  });
})();
