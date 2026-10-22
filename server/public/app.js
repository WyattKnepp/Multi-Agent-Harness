// Ideas web app. Plain JS, no build step. Hash routes: #/ (list), #/idea/<id>.
const $app = document.getElementById('app');
const $banner = document.getElementById('banner');

const state = { ideas: [], projects: [], tab: load('tab') || 'inbox', current: null };

const TABS = {
  inbox: { label: 'Inbox', statuses: ['inbox', 'grilling', 'review'] },
  sent: { label: 'Sent', statuses: ['ready', 'dispatching', 'dispatched', 'failed'] },
  archived: { label: 'Archived', statuses: ['archived'] },
};
const STATUS_LABEL = {
  inbox: 'new', grilling: 'grilling', review: 'handoff ready', ready: 'queued',
  dispatching: 'launching', dispatched: 'running', failed: 'failed', archived: 'archived',
};

// ---------- small helpers ----------

function load(k) { try { return localStorage.getItem('ideas:' + k); } catch { return null; } }
function store(k, v) { try { v == null ? localStorage.removeItem('ideas:' + k) : localStorage.setItem('ideas:' + k, v); } catch {} }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Just enough Markdown for chat replies: paragraphs, lists, **bold**, `code`.
function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  return String(text).split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*] /.test(l))) return '<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('') + '</ul>';
    if (lines.every((l) => /^\s*\d+[.)] /.test(l))) return '<ol>' + lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('') + '</ol>';
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'error-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// When the 7-day Google session expires, Caddy redirects API calls to the login
// page on another origin, which fetch reports as a network error.
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
  } catch {
    showBanner('Connection lost or signed out — tap to reload');
    throw new Error('offline');
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    showBanner('Signed out — tap to sign in again');
    throw new Error('signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function showBanner(text) { $banner.textContent = text; $banner.hidden = false; }
$banner.onclick = () => location.reload();

// ---------- routing ----------

function route() {
  const m = location.hash.match(/^#\/idea\/(\w+)/);
  return m ? { view: 'idea', id: m[1] } : { view: 'list' };
}

async function render() {
  const r = route();
  if (r.view === 'list') {
    state.current = null;
    state.ideas = await api('GET', '/api/ideas').catch(() => state.ideas);
    renderList();
  } else {
    try {
      state.current = await api('GET', '/api/ideas/' + r.id);
    } catch (e) {
      toast(e.message);
      location.hash = '#/';
      return;
    }
    if (!state.projects.length) {
      state.projects = (await api('GET', '/api/projects').catch(() => ({ projects: [] }))).projects;
    }
    renderIdea();
  }
  schedulePoll();
}
window.addEventListener('hashchange', render);

// ---------- list view ----------

function renderList() {
  const counts = {};
  for (const [k, t] of Object.entries(TABS)) counts[k] = state.ideas.filter((i) => t.statuses.includes(i.status)).length;
  const shown = state.ideas.filter((i) => TABS[state.tab].statuses.includes(i.status));
  const draft = load('capture') || '';

  $app.innerHTML = `
    <header class="top"><h1>Ideas</h1></header>
    <form class="capture" id="capture">
      <textarea id="capture-text" placeholder="What's the idea?" rows="3">${esc(draft)}</textarea>
      <div class="row end"><button class="btn primary" type="submit">Save</button></div>
    </form>
    <nav class="tabs">
      ${Object.entries(TABS).map(([k, t]) => `<button data-tab="${k}" class="${k === state.tab ? 'on' : ''}">${t.label}<span class="n">${counts[k] || ''}</span></button>`).join('')}
    </nav>
    ${shown.length ? shown.map(card).join('') : `<div class="empty">${state.tab === 'inbox' ? 'Nothing here. Jot something down.' : 'Nothing here yet.'}</div>`}
  `;

  const ta = document.getElementById('capture-text');
  ta.oninput = () => store('capture', ta.value || null);
  ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) document.getElementById('capture').requestSubmit(); };
  document.getElementById('capture').onsubmit = async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    try {
      const idea = await api('POST', '/api/ideas', { text });
      store('capture', null);
      state.ideas.unshift(idea);
      state.tab = 'inbox';
      store('tab', 'inbox');
      renderList();
    } catch (err) { toast(err.message); }
  };
  $app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
    state.tab = b.dataset.tab;
    store('tab', state.tab);
    renderList();
  }));
}

function card(i) {
  const project = i.handoff?.project;
  return `<a class="card" href="#/idea/${i.id}">
    <div class="t">${esc(i.handoff?.title || i.text)}</div>
    <div class="meta">
      <span class="pill ${i.status}">${i.busy ? 'thinking…' : STATUS_LABEL[i.status]}</span>
      ${project ? `<span>${esc(project)}</span>` : ''}
      <span>${ago(i.updatedAt)}</span>
    </div>
  </a>`;
}

