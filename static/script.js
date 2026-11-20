/* Studiora AI — app (vanilla JS) */
(() => {
  'use strict';

  const S = window.Studiora;
  const $ = (id) => document.getElementById(id);
  const ic = (n) => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const el = {
    app: $('app'), thread: $('thread'), messages: $('messages'), input: $('input'), send: $('send'), sendIcon: $('sendIcon'),
    composer: $('composer'), chips: $('chips'), chatList: $('chatList'), title: $('chatTitle'), toBottom: $('toBottom'),
    fileInput: $('fileInput'), tray: $('tray'), toasts: $('toasts'), search: $('chatSearch'), fileCount: $('fileCount'),
  };

  const state = {
    chats: [], activeId: null, files: [], pending: new Set(), uploads: [], runs: new Map(), generating: new Set(),
    drafts: {}, models: [], model: S.store.get('model', null), online: true, user: 'Student', filter: '',
    seenChips: new Set(), trayShown: new Set(), titles: new Map(), warnedKeyword: false,
  };
  const ALLOWED = ['pdf', 'docx', 'txt', 'md', 'csv'];
  const mobile = window.matchMedia('(max-width: 900px)');
  let uid = 0;

  /* ================= helpers ================= */
  async function api(path, opts = {}) {
    const init = { credentials: 'same-origin', ...opts };
    if (opts.json !== undefined) {
      init.method = init.method || 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.json);
    }
    const r = await fetch(path, init);
    if (r.status === 401) { location.href = '/login'; throw new Error('Not signed in'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  function toast(msg, kind = '', onClick) {
    const t = document.createElement('div');
    t.className = `toast ${kind} ${onClick ? 'click' : ''}`;
    t.innerHTML = ic(kind === 'error' ? 'alert' : kind === 'ok' ? 'check-circle' : 'info') + '<span></span>';
    t.querySelector('span').textContent = msg;
    if (onClick) t.addEventListener('click', () => { onClick(); dismiss(); });
    el.toasts.appendChild(t);
    const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 350); };
    setTimeout(dismiss, onClick ? 6000 : 3600);
  }

  function confirmBox(title, text, okLabel = 'Delete', danger = true) {
    return new Promise((resolve) => {
      const back = $('modalBack'), ok = $('modalOk');
      $('modalTitle').textContent = title; $('modalText').textContent = text; ok.textContent = okLabel;
      ok.className = 'btn ' + (danger ? 'danger' : 'primary');
      back.classList.add('show');
      const done = (v) => { back.classList.remove('show'); ok.onclick = $('modalCancel').onclick = back.onclick = null; resolve(v); };
      ok.onclick = () => done(true); $('modalCancel').onclick = () => done(false);
      back.onclick = (e) => { if (e.target === back) done(false); };
    });
  }

  const fmtPages = (pages) => {
    const p = [...new Set(pages)].sort((a, b) => a - b), out = [];
    for (let i = 0; i < p.length;) { let j = i; while (j + 1 < p.length && p[j + 1] === p[j] + 1) j++; out.push(j > i ? `${p[i]}–${p[j]}` : `${p[i]}`); i = j + 1; }
    return out.join(', ');
  };
  const extOf = (n) => (n.split('.').pop() || '').toLowerCase();
  const fileIcon = (ext) => (ext === 'csv' ? 'table' : 'file');
  const parseUTC = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
  const prettyModel = (n) => { if (!n) return 'Model'; const [b, t] = n.split(':'); return b.charAt(0).toUpperCase() + b.slice(1) + (t ? ' · ' + t.toUpperCase() : ''); };

  function countUp(node, to) {
    const from = +node.textContent || 0;
    if (from === to || S.prefs.calm) { node.textContent = to; return; }
    const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 700); node.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  async function refreshStats() {
    try { const s = await api('/api/stats'); countUp($('stChats'), s.chats); countUp($('stDocs'), s.documents); countUp($('stAsked'), s.questions); } catch { /* ignore */ }
  }

  /* ================= markdown ================= */
  function inline(s) {
    s = esc(s);
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>').replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }
  window.Studiora.md = (t) => renderMarkdown(t);
  const COMPONENTS = ['diagram', 'mcq', 'docs', 'actions'];
  const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  /* Indent-aware list parser: bullets under a numbered item nest inside it, so numbering is never restarted. */
  function listBlock(lines, i, base) {
    const first = lines[i].match(LI), ordered = /\d/.test(first[2]), start = ordered ? parseInt(first[2], 10) : 1, items = [];
    while (i < lines.length) {
      const m = lines[i].match(LI);
      if (!m) {
        if (/^\s*$/.test(lines[i])) {                         // a blank line keeps the list going if more items follow
          let j = i; while (j < lines.length && /^\s*$/.test(lines[j])) j++;
          const nm = j < lines.length && lines[j].match(LI);
          if (nm && indentOf(lines[j]) >= base && items.length) { i = j; continue; }
          break;
        }
        if (items.length && indentOf(lines[i]) > base && !/^\s*(```|#{1,4}\s|>|\|)/.test(lines[i])) { items[items.length - 1].text += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      const ind = m[1].replace(/\t/g, '    ').length;
      if (ind < base) break;
      const isOrd = /\d/.test(m[2]);
      if (ind > base || (ind === base && isOrd !== ordered && ordered && items.length)) {   // nested (or sloppy same-indent bullets under a number)
        if (!items.length) break;
        const sub = listBlock(lines, i, ind);
        items[items.length - 1].sub += sub.html; i = sub.next; continue;
      }
      if (isOrd !== ordered) break;
      items.push({ text: m[3], sub: '' }); i++;
    }
    const tag = ordered ? 'ol' : 'ul';
    return { html: `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map((t) => `<li>${inline(t.text)}${t.sub}</li>`).join('')}</${tag}>`, next: i };
  }
  function renderMarkdown(src) {
    const lines = src.replace(/\r\n/g, '\n').split('\n'), out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```(\w*)/);
      if (fence) {
        const buf = []; i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        if (COMPONENTS.includes(fence[1])) { out.push(`<div class="comp" data-kind="${fence[1]}" data-payload="${esc(buf.join('\n'))}"></div>`); continue; }
        out.push(`<div class="codeblock"><div class="bar"><span>${esc(fence[1] || 'code')}</span><button class="tool" data-copy-code>${ic('copy')} Copy</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`);
        continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`); continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(line); i += 2; const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }
      if (LI.test(line)) { const r = listBlock(lines, i, line.match(LI)[1].length); out.push(r.html); i = r.next; continue; }
      const buf = [line]; i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('');
  }

  /* ================= messages ================= */
  function scrollBottom(force = false) {
    const m = el.messages;
    if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTo({ top: m.scrollHeight, behavior: force ? 'auto' : 'smooth' });
  }

  function showWelcome() {
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const items = [
      ['book', 'Explain a concept', 'Explain how photosynthesis works, step by step'],
      ['file', 'Short notes (PDF)', 'Create a PDF of short notes on process scheduling in operating systems'],
      ['help', 'Quiz me (MCQ)', 'Ask me MCQ questions one by one on basic data structures'],
      ['layers', 'Draw a diagram', 'Draw a diagram of how a computer network works'],
    ];
    el.thread.innerHTML = `<div class="welcome">
      ${S.orbHTML(132, 'float')}
      <h2>Welcome to your <span>study universe</span></h2>
      <p>${greet}, ${esc(state.user)}. Ask anything, or drop in your notes and I'll answer from them.</p>
      <div class="suggestions">${items.map(([i, t, p], n) => `<button class="suggest c${n} rip-host" data-spot data-prompt="${esc(p)}" style="--n:${n}"><span class="s-top"><span class="s-ic">${ic(i)}</span>${t}</span><span class="d">“${esc(p)}”</span></button>`).join('')}</div></div>`;
  }

  function attsHTML(atts) {
    return atts && atts.length ? `<div class="atts">${atts.map((a) => `<span class="att">${ic(fileIcon(extOf(a.name)))}<span>${esc(a.name)}</span></span>`).join('')}</div>` : '';
  }

  function addMessage(role, content, { sources = [], attachments = [], streaming = false, id = null, meta = {}, status = '' } = {}) {
    el.thread.querySelector('.welcome')?.remove();
    const row = document.createElement('div');
    const user = role === 'user';
    row.className = `msg ${user ? 'user' : 'bot'}`;
    row.dataset.role = user ? 'user' : 'assistant';
    row.innerHTML = `<div class="av">${user ? esc((state.user[0] || 'S').toUpperCase()) : S.orbHTML(38, 'lite')}</div><div class="bubble-wrap">${user ? attsHTML(attachments) : ''}<div class="bubble ${user ? '' : 'md'}"></div></div>`;
    const bubble = row.querySelector('.bubble');
    row._raw = content; row._meta = meta || {}; row._status = status;
    if (id) row.dataset.mid = id;
    if (user) bubble.textContent = content;
    else if (streaming) bubble.innerHTML = '<div class="thinking"><span class="shimmer">Thinking</span><span class="dots"><i></i><i></i><i></i></span></div>';
    else { bubble.innerHTML = renderMarkdown(content); hydrate(row); }
    el.thread.appendChild(row);
    if (!streaming) finishMessage(row, sources);
    scrollBottom(true);
    return row;
  }

  function finishMessage(row, sources) {
    const wrap = row.querySelector('.bubble-wrap');
    wrap.querySelector('.msg-tools')?.remove(); wrap.querySelector('.sources')?.remove();
    if (sources && sources.length && row.dataset.role === 'assistant') {
      const box = document.createElement('div');
      box.className = 'sources';
      box.innerHTML = sources.map((x) => {
        const pages = x.pages || (x.page ? [x.page] : []);
        const pg = extOf(x.file) === 'pdf' && pages.length ? ` · p.${fmtPages(pages)}` : '';
        return `<span class="src">${ic('paperclip')}${esc(x.file)}${pg}</span>`;
      }).join('');
      wrap.appendChild(box);
    }
    const tools = document.createElement('div');
    tools.className = 'msg-tools';
    tools.innerHTML = `<button class="tool" data-copy-msg>${ic('copy')} Copy</button>`;
    wrap.appendChild(tools);
  }

  /* ================= chats ================= */
  function groupName(c) {
    const d = parseUTC(c.updated_at), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 864e5);
    return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'Previous 7 days' : 'Older';
  }

  function renderChats() {
    const q = state.filter.toLowerCase();
    const list = state.chats.filter((c) => c.title.toLowerCase().includes(q));
    if (!list.length) { el.chatList.innerHTML = `<div class="empty-note">${state.chats.length ? 'No matching chats.' : 'No conversations yet.'}</div>`; return; }
    const groups = {};
    list.forEach((c) => { (groups[groupName(c)] ||= []).push(c); });
    let n = 0, html = '';
    ['Today', 'Yesterday', 'Previous 7 days', 'Older'].filter((g) => groups[g]).forEach((g) => {
      html += `<div class="group-label">${ic('clock')}${g}</div><div class="chat-group">` + groups[g].map((c) => {
        const busy = state.generating.has(c.id);
        const prev = state.titles.get(c.id);
        const flash = prev && prev !== c.title ? ' flash' : '';
        return `<div class="chat-item ${c.id === state.activeId ? 'active' : ''}" data-id="${c.id}" style="animation-delay:${Math.min(n++, 10) * 30}ms">
          ${busy ? '<span class="spin-ring" title="Generating…"></span>' : ic('message')}<span class="chat-title${flash}">${esc(c.title)}</span>
          <span class="chat-actions"><button data-act="rename" title="Rename">${ic('pencil')}</button><button data-act="delete" class="del" title="Delete">${ic('trash')}</button></span></div>`;
      }).join('') + '</div>';
    });
    el.chatList.innerHTML = html;
    state.chats.forEach((c) => state.titles.set(c.id, c.title));
  }

  async function loadChats() {
    const data = await api('/api/chats');
    state.chats = data;
    const before = new Set(state.generating);
    const srv = new Set(data.filter((c) => c.generating).map((c) => c.id));
    state.runs.forEach((_, id) => srv.add(id));
    state.generating = srv;
    // answers that finished in a chat we are not looking at
    before.forEach((id) => {
      if (!srv.has(id) && id !== state.activeId) {
        const c = data.find((x) => x.id === id);
        if (c) toast(`Answer ready in “${c.title}”`, 'ok', () => openChat(id));
      }
    });
    S.setThinking(srv.size > 0);
    renderChats();
    updateBusy();
  }

  function markGenerating(id, on) {
    on ? state.generating.add(id) : state.generating.delete(id);
    S.setThinking(state.generating.size > 0);
    renderChats(); updateBusy();
  }

  function saveDraft() { if (state.activeId !== null) state.drafts[state.activeId] = el.input.value; }

  async function openChat(id) {
    if (state.activeId !== null) saveDraft();
    detachRun(id);
    if (state.activeId !== null && state.activeId !== id) detachRun(state.activeId);
    state.activeId = id;
    S.store.set('active', id);
    state.pending.clear();
    const chat = state.chats.find((c) => c.id === id);
    el.title.textContent = chat ? chat.title : 'New chat';
    renderChats(); closeDrawer();
    el.input.value = state.drafts[id] || ''; autosize();
    const [data] = await Promise.all([api(`/api/chats/${id}/messages`), loadFiles()]);
    if (state.activeId !== id) return;                     // switched again while loading
    el.thread.innerHTML = '';
    if (!data.messages.length && !data.generating) showWelcome();
    data.messages.forEach((m) => addMessage(m.role, m.content, { sources: m.sources, attachments: m.attachments, id: m.id, meta: m.meta }));
    if (data.generating) attachStream(id, addMessage('assistant', '', { streaming: true }), '');
    scrollBottom(true);
    updateBusy(); updateSend();
    if (!mobile.matches) el.input.focus();
  }

  async function newChat() {
    const empty = state.chats.find((c) => c.title === 'New chat' && !state.generating.has(c.id));
    if (empty) { if (empty.id !== state.activeId) await openChat(empty.id); else { closeDrawer(); el.input.focus(); } return; }
    const c = await api('/api/chats', { method: 'POST' });
    state.chats.unshift({ id: c.id, title: c.title, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
    await openChat(c.id);
  }

  function startRename(item) {
    const id = +item.dataset.id, span = item.querySelector('.chat-title');
    const input = document.createElement('input');
    input.className = 'chat-title-input'; input.value = span.textContent;
    span.replaceWith(input); input.focus(); input.select();
    let done = false;
    const commit = async (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (save && v) {
        try {
          const r = await api(`/api/chats/${id}`, { method: 'PATCH', json: { title: v } });
          const c = state.chats.find((x) => x.id === id); if (c) c.title = r.title;
          state.titles.set(id, r.title);
          if (id === state.activeId) el.title.textContent = r.title;
        } catch (e) { toast(e.message, 'error'); }
      }
      renderChats();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  async function deleteChat(id) {
    if (!(await confirmBox('Delete this chat?', 'Its messages and uploaded files will be permanently removed.'))) return;
    detachRun(id);
    await api(`/api/chats/${id}`, { method: 'DELETE' });
    state.chats = state.chats.filter((c) => c.id !== id);
    state.generating.delete(id); delete state.drafts[id];
    if (id === state.activeId) { state.activeId = null; state.chats.length ? await openChat(state.chats[0].id) : await newChat(); } else renderChats();
    S.setThinking(state.generating.size > 0);
    refreshStats(); toast('Chat deleted', 'ok');
  }

  /* ================= files & chips ================= */
  async function loadFiles() {
    state.files = state.activeId ? await api(`/api/chats/${state.activeId}/files`) : [];
    renderChips();
  }

  function chipHTML(c) {
    const still = state.seenChips.has(c.key) ? ' still' : '';
    state.seenChips.add(c.key);
    const ext = c.ext;
    if (c.kind === 'file') {      // uploaded, waiting to be sent with the next message (no remove button: files stay in the chat)
      return `<div class="chip ready fresh${still}" data-key="${c.key}" data-fid="${c.id}"><span class="ft ${ext}">${ic(fileIcon(ext))}<span class="badge">${ic('check')}</span></span>
        <span class="meta"><div class="nm" title="${esc(c.name)}">${esc(c.name)}</div><div class="st">Ready · ${c.chunks} part${c.chunks === 1 ? '' : 's'} · sends with your message</div></span></div>`;
    }
    const failed = c.phase === 'error';
    return `<div class="chip ${failed ? 'error' : c.phase}${still}" data-key="${c.key}" data-tmp="${c.tmp}" style="--p:${c.p}%"><span class="ft ${ext}">${ic(failed ? 'alert' : fileIcon(ext))}${failed ? '' : '<span class="spin-ring"></span>'}</span>
      <span class="meta"><div class="nm" title="${esc(c.name)}">${esc(c.name)}</div><div class="st">${failed ? esc(c.msg) : c.phase === 'indexing' ? 'Reading & indexing…' : 'Uploading ' + Math.round(c.p) + '%'}</div></span>
      <button class="x" aria-label="Cancel upload">${ic('x')}</button>${failed ? '' : '<span class="bar"></span>'}</div>`;
  }

  function renderChips() {
    const mk = (f) => ({ kind: 'file', key: 'f' + f.id, id: f.id, name: f.filename, ext: extOf(f.filename), chunks: f.chunk_count });
    const waiting = state.files.filter((f) => state.pending.has(f.id)).map(mk);
    const sent = state.files.filter((f) => !state.pending.has(f.id));
    const ups = state.uploads.filter((u) => u.chatId === state.activeId).map((u) => ({ kind: 'up', key: 'u' + u.tmp, tmp: u.tmp, name: u.name, ext: u.ext, phase: u.phase, p: u.p, msg: u.msg }));
    el.chips.innerHTML = [...waiting, ...ups].map(chipHTML).join('');
    el.tray.innerHTML = sent.map((f) => {
      const land = state.trayShown.has(f.id) ? '' : ' land';
      state.trayShown.add(f.id);
      return `<span class="tray-chip${land}" title="${esc(f.filename)} · ${f.chunk_count} parts read">${ic(fileIcon(extOf(f.filename)))}<span>${esc(f.filename)}</span></span>`;
    }).join('');
    el.fileCount.textContent = state.files.length;
    el.fileCount.classList.toggle('show', state.files.length > 0);
  }

  function updateChip(u) {
    const c = el.chips.querySelector(`[data-tmp="${u.tmp}"]`);
    if (!c) return;
    c.style.setProperty('--p', u.p + '%');
    c.classList.toggle('indexing', u.phase === 'indexing');
    c.querySelector('.st').textContent = u.phase === 'indexing' ? 'Reading & indexing…' : `Uploading ${Math.round(u.p)}%`;
  }

  async function handleFiles(list) {
    const files = [...list];
    if (!files.length) return;
    if (state.activeId === null) await newChat();
    for (const f of files) {
      const ext = extOf(f.name);
      if (!ALLOWED.includes(ext)) { toast(`${f.name}: use PDF, DOCX, TXT, MD or CSV`, 'error'); continue; }
      if (f.size > 38 * 1024 * 1024) { toast(`${f.name} is too large (max 38 MB)`, 'error'); continue; }
      uploadFile(f, ext);
    }
  }

  function uploadFile(file, ext) {
    const u = { tmp: ++uid, chatId: state.activeId, name: file.name, ext, phase: 'uploading', p: 0, msg: '' };
    state.uploads.push(u); renderChips();
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    xhr.open('POST', `/api/chats/${u.chatId}/upload`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { u.p = (e.loaded / e.total) * 100; if (e.loaded >= e.total) u.phase = 'indexing'; updateChip(u); } };
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 401) { location.href = '/login'; return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        state.uploads = state.uploads.filter((x) => x !== u);
        if (u.chatId === state.activeId) { state.files.push({ id: data.id, filename: data.filename, chunk_count: data.chunk_count }); state.pending.add(data.id); }
        renderChips(); refreshStats();
        toast(`${data.filename} is ready — ${data.chunk_count} part${data.chunk_count === 1 ? '' : 's'} read`, 'ok');
        if (!data.semantic && !state.warnedKeyword) { state.warnedKeyword = true; toast('Tip: run “ollama pull nomic-embed-text” for smarter document search.', ''); }
      } else { u.phase = 'error'; u.msg = data.error || 'Upload failed'; renderChips(); toast(`${file.name}: ${u.msg}`, 'error'); }
    };
    xhr.onerror = () => { u.phase = 'error'; u.msg = 'Network error'; renderChips(); };
    xhr.onabort = () => { state.uploads = state.uploads.filter((x) => x !== u); renderChips(); };
    const fd = new FormData(); fd.append('file', file); xhr.send(fd);
  }

  el.chips.addEventListener('click', (e) => {
    const btn = e.target.closest('.x'); if (!btn) return;
    const chip = btn.closest('.chip');
    const u = state.uploads.find((x) => x.tmp === +chip.dataset.tmp);
    if (u && u.phase !== 'error') u.xhr.abort(); else { state.uploads = state.uploads.filter((x) => x !== u); renderChips(); }
  });

  /* ================= widgets inside messages ================= */
  const ACCENTS = ['#6aa8ff', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c'];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

  function hydrate(row) {
    row.querySelectorAll('.comp:not([data-done])').forEach((node) => {
      let data; try { data = JSON.parse(node.dataset.payload); } catch { return; }
      node.dataset.done = '1';
      const fn = { diagram: buildDiagram, mcq: buildMcq, docs: buildDocs, actions: buildActions }[node.dataset.kind];
      if (fn) fn(node, data, row);
    });
  }

  /* ---- actions: quick-reply chips ---- */
  function buildActions(node, list) {
    node.innerHTML = `<div class="actions">${list.map((a, i) => `<button class="act-chip rip-host" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>`;
    node.addEventListener('click', (e) => {
      const b = e.target.closest('.act-chip'); if (!b) return;
      const a = list[+b.dataset.i];
      if (a.send) sendMessage(a.send);
      else { el.input.value = a.fill || ''; autosize(); updateSend(); el.input.focus(); }
    });
  }

  /* ---- generated documents ---- */
  function buildDocs(node, files) {
    node.innerHTML = `<div class="docs">${files.map((f) => `<div class="doc-card"><div class="doc-ic ${f.fmt}">${f.fmt === 'pdf' ? 'PDF' : 'DOCX'}</div>
      <div class="doc-meta"><b title="${esc(f.filename)}">${esc(f.filename)}</b><span>${f.fmt === 'pdf' ? 'PDF document' : 'Word document'} · ${fmtSize(f.size)}</span></div>
      <div class="doc-btns">${f.fmt === 'pdf' ? `<a class="btn-sm ghost" href="/api/documents/${f.id}?view=1" target="_blank" rel="noopener">${ic('eye')}Preview</a>` : ''}<a class="btn-sm" href="/api/documents/${f.id}" download>${ic('download')}Download</a></div></div>`).join('')}</div>`;
  }

  /* ---- MCQ: tap an option ---- */
  function buildMcq(node, q, row) {
    const letters = 'ABCD';
    const total = q.total ? ` / ${q.total}` : '';
    node.innerHTML = `<div class="mcq"><div class="mcq-head"><span>Question ${q.n}${total}</span><span class="topic">${esc(q.topic || '')}</span></div>
      <div class="mcq-q">${inline(q.question)}</div>
      <div class="mcq-opts">${q.options.map((o, i) => `<button class="opt rip-host" data-i="${i}"><span class="key">${letters[i]}</span><span class="tx">${inline(o)}</span><span class="res">${ic('check')}</span></button>`).join('')}</div>
      <div class="mcq-fb"></div><div class="mcq-actions"></div></div>`;
    const box = node.querySelector('.mcq'), opts = [...node.querySelectorAll('.opt')], fb = node.querySelector('.mcq-fb'), act = node.querySelector('.mcq-actions');
    const last = q.total && q.n >= q.total;
    const reveal = (pick, animate) => {
      opts.forEach((b, i) => {
        b.disabled = true;
        if (i === q.answer) b.classList.add('correct');
        else if (i === pick) b.classList.add('wrong');
        else b.classList.add('faded');
        if (i === pick && i !== q.answer) b.querySelector('.res').innerHTML = ic('x');
        if (!animate) b.style.animation = 'none';
      });
      const ok = pick === q.answer;
      fb.innerHTML = `<b class="${ok ? 'ok' : 'no'}">${ok ? 'Correct!' : 'Not quite.'}</b> ${ok ? '' : `The answer is <strong>${letters[q.answer]}</strong>. `}${inline(q.explanation || '')}`;
      fb.classList.add('show');
      act.innerHTML = (last ? '' : `<button data-go="Next question">Next question →</button>`) + `<button class="${last ? '' : 'ghost'}" data-go="End quiz">${last ? 'Finish & see score' : 'End quiz'}</button>`;
      box.classList.add('answered');
    };
    const prior = row._meta && Number.isInteger(row._meta.pick) ? row._meta.pick : null;
    if (prior !== null) reveal(prior, false);
    opts.forEach((b) => b.addEventListener('click', async () => {
      if (box.classList.contains('answered')) return;
      const pick = +b.dataset.i;
      reveal(pick, true);
      try {
        let mid = row.dataset.mid;
        if (!mid) {                                   // message id arrives with the end of the stream; look it up if we beat it
          for (let t = 0; t < 8 && !mid; t++) {
            const d = await api(`/api/chats/${state.activeId}/messages`);
            const m = [...d.messages].reverse().find((x) => x.role === 'assistant'); if (m) { mid = m.id; row.dataset.mid = mid; }
            if (!mid) await sleep(400);
          }
        }
        if (mid) await api(`/api/chats/${state.activeId}/messages/${mid}/pick`, { json: { pick } });
      } catch { /* the answer is shown either way */ }
    }));
    act.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) sendMessage(g.dataset.go); });
  }

  /* ---- diagrams: SVG with zoom / pan / fit / fullscreen / PNG ---- */
  function svgEl(name, attrs = {}, parent) {
    const n = document.createElementNS(SVGNS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function buildDiagram(node, lay) {
    node.innerHTML = `<div class="dgm"><div class="dgm-bar"><span class="t">${esc(lay.title)}</span>
      <button data-z="out" title="Zoom out" aria-label="Zoom out">${ic('minus')}</button><span class="pct">100%</span><button data-z="in" title="Zoom in" aria-label="Zoom in">${ic('plus')}</button>
      <button data-z="fit" title="Fit to view">Fit</button><button data-z="full" title="Full screen" aria-label="Full screen">${ic('maximize')}</button><button data-z="png" title="Download PNG" aria-label="Download PNG">${ic('download')}PNG</button></div>
      <div class="dgm-view"></div><div class="dgm-hint">Scroll or pinch to zoom · drag to pan · double-click to fit</div></div>`;
    const wrap = node.querySelector('.dgm'), view = node.querySelector('.dgm-view'), pct = node.querySelector('.pct');
    const svg = svgEl('svg', { xmlns: SVGNS }, view);
    const defs = svgEl('defs', {}, svg);
    const mk = svgEl('marker', { id: 'ah' + Math.random().toString(36).slice(2, 7), viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '8', markerHeight: '8', orient: 'auto-start-reverse' }, defs);
    svgEl('path', { d: 'M0 1 L10 5 L0 9 z', fill: '#8aa0e8' }, mk);
    const vp = svgEl('g', {}, svg);
    lay.groups.forEach((g) => {
      const c = ACCENTS[g.color % ACCENTS.length];
      const gg = svgEl('g', { style: `--c:${c}` }, vp);
      if (g.frame) {
        svgEl('rect', { class: 'gbox', x: g.x, y: g.y, width: g.w, height: g.h, rx: 16 }, gg);
        if (g.label) svgEl('text', { class: 'glabel', x: g.x + 18, y: g.y + 23 }, gg).textContent = g.label.toUpperCase();
      }
    });
    const edgeEls = lay.edges.map((e) => {
      const p = e.path, ed = svgEl('path', { class: 'edge', d: `M${p[0]} ${p[1]} C${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`, 'marker-end': `url(#${mk.id})` }, vp);
      return { e, ed };
    });
    lay.groups.forEach((g) => {
      const c = ACCENTS[g.color % ACCENTS.length];
      g.nodes.forEach((n) => {
        const ng = svgEl('g', { class: 'node', style: `--c:${c}`, 'data-id': n.id }, vp);
        svgEl('rect', { class: 'nbox', x: n.x, y: n.y, width: n.w, height: n.h, rx: 10 }, ng);
        const total = n.lines.length * 16 + (n.note ? 14 : 0);
        let ty = n.y + (n.h - total) / 2 + 12;
        n.lines.forEach((ln) => { svgEl('text', { class: 'ntxt', x: n.x + n.w / 2, y: ty }, ng).textContent = ln; ty += 16; });
        if (n.note) svgEl('text', { class: 'nnote', x: n.x + n.w / 2, y: ty + 1 }, ng).textContent = n.note;
        ng.addEventListener('mouseenter', () => edgeEls.forEach(({ e, ed }) => { const on = e.from === n.id || e.to === n.id; ed.classList.toggle('hi', on); ed.classList.toggle('dim', !on); }));
        ng.addEventListener('mouseleave', () => edgeEls.forEach(({ ed }) => ed.classList.remove('hi', 'dim')));
      });
    });
    lay.edges.forEach((e) => {
      if (!e.label) return;
      const g = svgEl('g', { class: 'elabel' }, vp), w = e.label.length * 6.4 + 16;
      svgEl('rect', { x: e.mid[0] - w / 2, y: e.mid[1] - 9, width: w, height: 18, rx: 9 }, g);
      svgEl('text', { x: e.mid[0], y: e.mid[1] + 4 }, g).textContent = e.label;
    });

    const T = { k: 1, x: 0, y: 0, touched: false };
    let fullscreen = null;
    const apply = () => { vp.setAttribute('transform', `translate(${T.x} ${T.y}) scale(${T.k})`); pct.textContent = Math.round(T.k * 100) + '%'; };
    const fit = () => {
      const r = view.getBoundingClientRect(); if (!r.width) return;
      T.k = Math.min(r.width / lay.width, r.height / lay.height, 1.25);
      T.x = (r.width - lay.width * T.k) / 2; T.y = (r.height - lay.height * T.k) / 2; T.touched = false; apply();
    };
    const closeFullscreen = () => {
      if (!fullscreen) return;
      const { backdrop, placeholder, button } = fullscreen;
      if (placeholder.parentNode) placeholder.replaceWith(wrap);
      else node.appendChild(wrap);
      backdrop.remove();
      wrap.classList.remove('full');
      wrap.removeAttribute('role');
      wrap.removeAttribute('aria-modal');
      wrap.removeAttribute('aria-label');
      button.innerHTML = ic('maximize');
      button.title = 'Full screen';
      button.setAttribute('aria-label', 'Full screen');
      fullscreen = null;
      el.app.inert = false;
      requestAnimationFrame(() => { fit(); button.focus(); });
    };
    const openFullscreen = (button) => {
      const placeholder = document.createComment('diagram position');
      const backdrop = document.createElement('div');
      backdrop.className = 'dgm-modal';
      wrap.parentNode.replaceChild(placeholder, wrap);
      backdrop.appendChild(wrap);
      document.body.appendChild(backdrop);
      wrap.classList.add('full');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.setAttribute('aria-label', lay.title);
      button.innerHTML = ic('minimize');
      button.title = 'Close full screen';
      button.setAttribute('aria-label', 'Close full screen');
      fullscreen = { backdrop, placeholder, button };
      el.app.inert = true;
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeFullscreen(); });
      backdrop.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeFullscreen(); }
      });
      requestAnimationFrame(() => { fit(); button.focus(); });
    };
    const zoomAt = (f, cx, cy) => {
      const nk = Math.max(0.2, Math.min(4, T.k * f)), r = nk / T.k;
      T.x = cx - (cx - T.x) * r; T.y = cy - (cy - T.y) * r; T.k = nk; T.touched = true; apply();
    };
    const center = () => { const r = view.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
    requestAnimationFrame(fit);
    if (window.ResizeObserver) new ResizeObserver(() => { if (!T.touched) fit(); }).observe(view);

    view.addEventListener('wheel', (e) => { e.preventDefault(); const r = view.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    view.addEventListener('dblclick', fit);
    const ptrs = new Map(); let lastDist = 0;
    view.addEventListener('pointerdown', (e) => { view.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); view.classList.add('drag'); lastDist = 0; });
    view.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 1) { T.x += e.clientX - prev[0]; T.y += e.clientY - prev[1]; T.touched = true; apply(); }
      else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), r = view.getBoundingClientRect();
        if (lastDist) zoomAt(d / lastDist, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
        lastDist = d;
      }
    });
    const up = (e) => { ptrs.delete(e.pointerId); lastDist = 0; if (!ptrs.size) view.classList.remove('drag'); };
    view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);

    node.querySelector('.dgm-bar').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-z]'); if (!b) return;
      const z = b.dataset.z, [cx, cy] = center();
      if (z === 'in') zoomAt(1.25, cx, cy);
      else if (z === 'out') zoomAt(1 / 1.25, cx, cy);
      else if (z === 'fit') fit();
      else if (z === 'full') {
        if (fullscreen) closeFullscreen();
        else openFullscreen(b);
      } else if (z === 'png') {
        try {
          const r = await fetch('/api/diagram/png', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lay) });
          if (!r.ok) throw new Error('PNG export failed');
          const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = lay.title.replace(/[^\w\-]+/g, '_') + '.png'; a.click(); URL.revokeObjectURL(a.href);
        } catch (x) { toast(x.message, 'error'); }
      }
    });
  }

  /* ================= generation (server job + attachable stream) ================= */
  const PHRASES_DOC = ['Reading your documents', 'Connecting the dots', 'Drafting an answer'];
  const PHRASES = ['Thinking', 'Gathering ideas', 'Drafting an answer'];

  function updateBusy() {
    const busy = state.activeId !== null && (state.runs.has(state.activeId) || state.generating.has(state.activeId));
    el.composer.classList.toggle('busy', busy);
    el.send.classList.toggle('stop', busy);
    el.sendIcon.innerHTML = `<use href="#i-${busy ? 'stop' : 'send'}"/>`;
    el.send.setAttribute('aria-label', busy ? 'Stop generating' : 'Send');
    updateSend();
  }
  function updateSend() {
    const busy = el.send.classList.contains('stop');
    el.send.disabled = !busy && !el.input.value.trim();
  }

  function detachRun(chatId) {
    const run = state.runs.get(chatId);
    if (!run) return;
    run.detached = true;
    run.controller.abort();
    clearInterval(run.phraseTimer); cancelAnimationFrame(run.raf);
    state.runs.delete(chatId);
  }

  function attachStream(chatId, row, status) {
    const run = {
      chatId, row, bubble: row.querySelector('.bubble'), orb: row.querySelector('.orb'), controller: new AbortController(),
      acc: '', sources: [], raf: 0, tries: 0, detached: false, phase: 0, status: status || '', painted: null,
    };
    state.runs.set(chatId, run);
    markGenerating(chatId, true);
    if (run.orb) S.setOrbState(run.orb, 'thinking', true);
    const phrases = state.files.length ? PHRASES_DOC : PHRASES;
    if (run.status) setThinkingText(run, run.status);
    run.phraseTimer = setInterval(() => {
      if (run.acc || run.status) return;
      run.phase = (run.phase + 1) % phrases.length;
      const s = run.bubble.querySelector('.shimmer'); if (s) s.textContent = phrases[run.phase];
    }, 2300);
    pump(run);
    return run;
  }

  function setThinkingText(run, t) { const s = run.bubble.querySelector('.shimmer'); if (s && !run.acc) s.textContent = t; }

  function paint(run) {
    run.raf = 0;
    run.bubble.innerHTML = renderMarkdown(run.acc);
    run.painted = run.acc; hydrate(run.row);
    run.bubble.classList.add('caret');
    if (state.activeId === run.chatId) scrollBottom();
  }

  async function pump(run) {
    let finished = false, missing = false;
    try {
      const r = await fetch(`/api/chats/${run.chatId}/stream`, { credentials: 'same-origin', signal: run.controller.signal });
      if (r.status === 401) { location.href = '/login'; return; }
      if (!r.ok) throw new Error('stream');
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      run.acc = '';                                           // the server replays the whole answer so far
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = /event: (\w+)/.exec(block)?.[1], data = /data: (.*)/.exec(block)?.[1];
          if (!ev || !data) continue;
          const p = JSON.parse(data);
          if (ev === 'meta') { run.sources = p.sources || []; if (p.status) { run.status = p.status; setThinkingText(run, p.status); } }
          else if (ev === 'status') { run.status = p.status; setThinkingText(run, p.status); }
          else if (ev === 'token') { run.acc += p.t; if (!run.raf) run.raf = requestAnimationFrame(() => paint(run)); }
          else if (ev === 'done') { finished = true; missing = !!p.missing; if (p.id) run.row.dataset.mid = p.id; }
        }
        if (finished) break;
      }
    } catch (e) { if (run.detached || e.name === 'AbortError') return; }
    if (run.detached) return;

    if (!finished && run.tries < 4) { run.tries++; await sleep(900); if (!run.detached) return pump(run); return; }

    clearInterval(run.phraseTimer); cancelAnimationFrame(run.raf);
    state.runs.delete(run.chatId);
    if (missing) {                                            // job ended before we attached: show what was saved
      markGenerating(run.chatId, false);
      if (state.activeId === run.chatId) await openChat(run.chatId);
      return;
    }
    run.bubble.classList.remove('caret');
    if (run.painted !== run.acc || !run.acc) { run.bubble.innerHTML = run.acc ? renderMarkdown(run.acc) : '<em>Stopped.</em>'; hydrate(run.row); }
    run.row._raw = run.acc;
    finishMessage(run.row, run.sources);
    if (run.orb) S.setOrbState(run.orb, 'idle');
    markGenerating(run.chatId, false);
    scrollBottom();
    loadChats().then(() => { const c = state.chats.find((x) => x.id === state.activeId); if (c) el.title.textContent = c.title; });
    refreshStats();
  }

  async function sendMessage(text) {
    text = (text ?? el.input.value).trim();
    if (!text) return;
    if (state.activeId === null) await newChat();
    const id = state.activeId;
    if (state.generating.has(id) || state.runs.has(id)) { toast('Studiora is still answering in this chat — press stop or wait.'); return; }
    if (state.uploads.some((u) => u.chatId === id && u.phase !== 'error')) { toast('Still reading your file — one moment…'); return; }

    const atts = state.files.filter((f) => state.pending.has(f.id)).map((f) => ({ id: f.id, name: f.filename }));
    el.input.value = ''; delete state.drafts[id]; autosize();
    addMessage('user', text, { attachments: atts });
    const row = addMessage('assistant', '', { streaming: true });
    state.pending.clear(); renderChips();
    markGenerating(id, true);
    try {
      const r = await api(`/api/chats/${id}/chat`, { json: { message: text, model: state.model, file_ids: atts.map((a) => a.id) } });
      const c = state.chats.find((x) => x.id === id);
      if (c && c.title !== r.title) { c.title = r.title; if (id === state.activeId) el.title.textContent = r.title; }
      if (state.activeId === id) attachStream(id, row, r.status);
      loadChats();
    } catch (e) {
      markGenerating(id, false);
      row.querySelector('.bubble').innerHTML = `<p>${esc(e.message)}</p>`;
      row.querySelector('.orb') && S.setOrbState(row.querySelector('.orb'), 'idle');
      toast(e.message, 'error');
    }
  }

  async function stopGeneration() {
    if (state.activeId === null) return;
    try { await api(`/api/chats/${state.activeId}/stop`, { method: 'POST' }); } catch (e) { toast(e.message, 'error'); }
  }

  /* ================= composer ================= */
  function autosize() { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px'; }
  el.input.addEventListener('input', () => { autosize(); updateSend(); });
  el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!el.send.classList.contains('stop')) sendMessage(); } });
  el.input.addEventListener('paste', (e) => { const f = e.clipboardData?.files; if (f && f.length) { e.preventDefault(); handleFiles(f); } });
  el.send.addEventListener('click', () => (el.send.classList.contains('stop') ? stopGeneration() : sendMessage()));
  $('attachBtn').addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => { if (el.fileInput.files.length) handleFiles(el.fileInput.files); el.fileInput.value = ''; });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('dropzone').classList.add('show'); } });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropzone').classList.remove('show'); } });
  document.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('dropzone').classList.remove('show'); handleFiles(e.dataTransfer.files); });

  el.messages.addEventListener('scroll', () => { const m = el.messages; el.toBottom.classList.toggle('show', m.scrollHeight - m.scrollTop - m.clientHeight > 260); });
  el.toBottom.addEventListener('click', () => el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: 'smooth' }));

  el.thread.addEventListener('click', async (e) => {
    const sug = e.target.closest('.suggest');
    if (sug) { sendMessage(sug.dataset.prompt); return; }
    const cc = e.target.closest('[data-copy-code]'), cm = e.target.closest('[data-copy-msg]');
    if (cc || cm) {
      const text = cc ? cc.closest('.codeblock').querySelector('code').textContent : cm.closest('.msg')._raw;
      try { await navigator.clipboard.writeText(text); } catch { toast('Copy failed', 'error'); return; }
      const b = cc || cm, old = b.innerHTML; b.innerHTML = ic('check') + ' Copied';
      setTimeout(() => { b.innerHTML = old; }, 1400);
    }
  });

  /* ================= sidebar ================= */
  function setCollapsed(c) { el.app.classList.toggle('collapsed', c); S.store.set('collapsed', c); }
  function toggleSidebar() { mobile.matches ? el.app.classList.toggle('menu-open') : setCollapsed(!el.app.classList.contains('collapsed')); }
  function closeDrawer() { el.app.classList.remove('menu-open'); }
  mobile.addEventListener('change', closeDrawer);

  $('collapseBtn').addEventListener('click', toggleSidebar);
  $('openMenu').addEventListener('click', toggleSidebar);
  $('scrim').addEventListener('click', closeDrawer);
  $('logo').addEventListener('click', () => {
    if (!mobile.matches && el.app.classList.contains('collapsed')) { setCollapsed(false); return; }
    const o = $('logo').querySelector('.orb'); o.classList.remove('zap'); void o.offsetWidth; o.classList.add('zap');
    const r = o.getBoundingClientRect(); S.Cosmos.burst(r.left + r.width / 2, r.top + r.height / 2);
  });
  $('searchRow').addEventListener('click', () => {
    if (!mobile.matches && el.app.classList.contains('collapsed')) { setCollapsed(false); setTimeout(() => el.search.focus(), 440); }
  });
  el.search.addEventListener('input', () => { state.filter = el.search.value; renderChats(); });
  $('newChat').addEventListener('click', () => newChat().catch((e) => toast(e.message, 'error')));
  $('logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); S.Cosmos.warp(3); setTimeout(() => { location.href = '/login'; }, 350); });

  el.chatList.addEventListener('click', (e) => {
    const item = e.target.closest('.chat-item'); if (!item) return;
    const id = +item.dataset.id, act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'rename') return startRename(item);
    if (act === 'delete') return deleteChat(id).catch((x) => toast(x.message, 'error'));
    if (id !== state.activeId) openChat(id).catch((x) => toast(x.message, 'error')); else closeDrawer();
  });
  el.chatList.addEventListener('dblclick', (e) => { const item = e.target.closest('.chat-item'); if (item && !e.target.closest('.chat-actions')) startRename(item); });

  /* ================= popovers: model + more ================= */
  const pops = [[$('modelBtn'), $('modelPop')], [$('moreBtn'), $('morePop')], [$('createBtn'), $('createPop')]];
  function closePops(except) { pops.forEach(([b, p]) => { if (p !== except) { p.classList.remove('show'); b.setAttribute('aria-expanded', 'false'); } }); }
  pops.forEach(([b, p]) => b.addEventListener('click', (e) => { e.stopPropagation(); const open = !p.classList.contains('show'); closePops(p); p.classList.toggle('show', open); b.setAttribute('aria-expanded', String(open)); if (open && p === $('modelPop')) loadModels(); }));
  document.addEventListener('click', (e) => { if (!e.target.closest('.pop')) closePops(); });

  $('createPop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fill]'); if (!b) return;
    closePops(); el.input.value = b.dataset.fill; autosize(); updateSend(); el.input.focus();
    el.input.setSelectionRange(el.input.value.length, el.input.value.length);
  });

  async function loadModels() {
    try {
      const d = await api('/api/models');
      state.models = d.models; state.online = d.online;
      if (!state.model || !d.models.includes(state.model)) state.model = d.default;
    } catch { state.online = false; }
    renderModels();
  }
  function renderModels() {
    $('modelLabel').textContent = prettyModel(state.model);
    $('modelBtn').classList.toggle('offline', !state.online);
    $('modelPop').innerHTML = `<div class="pop-title"><span>Local models</span><span>${state.online ? 'Ollama online' : 'Ollama offline'}</span></div>` +
      (state.models.length ? state.models : [state.model]).map((m) => `<button class="pop-item ${m === state.model ? 'sel' : ''}" data-model="${esc(m)}">${ic('cpu')}${esc(prettyModel(m))}<span class="tick">${ic('check')}</span></button>`).join('');
  }
  $('modelPop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-model]'); if (!b) return;
    state.model = b.dataset.model; S.store.set('model', state.model); renderModels(); closePops(); toast(`Using ${prettyModel(state.model)}`);
  });

  $('morePop').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    closePops();
    const id = state.activeId; if (id === null) return;
    if (act === 'export') {
      const rows = [...el.thread.querySelectorAll('.msg')];
      if (!rows.length) { toast('Nothing to export yet'); return; }
      const title = el.title.textContent;
      const md = `# ${title}\n\n` + rows.map((r) => `**${r.dataset.role === 'user' ? 'You' : 'Studiora'}:**\n\n${r._raw}\n`).join('\n---\n\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' })); a.download = title.replace(/[^\w\-]+/g, '_') + '.md'; a.click(); URL.revokeObjectURL(a.href);
      toast('Chat exported', 'ok');
    } else if (act === 'clear') {
      if (state.generating.has(id)) { toast('Stop the current answer first'); return; }
      if (!(await confirmBox('Clear messages?', 'This removes the messages in this chat. Your files are kept.', 'Clear', false))) return;
      try { await api(`/api/chats/${id}/messages`, { method: 'DELETE' }); showWelcome(); refreshStats(); toast('Messages cleared', 'ok'); } catch (x) { toast(x.message, 'error'); }
    } else if (act === 'delete') deleteChat(id).catch((x) => toast(x.message, 'error'));
  });

  /* ================= settings ================= */
  function syncSwitches() { $('swCosmos').setAttribute('aria-checked', String(S.prefs.cosmos)); $('swCalm').setAttribute('aria-checked', String(S.prefs.calm)); }
  $('settingsBtn').addEventListener('click', () => { syncSwitches(); $('settingsBack').classList.add('show'); closeDrawer(); });
  $('swCosmos').addEventListener('click', () => { S.setPref('cosmos', !S.prefs.cosmos); syncSwitches(); });
  $('swCalm').addEventListener('click', () => { S.setPref('calm', !S.prefs.calm); syncSwitches(); });
  $('settingsClose').addEventListener('click', () => $('settingsBack').classList.remove('show'));
  $('settingsBack').addEventListener('click', (e) => { if (e.target.id === 'settingsBack') $('settingsBack').classList.remove('show'); });

  /* ================= keyboard + touch ================= */
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); }
    else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
    else if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); el.input.focus(); }
    else if (e.key === 'Escape') { closePops(); closeDrawer(); $('settingsBack').classList.remove('show'); }
  });
  let sx = 0, sy = 0, track = false;
  document.addEventListener('touchstart', (e) => { if (!mobile.matches) return; const t = e.touches[0]; sx = t.clientX; sy = t.clientY; track = el.app.classList.contains('menu-open') || sx < 24; }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!track) return; track = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
    if (dy > 60 || Math.abs(dx) < 70) return;
    dx > 0 ? el.app.classList.add('menu-open') : closeDrawer();
  }, { passive: true });

  // keep sidebar spinners honest while answers run in other chats
  setInterval(() => { if (state.generating.size && !document.hidden) loadChats().catch(() => {}); }, 2500);

  /* ================= boot ================= */
  (async function boot() {
    if (!mobile.matches && S.store.get('collapsed', false)) el.app.classList.add('collapsed');
    try {
      const me = await api('/api/auth/me');
      state.user = me.display_name || me.username;
      $('userName').textContent = state.user;
      $('avatar').textContent = (state.user[0] || 'S').toUpperCase();
      await Promise.all([loadChats(), loadModels(), refreshStats()]);
      const saved = +S.store.get('active', 0);
      if (state.chats.some((c) => c.id === saved)) await openChat(saved);
      else if (state.chats.length) await openChat(state.chats[0].id);
      else await newChat();
    } catch (e) { toast(e.message, 'error'); }
    await S.Splash.ready();
    S.Splash.hide().then(() => { if (!mobile.matches) el.input.focus(); });
  })();
})();
