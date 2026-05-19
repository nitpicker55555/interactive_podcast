/* =============================================================
   Interactive Podcast — frontend logic
   ============================================================= */
'use strict';

const state = {
  taskId: null,
  manifest: null,
  currentPersonKey: null,
  // per-person caches
  pageCaches: {},          // { personKey: Map(file -> html) }
  currentPageFiles: {},    // { personKey: file }
  chatHTMLs: {},           // { personKey: innerHTML snapshot }
  researchEventSource: null,
  chatEventSource: null,
  replayMode: false,
  activeTypewriter: null,
};

const el = {
  // landing
  viewLanding: document.getElementById('view-landing'),
  viewWorkspace: document.getElementById('view-workspace'),
  form: document.getElementById('research-form'),
  urlInput: document.getElementById('url-input'),
  startBtn: document.getElementById('start-btn'),
  heroHint: document.getElementById('hero-hint'),
  // workspace
  backBtn: document.getElementById('back-btn'),
  wsUrl: document.getElementById('ws-url'),
  wsStatus: document.getElementById('ws-status'),
  wsStatusText: document.querySelector('#ws-status .status-text'),
  researchPanel: document.getElementById('research-panel'),
  stepList: document.getElementById('step-list'),
  reasoningFeed: document.getElementById('reasoning-feed'),
  // profile
  profileCard: document.getElementById('profile-card'),
  personSwitcher: document.getElementById('person-switcher'),
  profileAvatar: document.getElementById('profile-avatar'),
  profileRoleBadge: document.getElementById('profile-role-badge'),
  profileName: document.getElementById('profile-name'),
  profileTitle: document.getElementById('profile-title'),
  profileCompany: document.getElementById('profile-company'),
  profileOneliner: document.getElementById('profile-oneliner'),
  profileSocials: document.getElementById('profile-socials'),
  pageTabs: document.getElementById('page-tabs'),
  pageContent: document.getElementById('page-content'),
  // chat
  wsRight: document.getElementById('ws-right'),
  chatWithName: document.getElementById('chat-with-name'),
  chatSub: document.getElementById('chat-sub'),
  chatMessages: document.getElementById('chat-messages'),
  chatEmpty: document.getElementById('chat-empty'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatSend: document.getElementById('chat-send'),
  chatClose: document.getElementById('chat-close'),
  mobileChatToggle: document.getElementById('mobile-chat-toggle'),
};

/* ---------- helpers ---------- */
function $(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function switchView(name) {
  el.viewLanding.classList.toggle('is-visible', name === 'landing');
  el.viewWorkspace.classList.toggle('is-visible', name === 'workspace');
}

function setStatus(text, kind) {
  el.wsStatusText.textContent = text;
  el.wsStatus.classList.remove('is-research', 'is-done', 'is-error');
  if (kind === 'research') el.wsStatus.classList.add('is-research');
  else if (kind === 'done') el.wsStatus.classList.add('is-done');
  else if (kind === 'error') el.wsStatus.classList.add('is-error');
}

function resetWorkspace() {
  el.stepList.innerHTML = '';
  el.reasoningFeed.innerHTML = '';
  el.profileCard.hidden = true;
  el.profileSocials.innerHTML = '';
  el.personSwitcher.innerHTML = '';
  el.pageTabs.innerHTML = '';
  el.pageContent.innerHTML = '';
  el.pageContent.classList.remove('is-visible', 'is-leaving');
  el.researchPanel.classList.remove('is-collapsed', 'is-open');
  el.chatMessages.innerHTML = '';
  el.chatMessages.appendChild(el.chatEmpty);
  el.chatEmpty.style.display = '';
  setChatEnabled(false);
  el.chatInput.placeholder = '调研完成后开始对话…';
  el.mobileChatToggle.classList.remove('is-visible');
  el.wsRight.classList.remove('is-open');
  state.manifest = null;
  state.currentPersonKey = null;
  state.pageCaches = {};
  state.currentPageFiles = {};
  state.chatHTMLs = {};
  stepNodes.clear();
  if (state.activeTypewriter) { state.activeTypewriter.cancel = true; state.activeTypewriter = null; }
}

function setChatEnabled(on) {
  if (on) {
    el.chatInput.removeAttribute('disabled');
    el.chatSend.removeAttribute('disabled');
    el.chatInput.readOnly = false;
  } else {
    el.chatInput.setAttribute('disabled', '');
    el.chatSend.setAttribute('disabled', '');
  }
}

/* ---------- typewriter ---------- */
function typewriter(element, text, opts = {}) {
  const minDuration = opts.minDuration ?? 240;
  const maxDuration = opts.maxDuration ?? 1800;
  const charsPerSec = opts.charsPerSec ?? 90;
  const idealMs = (text.length / charsPerSec) * 1000;
  const totalMs = Math.min(maxDuration, Math.max(minDuration, idealMs));
  const handle = { cancel: false };
  if (state.activeTypewriter) state.activeTypewriter.cancel = true;
  state.activeTypewriter = handle;
  element.classList.add('is-typing');
  element.textContent = '';
  const start = performance.now();
  return new Promise(resolve => {
    function frame(now) {
      if (handle.cancel) {
        element.textContent = text;
        element.classList.remove('is-typing');
        resolve();
        return;
      }
      const progress = Math.min(1, (now - start) / totalMs);
      element.textContent = text.slice(0, Math.floor(text.length * progress));
      if (progress >= 1) {
        element.textContent = text;
        element.classList.remove('is-typing');
        if (state.activeTypewriter === handle) state.activeTypewriter = null;
        resolve();
      } else {
        requestAnimationFrame(frame);
      }
    }
    requestAnimationFrame(frame);
  });
}

/* ---------- start research ---------- */
async function startResearch(url) {
  resetWorkspace();
  el.wsUrl.textContent = url;
  switchView('workspace');
  setStatus('启动调研中…', 'research');
  try {
    const resp = await fetch('/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    const { task_id } = await resp.json();
    state.taskId = task_id;
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', `/?task=${task_id}`);
    }
    openResearchStream(task_id);
  } catch (err) {
    setStatus('启动失败', 'error');
    showError(`无法启动调研：${err.message}`);
  }
}

function openResearchStream(taskId) {
  if (state.researchEventSource) state.researchEventSource.close();
  const es = new EventSource(`/api/stream/${taskId}`);
  state.researchEventSource = es;
  state.replayMode = true;
  setTimeout(() => { state.replayMode = false; }, 800);
  es.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    handleResearchEvent(data);
  };
}

/* ---------- research event handlers ---------- */
const stepNodes = new Map();

function handleResearchEvent(event) {
  if (!event || !event.kind) return;
  switch (event.kind) {
    case 'snapshot':
      if (event.status === 'researching') setStatus('正在调研', 'research');
      else if (event.status === 'done') setStatus('调研完成', 'done');
      else if (event.status === 'pending') setStatus('启动中…', 'research');
      return;
    case 'thread': case 'turn': case 'usage': case 'note': return;
    case 'step': renderStep(event); return;
    case 'message':
      if (event.status === 'completed' && event.text) renderMessageBlock(event.text, 'message');
      return;
    case 'error':
      showError(event.text || '调研过程出错');
      setStatus('出错', 'error');
      return;
    case 'final': finalizeResearch(event); return;
    case 'raw': return;
  }
}

function renderStep(event) {
  const key = stepKey(event);
  let node = stepNodes.get(key);
  const isActive = event.status === 'started';
  const isDone = event.status === 'completed';
  if (!node) {
    node = $('li', { className: 'step-item' });
    node.appendChild($('span', { className: 'step-icon', text: '·' }));
    node.appendChild($('div', { className: 'step-body' }));
    el.stepList.appendChild(node);
    stepNodes.set(key, node);
  }
  const icon = node.querySelector('.step-icon');
  const body = node.querySelector('.step-body');
  body.innerHTML = '';
  if (event.subkind === 'web_search') {
    icon.textContent = isDone ? '✓' : '◆';
    body.appendChild($('div', { className: 'step-label', text: '网络搜索' }));
    body.appendChild($('div', { className: 'step-text', text: event.query || '(无 query)' }));
  } else if (event.subkind === 'mcp') {
    icon.textContent = isDone ? '✓' : '◆';
    body.appendChild($('div', { className: 'step-label', text: event.tool || 'MCP 工具' }));
    if (event.args_summary) body.appendChild($('div', { className: 'step-text mono', text: event.args_summary }));
  } else if (event.subkind === 'shell') {
    icon.textContent = isDone ? '✓' : '◆';
    body.appendChild($('div', { className: 'step-label', text: '执行命令' }));
    body.appendChild($('div', { className: 'step-text mono', text: event.command || '' }));
  } else if (event.subkind === 'reasoning') {
    if (isDone && event.text) {
      stepNodes.delete(key); node.remove();
      renderMessageBlock(event.text, 'reasoning');
      return;
    }
    icon.textContent = '·';
    body.appendChild($('div', { className: 'step-label', text: '思考中' }));
  } else {
    icon.textContent = isDone ? '✓' : '·';
    body.appendChild($('div', { className: 'step-label', text: event.subkind || 'step' }));
  }
  node.classList.toggle('is-active', isActive);
  node.classList.toggle('is-done', isDone);
  scrollLeftPaneIfPinned();
}

function stepKey(event) {
  if (event.subkind === 'web_search') return `ws:${event.query || ''}`;
  if (event.subkind === 'mcp') return `mcp:${event.tool}:${event.args_summary}`;
  if (event.subkind === 'shell') return `sh:${event.command || ''}`;
  if (event.subkind === 'reasoning') return `rs:${Math.random()}`;
  return `${event.subkind}:${Math.random()}`;
}

function renderMessageBlock(text, kind) {
  const textNode = $('div', { className: 'thought-block-text' });
  const block = $('div', { className: `thought-block is-${kind}` }, [textNode]);
  el.reasoningFeed.appendChild(block);
  if (state.replayMode || kind === 'reasoning') {
    textNode.textContent = text;
  } else {
    typewriter(textNode, text);
  }
  scrollLeftPaneIfPinned();
}

function scrollLeftPaneIfPinned() {
  if (el.researchPanel.classList.contains('is-collapsed')) return;
  const wsLeft = document.getElementById('ws-left');
  if (!wsLeft) return;
  const nearBottom = wsLeft.scrollHeight - wsLeft.scrollTop - wsLeft.clientHeight < 160;
  if (nearBottom) wsLeft.scrollTop = wsLeft.scrollHeight;
}

function finalizeResearch(event) {
  if (state.researchEventSource) { state.researchEventSource.close(); state.researchEventSource = null; }
  if (event.status === 'error') {
    setStatus('调研失败', 'error');
    if (event.error) showError(event.error);
    return;
  }
  if (event.status !== 'done') { setStatus('已结束', 'pending'); return; }
  setStatus('调研完成', 'done');
  fetchAndRenderManifest();
}

async function fetchAndRenderManifest() {
  try {
    const resp = await fetch(`/api/result/${state.taskId}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const manifest = data.manifest;
    if (!manifest || !manifest.people) {
      showError(data.error || '未能解析人物档案。');
      return;
    }
    state.manifest = manifest;
    // Pick initial person: ?person= param, else primary_key, else first
    const params = new URLSearchParams(location.search);
    const personParam = params.get('person');
    const primary = manifest.primary_key || Object.keys(manifest.people)[0];
    const personKeys = Object.keys(manifest.people);
    const initialPerson = (personParam && personKeys.includes(personParam)) ? personParam : primary;

    renderPersonSwitcher(manifest);
    await switchToPerson(initialPerson);

    el.profileCard.hidden = false;
    el.researchPanel.classList.add('is-collapsed');
    const title = el.researchPanel.querySelector('.panel-title');
    if (title && !title._toggleBound) {
      title.addEventListener('click', () => el.researchPanel.classList.toggle('is-open'));
      title._toggleBound = true;
    }
    const wsLeft = document.getElementById('ws-left');
    if (wsLeft) wsLeft.scrollTop = 0;
  } catch (err) {
    showError(`无法获取调研结果：${err.message}`);
  }
}

/* ---------- person switcher ---------- */
function personDisplayName(person) {
  return person.name || person.name_en || (person.role === 'host' ? '主持人' : '嘉宾');
}

function personRoleLabel(person) {
  return person.role === 'host' ? '主持人' : '嘉宾';
}

function renderPersonSwitcher(manifest) {
  el.personSwitcher.innerHTML = '';
  const people = manifest.people;
  const keys = Object.keys(people);
  if (keys.length <= 1) return; // single person: no switcher needed
  for (const key of keys) {
    const person = people[key];
    const tab = $('button', {
      className: 'person-tab',
      type: 'button',
      role: 'tab',
      'data-person': key,
    });
    const avatar = $('span', { className: 'person-tab-avatar' });
    if (person.avatar) {
      const img = $('img', {
        src: `/api/asset/${state.taskId}/${key}/${encodeURIComponent(person.avatar)}`,
        alt: personDisplayName(person),
      });
      img.addEventListener('error', () => {
        avatar.innerHTML = '';
        avatar.textContent = initial(personDisplayName(person));
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = initial(personDisplayName(person));
    }
    const txt = $('div', { className: 'person-tab-text' }, [
      $('div', { className: 'person-tab-role', text: personRoleLabel(person) }),
      $('div', { className: 'person-tab-name', text: personDisplayName(person) }),
    ]);
    tab.appendChild(avatar);
    tab.appendChild(txt);
    tab.addEventListener('click', () => {
      if (state.currentPersonKey !== key) switchToPerson(key);
    });
    el.personSwitcher.appendChild(tab);
  }
}

async function switchToPerson(personKey) {
  if (!state.manifest || !state.manifest.people[personKey]) return;
  const prev = state.currentPersonKey;
  if (prev === personKey) return;

  // If a chat stream is in flight for the previous person, close it. The
  // partial reply gets snapshotted with whatever text has arrived so far.
  if (state.chatEventSource) {
    state.chatEventSource.close();
    state.chatEventSource = null;
  }
  // Save current chat for prev person
  if (prev) {
    state.chatHTMLs[prev] = el.chatMessages.innerHTML;
  }

  state.currentPersonKey = personKey;
  for (const tab of el.personSwitcher.querySelectorAll('.person-tab')) {
    tab.classList.toggle('is-active', tab.getAttribute('data-person') === personKey);
  }

  const person = state.manifest.people[personKey];
  renderProfileHeader(person, personKey);

  // Render this person's tabs + content
  renderPageTabs(person.pages || []);
  const params = new URLSearchParams(location.search);
  let initialFile = state.currentPageFiles[personKey];
  if (!initialFile) {
    const tabParam = parseInt(params.get('tab') || '', 10);
    const pages = person.pages || [];
    const idx = Number.isFinite(tabParam) && tabParam >= 0 && tabParam < pages.length ? tabParam : 0;
    initialFile = pages[idx] && pages[idx].file;
  }
  if (initialFile) {
    state.currentPageFiles[personKey] = null;  // force re-load animation
    await switchTab(initialFile);
  }

  // Restore (or initialize) chat for new person
  if (state.chatHTMLs[personKey]) {
    el.chatMessages.innerHTML = state.chatHTMLs[personKey];
  } else {
    el.chatMessages.innerHTML = '';
    el.chatMessages.appendChild(el.chatEmpty);
    el.chatEmpty.style.display = '';
  }
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;

  enableChat(person);
  // Update URL so refresh keeps state
  if (window.history && window.history.replaceState) {
    const u = new URL(location.href);
    u.searchParams.set('person', personKey);
    window.history.replaceState(null, '', u.pathname + u.search);
  }
}

function renderProfileHeader(person, personKey) {
  el.profileAvatar.innerHTML = '';
  if (person.avatar) {
    const img = $('img', {
      src: `/api/asset/${state.taskId}/${personKey}/${encodeURIComponent(person.avatar)}`,
      alt: personDisplayName(person),
    });
    img.addEventListener('error', () => {
      el.profileAvatar.innerHTML = '';
      el.profileAvatar.appendChild($('span', { className: 'avatar-fallback', text: initial(personDisplayName(person)) }));
    });
    el.profileAvatar.appendChild(img);
  } else {
    el.profileAvatar.appendChild($('span', { className: 'avatar-fallback', text: initial(personDisplayName(person)) }));
  }

  el.profileRoleBadge.textContent = personRoleLabel(person);

  const primaryName = person.name || person.name_en || '（未识别）';
  el.profileName.textContent = primaryName;
  if (person.name && person.name_en && person.name_en !== person.name) {
    const sub = document.createElement('span');
    sub.style.cssText = 'color: var(--text-faint); font-size: 0.55em; font-family: var(--font-sans); margin-left: 12px; font-weight: 400;';
    sub.textContent = person.name_en;
    el.profileName.appendChild(sub);
  }
  el.profileTitle.textContent = person.title || '';
  el.profileCompany.textContent = person.company || '';
  el.profileOneliner.textContent = person.one_liner || '';

  el.profileSocials.innerHTML = '';
  const social = person.social || {};
  const order = [
    ['personal_site', '个人网站'],
    ['twitter', 'X / Twitter'],
    ['linkedin', 'LinkedIn'],
    ['scholar', 'Google Scholar'],
    ['github', 'GitHub'],
    ['substack', 'Substack'],
    ['zhihu', '知乎'],
    ['weibo', '微博'],
  ];
  for (const [k, label] of order) {
    const url = social[k];
    if (url && typeof url === 'string') {
      el.profileSocials.appendChild(
        $('a', { className: 'social-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: label })
      );
    }
  }
}

function renderPageTabs(pages) {
  el.pageTabs.innerHTML = '';
  pages.forEach((page, idx) => {
    const btn = $('button', {
      className: 'page-tab',
      role: 'tab',
      type: 'button',
      text: page.title || `第 ${idx + 1} 页`,
      'data-file': page.file,
    });
    btn.addEventListener('click', () => switchTab(page.file));
    el.pageTabs.appendChild(btn);
  });
}

async function switchTab(file) {
  const personKey = state.currentPersonKey;
  if (!file || !personKey || file === state.currentPageFiles[personKey]) return;
  state.currentPageFiles[personKey] = file;

  for (const tab of el.pageTabs.querySelectorAll('.page-tab')) {
    tab.classList.toggle('is-active', tab.getAttribute('data-file') === file);
  }

  el.pageContent.classList.add('is-leaving');
  el.pageContent.classList.remove('is-visible');
  await wait(140);

  const cache = state.pageCaches[personKey] || (state.pageCaches[personKey] = new Map());
  let html = cache.get(file);
  if (!html) {
    try {
      const resp = await fetch(`/api/page/${state.taskId}/${personKey}/${encodeURIComponent(file)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const md = await resp.text();
      html = renderMarkdown(md);
      cache.set(file, html);
    } catch (err) {
      html = `<p style="color: var(--error);">加载页面失败：${escapeHtml(err.message)}</p>`;
    }
  }

  // Only update if still on this person/file (avoid race when user clicks fast)
  if (state.currentPersonKey === personKey && state.currentPageFiles[personKey] === file) {
    el.pageContent.innerHTML = html;
    el.pageContent.classList.remove('is-leaving');
    requestAnimationFrame(() => el.pageContent.classList.add('is-visible'));
  }
}

function renderMarkdown(md) {
  if (typeof window.marked !== 'undefined') {
    window.marked.setOptions({ breaks: true, gfm: true });
    return window.marked.parse(md);
  }
  return `<pre>${escapeHtml(md)}</pre>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function initial(name) {
  if (!name) return '·';
  const s = String(name).trim();
  return s ? s[0] : '·';
}

/* ---------- chat ---------- */
function enableChat(person) {
  const name = personDisplayName(person);
  const role = personRoleLabel(person);
  el.chatWithName.textContent = `与 ${name}（${role}）对话`;
  el.chatSub.textContent = `Codex agent 以 ${name} 的口吻回应`;
  el.chatInput.placeholder = `直接对 ${name} 说点什么…`;
  setChatEnabled(true);
  el.mobileChatToggle.classList.add('is-visible');
  const label = el.mobileChatToggle.querySelector('.chat-toggle-label');
  if (label) label.textContent = `与 ${name} 对话`;
}

function appendChatMessage(role, text) {
  if (el.chatEmpty.parentNode === el.chatMessages) {
    el.chatMessages.removeChild(el.chatEmpty);
  }
  const wrap = $('div', { className: `chat-msg is-${role}` });
  const bubble = $('div', { className: 'chat-msg-bubble' });
  bubble.textContent = text;
  wrap.appendChild(bubble);
  el.chatMessages.appendChild(wrap);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  return bubble;
}

function appendTypingBubble() {
  if (el.chatEmpty.parentNode === el.chatMessages) {
    el.chatMessages.removeChild(el.chatEmpty);
  }
  const wrap = $('div', { className: 'chat-msg is-agent' });
  const bubble = $('div', { className: 'chat-msg-bubble' });
  bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  const statusLine = $('div', { className: 'chat-msg-status', text: '思考中…' });
  wrap.appendChild(bubble);
  wrap.appendChild(statusLine);
  el.chatMessages.appendChild(wrap);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  return { bubble, statusLine, wrap };
}

async function sendChatMessage(message) {
  if (!state.taskId || !state.currentPersonKey) return;
  const personKey = state.currentPersonKey;
  appendChatMessage('user', message);
  const { bubble: typingBubble, statusLine } = appendTypingBubble();
  el.chatInput.value = '';
  autoSizeInput();
  setChatEnabled(false);
  try {
    const resp = await fetch(`/api/chat/${state.taskId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, person: personKey }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    const { turn_id } = await resp.json();
    openChatStream(turn_id, typingBubble, statusLine, personKey);
  } catch (err) {
    typingBubble.textContent = `（出错：${err.message}）`;
    if (statusLine && statusLine.parentNode) statusLine.remove();
    setChatEnabled(true);
  }
}

function openChatStream(turnId, typingBubble, statusLine, personKey) {
  if (state.chatEventSource) state.chatEventSource.close();
  const es = new EventSource(`/api/chat/stream/${turnId}`);
  state.chatEventSource = es;
  let gotAnyText = false;
  let accumulated = '';
  function ensureCleanBubble() {
    if (!gotAnyText) {
      typingBubble.innerHTML = '';
      typingBubble.classList.add('is-typing');
      if (statusLine && statusLine.parentNode) statusLine.remove();
    }
  }
  es.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (!data || !data.kind) return;
    if (data.kind === 'delta' && data.text) {
      ensureCleanBubble();
      accumulated += data.text;
      typingBubble.textContent = accumulated;
      gotAnyText = true;
      // Only scroll if we're still on this person's chat
      if (state.currentPersonKey === personKey) el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    } else if (data.kind === 'message' && data.status === 'completed' && data.text) {
      ensureCleanBubble();
      if (data.text !== accumulated) typingBubble.textContent = data.text;
      gotAnyText = true;
    } else if (data.kind === 'error') {
      ensureCleanBubble();
      typingBubble.textContent = `（出错：${data.text || '未知错误'}）`;
    } else if (data.kind === 'final') {
      es.close();
      state.chatEventSource = null;
      typingBubble.classList.remove('is-typing');
      if (!gotAnyText) {
        typingBubble.textContent = data.error ? `（出错：${data.error}）` : '（没有收到回复）';
        if (statusLine && statusLine.parentNode) statusLine.remove();
      }
      // Save snapshot for this person
      if (state.currentPersonKey === personKey) {
        setChatEnabled(true);
        el.chatInput.focus();
      } else {
        // user switched away; snapshot was already saved on switch
        state.chatHTMLs[personKey] = state.chatHTMLs[personKey] || '';
      }
    }
  };
  es.onerror = () => {
    setTimeout(() => {
      if (state.chatEventSource === es && es.readyState === EventSource.CLOSED) {
        typingBubble.classList.remove('is-typing');
        if (!gotAnyText) {
          typingBubble.textContent = '（连接中断）';
          if (statusLine && statusLine.parentNode) statusLine.remove();
        }
        if (state.currentPersonKey === personKey) setChatEnabled(true);
      }
    }, 2000);
  };
}