// ---------- idea view ----------

function renderIdea() {
  const i = state.current;
  const canChat = ['inbox', 'grilling', 'review', 'failed'].includes(i.status) && i.grillSession;
  const draft = load('draft:' + i.id) || '';

  $app.innerHTML = `
    <header class="top">
      <a class="btn ghost back" href="#/">‹ Ideas</a>
      <span class="grow"></span>
      <span class="pill ${i.status}">${STATUS_LABEL[i.status]}</span>
      <button class="btn ghost" data-act="${i.status === 'archived' ? 'unarchive' : 'archive'}">${i.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
    </header>

    <div class="idea-text" id="idea-text" title="Tap to edit">${esc(i.text)}</div>

    ${i.messages.length || i.busy ? `<div class="section-label">Grilling</div>` : ''}
    <div class="thread">
      ${i.messages.map((m) => `<div class="msg ${m.role}">${m.role === 'claude' ? md(m.text) : esc(m.text)}</div>`).join('')}
      ${i.busy ? `<div class="thinking">Claude is thinking</div>` : ''}
    </div>

    ${!i.grillSession && i.status !== 'archived' ? `
      <div class="section-label">Ready when you are</div>
      <div class="panel">
        <textarea id="grill-extra" rows="2" placeholder="Optional: extra context before Claude starts">${esc(draft)}</textarea>
        <div class="row end"><button class="btn primary" data-act="start" ${i.busy ? 'disabled' : ''}>Grill me</button></div>
      </div>` : ''}

    ${i.handoff && ['review', 'ready', 'dispatching', 'dispatched', 'failed'].includes(i.status) ? handoffPanel(i) : ''}

    ${canChat ? `
      <div class="composer">
        <textarea id="reply" rows="2" placeholder="Answer…" ${i.busy ? 'disabled' : ''}>${esc(draft)}</textarea>
        <div class="row" style="margin-top:8px">
          ${i.messages.length ? `<button class="btn" data-act="handoff" ${i.busy ? 'disabled' : ''}>${i.handoff ? 'Rewrite handoff' : 'Write handoff'}</button>` : ''}
          <span class="grow"></span>
          <button class="btn primary" data-act="reply" ${i.busy ? 'disabled' : ''}>Send</button>
        </div>
      </div>` : ''}

    ${i.status === 'archived' ? `<div class="row end" style="margin-top:16px"><button class="btn danger" data-act="delete">Delete forever</button></div>` : ''}
  `;

  bindIdea(i);
  if (i.messages.length && canChat) window.scrollTo(0, document.body.scrollHeight);
}

function handoffPanel(i) {
  const h = i.handoff;
  const locked = ['ready', 'dispatching', 'dispatched'].includes(i.status);
  const names = state.projects.map((p) => p.name);
  const isNew = !names.includes(h.project);
  const d = i.dispatch || {};

  let status = '';
  if (i.status === 'ready') status = `<div class="panel status-box"><div>Queued. Your laptop will pick it up within a few seconds of being on.</div><div class="row end"><button class="btn" data-act="unsend">Pull back</button></div></div>`;
  if (i.status === 'dispatching') status = `<div class="panel status-box"><div>Launching on your laptop…</div></div>`;
  if (i.status === 'dispatched') status = `<div class="panel status-box ok"><div class="note ok">Running in herdr</div>
      <div>Workspace <strong>${esc(d.workspaceLabel || h.project)}</strong>, tab <strong>${esc(d.tabLabel || '')}</strong>, agent <code>${esc(d.agent || '')}</code></div>
      ${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}</div>`;
  if (i.status === 'failed') status = `<div class="panel status-box bad"><div class="note bad">Dispatch failed: ${esc(d.error)}</div><div class="note">Fix it below and send again.</div></div>`;

  return `
    <div class="section-label">Handoff</div>
    ${status}
    <div class="panel" style="margin-top:8px">
      <div><label for="h-title">Title</label><input id="h-title" value="${esc(h.title)}" ${locked ? 'disabled' : ''}></div>
      <div>
        <label for="h-project">Project</label>
        <select id="h-project" ${locked ? 'disabled' : ''}>
          ${names.map((n) => `<option ${n === h.project ? 'selected' : ''}>${esc(n)}</option>`).join('')}
          <option value="__new" ${isNew ? 'selected' : ''}>New project…</option>
        </select>
        <input id="h-new" placeholder="new-folder-name" value="${isNew ? esc(h.project) : ''}" style="margin-top:6px" ${isNew ? '' : 'hidden'} ${locked ? 'disabled' : ''}>
        ${isNew ? `<div class="note" style="margin-top:4px">Creates a new folder <code>${esc(h.project)}</code> in your projects folder on the laptop.</div>` : ''}
      </div>
      <div><label for="h-brief">Brief for Claude Code</label><textarea id="h-brief" class="brief" ${locked ? 'disabled' : ''}>${esc(h.brief)}</textarea></div>
      ${locked ? '' : `<div class="row end"><button class="btn primary" data-act="send">Send to Claude Code</button></div>`}
    </div>`;
}

