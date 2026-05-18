/* =============================================================
   Interactive Podcast — frontend logic
   ============================================================= */
'use strict';

const state = {
  taskId: null,
  profile: null,
  researchEventSource: null,
  chatEventSource: null,
  currentChatTurnId: null,
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
  profileAvatar: document.getElementById('profile-avatar'),
  avatarFallback: document.getElementById('avatar-fallback'),
  profileName: document.getElementById('profile-name'),
  profileTitle: document.getElementById('profile-title'),
  profileCompany: document.getElementById('profile-company'),
  profileBio: document.getElementById('profile-bio'),
  profileSocials: document.getElementById('profile-socials'),
  perspectivesSection: document.getElementById('section-perspectives'),
  perspectivesList: document.getElementById('perspectives-list'),
  papersSection: document.getElementById('section-papers'),
  papersList: document.getElementById('papers-list'),
  newsSection: document.getElementById('section-news'),
  newsList: document.getElementById('news-list'),
  episodeSection: document.getElementById('section-episode'),
  episodeBlock: document.getElementById('episode-block'),
  // chat
  chatWithName: document.getElementById('chat-with-name'),
  chatSub: document.getElementById('chat-sub'),
  chatMessages: document.getElementById('chat-messages'),
  chatEmpty: document.getElementById('chat-empty'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatSend: document.getElementById('chat-send'),
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

function setStatus(text, kind /* 'pending'|'research'|'done'|'error' */) {
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
  el.researchPanel.classList.remove('is-collapsed', 'is-open');
  el.chatMessages.innerHTML = '';
  el.chatMessages.appendChild(el.chatEmpty);
  el.chatEmpty.style.display = '';
  el.chatInput.disabled = true;
  el.chatSend.disabled = true;
  el.chatInput.placeholder = '调研完成后开始对话…';
  state.profile = null;
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

  es.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    handleResearchEvent(data);
  };

  es.onerror = () => {
    if (state.researchEventSource === es) {
      // EventSource auto-reconnects; only treat as fatal if we have no profile after a while
    }
  };
}

/* ---------- event handlers (research stream) ---------- */
const stepNodes = new Map(); // key -> li node

function handleResearchEvent(event) {
  if (!event || !event.kind) return;
  switch (event.kind) {
    case 'snapshot':
      if (event.status === 'researching') setStatus('正在调研', 'research');
      return;
    case 'thread':
      // ignore
      return;
    case 'turn':
      return;
    case 'step':
      renderStep(event);
      return;
    case 'message':
      if (event.status === 'completed' && event.text) {
        renderMessageBlock(event.text, 'message');
      }
      return;
    case 'usage':
      return;
    case 'note':
      return;
    case 'error':
      showError(event.text || '调研过程出错');
      setStatus('出错', 'error');
      return;
    case 'final':
      finalizeResearch(event);
      return;
    case 'raw':
      // hide unknown raw events to keep UI clean
      return;
  }
}

function renderStep(event) {
  const key = stepKey(event);
  let node = stepNodes.get(key);

  const isActive = event.status === 'started';
  const isDone = event.status === 'completed';

  if (!node) {
    node = $('li', { className: 'step-item' });
    const icon = $('span', { className: 'step-icon', text: '·' });
    const body = $('div', { className: 'step-body' });
    node.appendChild(icon);
    node.appendChild(body);
    el.stepList.appendChild(node);
    stepNodes.set(key, node);
  }

  const icon = node.querySelector('.step-icon');
  const body = node.querySelector('.step-body');
  body.innerHTML = '';

  if (event.subkind === 'web_search') {
    icon.textContent = isDone ? '✓' : '◯';
    body.appendChild($('div', { className: 'step-label', text: '网络搜索' }));
    body.appendChild($('div', { className: 'step-text', text: event.query || '(无 query)' }));
  } else if (event.subkind === 'shell') {
    icon.textContent = isDone ? '✓' : '◯';
    body.appendChild($('div', { className: 'step-label', text: '执行命令' }));
    body.appendChild($('div', { className: 'step-text mono', text: event.command || '' }));
  } else if (event.subkind === 'reasoning') {
    if (isDone && event.text) {
      // reasoning blocks go into the reasoning feed instead
      stepNodes.delete(key);
      node.remove();
      renderMessageBlock(event.text, 'reasoning');
      return;
    }
    // otherwise show a transient line in the step list
    icon.textContent = '·';
    body.appendChild($('div', { className: 'step-label', text: '思考中' }));
  } else {
    icon.textContent = isDone ? '✓' : '◯';
    body.appendChild($('div', { className: 'step-label', text: event.subkind || 'step' }));
  }

  node.classList.toggle('is-active', isActive);
  node.classList.toggle('is-done', isDone);

  // auto-scroll
  el.researchPanel.scrollIntoView({ behavior: 'instant', block: 'nearest' });
}

function stepKey(event) {
  if (event.subkind === 'web_search') return `ws:${event.query || ''}`;
  if (event.subkind === 'shell') return `sh:${event.command || ''}`;
  if (event.subkind === 'reasoning') return `rs:${Math.random()}`;
  return `${event.subkind}:${Math.random()}`;
}

function renderMessageBlock(text, kind /* 'message' | 'reasoning' */) {
  const block = $('div', {
    className: `thought-block is-${kind}`,
  }, [
    $('div', { className: 'thought-block-text', text }),
  ]);
  el.reasoningFeed.appendChild(block);
  block.scrollIntoView({ behavior: 'instant', block: 'nearest' });
}

function finalizeResearch(event) {
  if (state.researchEventSource) {
    state.researchEventSource.close();
    state.researchEventSource = null;
  }
  if (event.status === 'error') {
    setStatus('调研失败', 'error');
    if (event.error) showError(event.error);
    return;
  }
  if (event.status !== 'done') {
    setStatus('已结束', 'pending');
    return;
  }
  setStatus('调研完成', 'done');
  fetchAndRenderProfile();
}

async function fetchAndRenderProfile() {
  try {
    const resp = await fetch(`/api/result/${state.taskId}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.profile) {
      showError('未能解析人物档案。');
      return;
    }
    state.profile = data.profile;
    renderProfile(data.profile);
    enableChat(data.profile);
    // collapse research panel
    el.researchPanel.classList.add('is-collapsed');
    const title = el.researchPanel.querySelector('.panel-title');
    title.addEventListener('click', () => el.researchPanel.classList.toggle('is-open'));
  } catch (err) {
    showError(`无法获取调研结果：${err.message}`);
  }
}

/* ---------- profile rendering ---------- */
function renderProfile(p) {
  el.profileCard.hidden = false;

  // avatar
  if (p.avatar_url) {
    el.profileAvatar.innerHTML = '';
    const img = $('img', { src: p.avatar_url, alt: p.name || 'avatar', referrerpolicy: 'no-referrer', loading: 'lazy' });
    img.onerror = () => {
      el.profileAvatar.innerHTML = '';
      const fb = $('span', { className: 'avatar-fallback', text: initial(p.name) });
      el.profileAvatar.appendChild(fb);
    };
    el.profileAvatar.appendChild(img);
  } else {
    el.profileAvatar.innerHTML = '';
    el.profileAvatar.appendChild($('span', { className: 'avatar-fallback', text: initial(p.name) }));
  }

  el.profileName.textContent = p.name || '（未识别）';
  if (p.name_en && p.name_en !== p.name) {
    el.profileName.textContent += `  ${p.name_en}`;
  }
  el.profileTitle.textContent = p.title || '';
  el.profileCompany.textContent = p.company || '';
  el.profileBio.textContent = p.bio_long || p.bio_short || '';

  // socials
  el.profileSocials.innerHTML = '';
  const social = p.social || {};
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
  for (const [key, label] of order) {
    const url = social[key];
    if (url && typeof url === 'string') {
      el.profileSocials.appendChild(
        $('a', { className: 'social-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: label })
      );
    }
  }

  // perspectives
  renderListSection(el.perspectivesSection, el.perspectivesList, p.key_perspectives || [], (x) => {
    return $('li', {}, [$('div', { className: 'list-row-title', text: x })]);
  });

  // papers
  renderListSection(el.papersSection, el.papersList, p.papers || [], (x) => {
    const titleNode = x.url
      ? $('a', { className: 'list-row-title', href: x.url, target: '_blank', rel: 'noopener noreferrer', text: x.title || '(无标题)' })
      : $('div', { className: 'list-row-title', text: x.title || '(无标题)' });
    const meta = [x.venue, x.year].filter(Boolean).join(' · ');
    const row = $('li', {}, [
      $('div', { className: 'list-row' }, [
        titleNode,
        meta ? $('div', { className: 'list-row-meta', text: meta }) : null,
        x.summary ? $('div', { className: 'list-row-summary', text: x.summary }) : null,
      ]),
    ]);
    return row;
  });

  // news
  renderListSection(el.newsSection, el.newsList, p.news || [], (x) => {
    const titleNode = x.url
      ? $('a', { className: 'list-row-title', href: x.url, target: '_blank', rel: 'noopener noreferrer', text: x.title || '(无标题)' })
      : $('div', { className: 'list-row-title', text: x.title || '(无标题)' });
    const meta = [x.source, x.date].filter(Boolean).join(' · ');
    return $('li', {}, [
      $('div', { className: 'list-row' }, [
        titleNode,
        meta ? $('div', { className: 'list-row-meta', text: meta }) : null,
        x.summary ? $('div', { className: 'list-row-summary', text: x.summary }) : null,
      ]),
    ]);
  });

  // episode
  if (p.podcast_episode) {
    const pe = p.podcast_episode;
    el.episodeSection.hidden = false;
    el.episodeBlock.innerHTML = '';
    if (pe.show) el.episodeBlock.appendChild($('div', { className: 'list-row-meta', text: pe.show }));
    if (pe.title) {
      const t = pe.url
        ? $('a', { className: 'list-row-title', href: pe.url, target: '_blank', rel: 'noopener noreferrer', text: pe.title })
        : $('div', { className: 'list-row-title', text: pe.title });
      el.episodeBlock.appendChild(t);
    }
    if (pe.summary) el.episodeBlock.appendChild($('div', { className: 'list-row-summary', text: pe.summary }));
  } else {
    el.episodeSection.hidden = true;
  }
}

function renderListSection(sectionEl, ulEl, items, renderItem) {
  ulEl.innerHTML = '';
  if (!items || items.length === 0) {
    sectionEl.hidden = true;
    return;
  }
  sectionEl.hidden = false;
  for (const item of items) {
    ulEl.appendChild(renderItem(item));
  }
}

function initial(name) {
  if (!name) return '·';
  // grab first non-space char
  const s = String(name).trim();
  return s ? s[0] : '·';
}

/* ---------- chat ---------- */
function enableChat(profile) {
  const name = profile.name || profile.name_en || '嘉宾';
  el.chatWithName.textContent = `与 ${name} 对话`;
  el.chatSub.textContent = '由 Codex agent 以这个人的口吻回应';
  el.chatInput.disabled = false;
  el.chatSend.disabled = false;
  el.chatInput.placeholder = `直接对 ${name} 说点什么…`;
  el.chatInput.focus();
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
  wrap.appendChild(bubble);
  el.chatMessages.appendChild(wrap);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  return bubble;
}

async function sendChatMessage(message) {
  if (!state.taskId) return;
  appendChatMessage('user', message);
  const typingBubble = appendTypingBubble();
  el.chatInput.value = '';
  autoSizeInput();
  el.chatInput.disabled = true;
  el.chatSend.disabled = true;

  try {
    const resp = await fetch(`/api/chat/${state.taskId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    const { turn_id } = await resp.json();
    state.currentChatTurnId = turn_id;
    openChatStream(turn_id, typingBubble);
  } catch (err) {
    typingBubble.textContent = `（出错：${err.message}）`;
    el.chatInput.disabled = false;
    el.chatSend.disabled = false;
  }
}

function openChatStream(turnId, typingBubble) {
  if (state.chatEventSource) state.chatEventSource.close();
  const es = new EventSource(`/api/chat/stream/${turnId}`);
  state.chatEventSource = es;
  let gotMessage = false;

  es.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (!data || !data.kind) return;
    if (data.kind === 'message' && data.status === 'completed' && data.text) {
      typingBubble.textContent = data.text;
      gotMessage = true;
      el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    } else if (data.kind === 'error') {
      typingBubble.textContent = `（出错：${data.text || '未知错误'}）`;
    } else if (data.kind === 'final') {
      es.close();
      state.chatEventSource = null;
      if (!gotMessage) {
        typingBubble.textContent = data.error ? `（出错：${data.error}）` : '（没有收到回复）';
      }
      el.chatInput.disabled = false;
      el.chatSend.disabled = false;
      el.chatInput.focus();
    }
  };

  es.onerror = () => {
    // EventSource will try to reconnect; if it fails repeatedly, the 'final' event won't come,
    // so unlock the input after a brief grace period.
    setTimeout(() => {
      if (state.chatEventSource === es && es.readyState === EventSource.CLOSED) {
        if (!gotMessage) typingBubble.textContent = '（连接中断）';
        el.chatInput.disabled = false;
        el.chatSend.disabled = false;
      }
    }, 2000);
  };
}

function autoSizeInput() {
  const ta = el.chatInput;
  ta.style.height = 'auto';
  ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
}

/* ---------- errors ---------- */
function showError(message) {
  const existing = el.researchPanel.querySelector('.error-banner');
  if (existing) existing.remove();
  const banner = $('div', { className: 'error-banner', text: message });
  el.researchPanel.insertBefore(banner, el.researchPanel.firstChild);
}

/* ---------- bind ---------- */
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
  state.profile = null;
  resetWorkspace();
  switchView('landing');
});

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = el.chatInput.value.trim();
  if (!message || el.chatInput.disabled) return;
  sendChatMessage(message);
});

el.chatInput.addEventListener('input', autoSizeInput);
el.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el.chatForm.requestSubmit();
  }
});