function autoSizeInput() {
  const ta = el.chatInput;
  ta.style.height = 'auto';
  ta.style.height = Math.min(140, Math.max(42, ta.scrollHeight)) + 'px';
}

/* ---------- errors ---------- */
function showError(message) {
  const existing = el.researchPanel.querySelector('.error-banner');
  if (existing) existing.remove();
  const banner = $('div', { className: 'error-banner', text: message });
  el.researchPanel.insertBefore(banner, el.researchPanel.firstChild);
}

/* ---------- mobile chat drawer ---------- */
function openMobileChat() {
  el.wsRight.classList.add('is-open');
  setTimeout(() => el.chatInput.focus(), 240);
}
function closeMobileChat() { el.wsRight.classList.remove('is-open'); }

/* ---------- bindings ---------- */
el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = el.urlInput.value.trim();
  if (!url) return;
  startResearch(url);
});

el.backBtn.addEventListener('click', () => {
  if (state.researchEventSource) state.researchEventSource.close();
  if (state.chatEventSource) state.chatEventSource.close();
  state.researchEventSource = null;
  state.chatEventSource = null;
  state.taskId = null;
  resetWorkspace();
  switchView('landing');
  if (window.history && window.history.replaceState) window.history.replaceState(null, '', '/');
});

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = el.chatInput.value.trim();
  if (!message || el.chatInput.hasAttribute('disabled')) return;
  sendChatMessage(message);
});

el.chatInput.addEventListener('input', autoSizeInput);
el.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el.chatForm.requestSubmit();
  }
});

el.mobileChatToggle.addEventListener('click', openMobileChat);
el.chatClose.addEventListener('click', closeMobileChat);

/* ---------- deep-link ---------- */
(function deepLink() {
  const params = new URLSearchParams(location.search);
  const taskParam = params.get('task');
  const urlParam = params.get('url');
  if (taskParam) {
    state.taskId = taskParam;
    el.wsUrl.textContent = '(载入中…)';
    switchView('workspace');
    setStatus('加载中…', 'research');
    fetch(`/api/result/${taskParam}`).then(r => r.json()).then(d => {
      if (d.url) el.wsUrl.textContent = d.url;
    }).catch(() => {});
    openResearchStream(taskParam);
  } else if (urlParam) {
    el.urlInput.value = urlParam;
    startResearch(urlParam);
  }
})();