function bindIdea(i) {
  const on = (act, fn) => $app.querySelectorAll(`[data-act="${act}"]`).forEach((b) => (b.onclick = fn));
  const run = async (fn) => {
    try { await fn(); } catch (e) { if (e.message !== 'offline' && e.message !== 'signed out') toast(e.message); }
    render();
  };
  // Grilling calls take a while; show "thinking" right away and let polling
  // pick up the reply, so leaving the page mid-call loses nothing.
  const grillCall = (url, body) => {
    state.current.busy = true;
    renderIdea();
    return run(async () => {
      await api('POST', url, body);
      store('draft:' + i.id, null);
    });
  };

  const extra = document.getElementById('grill-extra');
  const reply = document.getElementById('reply');
  for (const ta of [extra, reply]) if (ta) ta.oninput = () => store('draft:' + i.id, ta.value || null);
  if (reply) reply.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $app.querySelector('[data-act="reply"]').click(); };

  on('start', () => grillCall(`/api/ideas/${i.id}/grill`, { message: extra?.value || '' }));
  on('reply', () => {
    const message = reply.value.trim();
    if (!message) return;
    state.current.messages.push({ role: 'me', text: message });
    grillCall(`/api/ideas/${i.id}/grill`, { message });
  });
  on('handoff', () => grillCall(`/api/ideas/${i.id}/handoff`));
  on('send', () => run(async () => {
    const sel = document.getElementById('h-project').value;
    const project = sel === '__new' ? document.getElementById('h-new').value.trim() : sel;
    await api('POST', `/api/ideas/${i.id}/send`, {
      title: document.getElementById('h-title').value.trim(),
      project,
      brief: document.getElementById('h-brief').value,
    });
  }));
  on('unsend', () => run(() => api('POST', `/api/ideas/${i.id}/unsend`)));
  on('archive', () => run(async () => { await api('PATCH', `/api/ideas/${i.id}`, { archived: true }); location.hash = '#/'; }));
  on('unarchive', () => run(() => api('PATCH', `/api/ideas/${i.id}`, { archived: false })));
  on('delete', () => {
    if (!confirm('Delete this idea and its grilling for good?')) return;
    run(async () => { await api('DELETE', `/api/ideas/${i.id}`); location.hash = '#/'; });
  });

  const sel = document.getElementById('h-project');
  if (sel) sel.onchange = () => { document.getElementById('h-new').hidden = sel.value !== '__new'; };

  // Tap the idea text to edit it.
  const textEl = document.getElementById('idea-text');
  textEl.onclick = () => {
    if (textEl.querySelector('textarea')) return;
    const ta = document.createElement('textarea');
    ta.value = i.text;
    ta.rows = Math.max(3, i.text.split('\n').length + 1);
    textEl.replaceChildren(ta);
    ta.focus();
    ta.onblur = () => run(async () => {
      if (ta.value.trim() && ta.value !== i.text) await api('PATCH', `/api/ideas/${i.id}`, { text: ta.value });
    });
  };
}

// ---------- polling ----------
// Only while waiting on something (Claude thinking, laptop dispatching), and
// only re-render when the idea actually changed, so typing isn't interrupted.

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const i = state.current;
  const waiting = i ? i.busy || ['ready', 'dispatching'].includes(i.status) : state.ideas.some((x) => x.busy || ['ready', 'dispatching'].includes(x.status));
  if (!waiting) return;
  pollTimer = setTimeout(async () => {
    if (document.hidden) return schedulePoll();
    const r = route();
    if (r.view === 'idea') {
      const fresh = await api('GET', '/api/ideas/' + r.id).catch(() => null);
      if (fresh && (fresh.updatedAt !== state.current?.updatedAt || fresh.busy !== state.current?.busy || fresh.status !== state.current?.status)) {
        state.current = fresh;
        renderIdea();
      }
    } else {
      state.ideas = await api('GET', '/api/ideas').catch(() => state.ideas);
      renderList();
    }
    schedulePoll();
  }, 2500);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

render();
