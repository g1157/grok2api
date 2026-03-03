const STORAGE_KEY = 'grok2api_user_api_key';
let WORKFLOW_STORAGE_KEY = 'grok2api_workflow_state_v2';

function deriveStorageKeySuffix(key) {
  const raw = String(key || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return '';
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return '_' + (hash >>> 0).toString(36);
}

let currentTab = 'chat';
let models = [];
let chatMessages = [];
let chatAttachments = []; // { file, previewUrl }
let videoAttachments = [];
let imageGenerationMethod = 'legacy';
let imageGenerationExperimental = false;
let imageContinuousSockets = [];
let imageContinuousRunning = false;
let imageContinuousCount = 0;
let imageContinuousLatencyTotal = 0;
let imageContinuousLatencyCount = 0;
let imageContinuousActive = 0;
let imageContinuousLastError = '';
let imageContinuousRunToken = 0;
let imageContinuousDesiredConcurrency = 1;
let imagineTabGenerating = false;
const PREFERRED_CHAT_MODEL = 'grok-4.20-beta';
let chatSending = false;
let workflowBusy = false;
let videoGenerating = false;
let editGenerating = false;
let workflowState = {
  selectedImage: '',
  selectedOrigin: '',
  parentPostId: '',
  nsfwEnabled: true,
  gallery: [],
  videoClips: [],
};
let workflowCapabilities = {
  runtime: 'unknown',
  parentPostEndpoint: '/v1/video/parent-post',
  videoStitchEnabled: true,
};
let imagineAdminSessionAuth = '';
let imaginePreviewBound = false;

function q(id) {
  return document.getElementById(id);
}

function openImaginePreview(rawSrc) {
  const src = toAbsoluteUrl(rawSrc);
  if (!src) return;
  const modal = q('imagine-preview-modal');
  const image = q('imagine-preview-image');
  if (!modal || !image) return;
  image.src = src;
  modal.classList.remove('hidden');
  modal.classList.add('is-open');
}

function closeImaginePreview(event) {
  if (event) {
    const target = event.target;
    const shouldClose =
      target === event.currentTarget
      || target?.id === 'imagine-preview-modal'
      || target?.id === 'imagine-preview-close';
    if (!shouldClose) return;
  }
  const modal = q('imagine-preview-modal');
  const image = q('imagine-preview-image');
  if (!modal || !image) return;
  modal.classList.remove('is-open');
  modal.classList.add('hidden');
  image.removeAttribute('src');
}

function bindImaginePreview() {
  if (imaginePreviewBound) return;
  imaginePreviewBound = true;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeImaginePreview();
  });
}

function updateWorkflowBoardVisibility(tab = currentTab) {
  const workflowBoard = q('workflow-board');
  if (workflowBoard) {
    workflowBoard.classList.toggle('hidden', tab === 'chat');
  }
}

function isAdminChat() {
  return Boolean(window.__CHAT_ADMIN__);
}

function getUserApiKey() {
  return String(q('api-key-input').value || '').trim();
}

function buildApiHeaders() {
  const k = getUserApiKey();
  return k ? { Authorization: `Bearer ${k}` } : {};
}

function extractApiErrorMessage(payload, statusCode = 0, fallbackText = '') {
  const errorField = payload?.error;
  const fromErrorObject =
    errorField && typeof errorField === 'object'
      ? String(errorField?.message || errorField?.detail || errorField?.code || '').trim()
      : '';
  const fromString = typeof errorField === 'string' ? errorField.trim() : '';
  const fromPayload = String(payload?.detail || payload?.message || '').trim();
  const fromFallback = String(fallbackText || '').trim();
  return fromErrorObject || fromString || fromPayload || fromFallback || (statusCode ? `HTTP ${statusCode}` : '请求失败');
}

function isSessionExpiredError(payload, statusCode = 0) {
  const code = String(payload?.code || payload?.error?.code || '').trim().toUpperCase();
  if (statusCode === 401 && (code === 'SESSION_EXPIRED' || code === 'MISSING_SESSION')) return true;
  const msg = extractApiErrorMessage(payload, 0, '').toLowerCase();
  return (
    msg.includes('session_expired')
    || msg.includes('session expired')
    || msg.includes('会话已过期')
    || msg.includes('缺少会话')
  );
}

async function buildImagineTabHeaders(extraHeaders = {}, forceSessionRefresh = false) {
  if (isAdminChat()) {
    if ((forceSessionRefresh || !imagineAdminSessionAuth) && typeof ensureApiKey === 'function') {
      const session = await ensureApiKey();
      imagineAdminSessionAuth = typeof session === 'string' ? session.trim() : '';
    }
    if (imagineAdminSessionAuth) {
      return { Authorization: imagineAdminSessionAuth, ...extraHeaders };
    }
  }
  return { ...buildApiHeaders(), ...extraHeaders };
}

async function fetchImagineTabJson(path, init = {}) {
  const baseHeaders = init.headers || {};
  const requestInit = { ...init };
  delete requestInit.headers;

  const run = async (forceSessionRefresh = false) => {
    const headers = await buildImagineTabHeaders(baseHeaders, forceSessionRefresh);
    if (!headers.Authorization) throw new Error('请先填写 API Key');
    const res = await fetch(path, { ...requestInit, headers });
    const payload = await res.json().catch(() => ({}));
    return { res, payload };
  };

  let result = await run(false);
  if (isAdminChat() && result.res.status === 401 && isSessionExpiredError(result.payload, result.res.status)) {
    imagineAdminSessionAuth = '';
    result = await run(true);
  }
  return result;
}

async function fetchImagineTabStream(path, init = {}) {
  const baseHeaders = init.headers || {};
  const requestInit = { ...init };
  delete requestInit.headers;

  const run = async (forceSessionRefresh = false) => {
    const headers = await buildImagineTabHeaders(baseHeaders, forceSessionRefresh);
    if (!headers.Authorization) throw new Error('请先填写 API Key');
    const res = await fetch(path, { ...requestInit, headers });
    if (res.ok && res.body) {
      return { res, payload: null, rawError: '' };
    }
    const rawError = await res.text().catch(() => '');
    let payload = {};
    if (rawError) {
      try {
        payload = JSON.parse(rawError);
      } catch (e) {
        payload = { error: rawError };
      }
    }
    return { res, payload, rawError };
  };

  let result = await run(false);
  if (isAdminChat() && result.res.status === 401 && isSessionExpiredError(result.payload, result.res.status)) {
    imagineAdminSessionAuth = '';
    result = await run(true);
  }
  return result;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeRuntimeName(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value === 'cloudflare-workers') return 'cloudflare-workers';
  if (value === 'python-fastapi') return 'python-fastapi';
  return value;
}

function applyWorkflowCapabilities() {
  const stitchEnabled = workflowCapabilities.videoStitchEnabled !== false;
  const stitchBtn = q('video-stitch-btn');
  const stitchNote = q('video-stitch-note');

  if (stitchBtn) {
    stitchBtn.classList.toggle('hidden', !stitchEnabled);
    stitchBtn.disabled = !stitchEnabled;
  }
  if (stitchNote) {
    stitchNote.classList.toggle('hidden', stitchEnabled);
    if (!stitchEnabled) {
      const runtimeText = workflowCapabilities.runtime && workflowCapabilities.runtime !== 'unknown'
        ? `（${workflowCapabilities.runtime}）`
        : '';
      stitchNote.textContent = `当前部署已关闭视频拼接${runtimeText}`;
    }
  }
}

async function detectWorkflowCapabilities() {
  workflowCapabilities = {
    runtime: 'unknown',
    parentPostEndpoint: '/v1/video/parent-post',
    videoStitchEnabled: true,
  };

  try {
    const res = await fetch(`/health?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) {
      const payload = await res.json().catch(() => ({}));
      const runtime = normalizeRuntimeName(payload?.runtime);
      workflowCapabilities.runtime = runtime;
      if (runtime === 'cloudflare-workers') {
        workflowCapabilities.videoStitchEnabled = false;
      }
    }
  } catch (e) {}

  applyWorkflowCapabilities();
}

function toAbsoluteUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('data:')) return u;
  try {
    return new URL(u, window.location.href).toString();
  } catch (e) {
    return u;
  }
}

function detectBase64ImageMime(base64Text) {
  const s = String(base64Text || '').trim().replace(/\s+/g, '');
  if (!s) return 'image/png';
  if (s.startsWith('/9j/')) return 'image/jpeg';
  if (s.startsWith('iVBORw0KGgo')) return 'image/png';
  if (s.startsWith('UklGR')) return 'image/webp';
  if (s.startsWith('R0lGOD')) return 'image/gif';
  if (s.startsWith('Qk')) return 'image/bmp';
  return 'image/png';
}

function toImageDataUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const lowered = value.toLowerCase();
  if (['error', 'null', 'none', 'undefined'].includes(lowered)) return '';
  if (value.startsWith('data:image/')) return value;
  const mime = detectBase64ImageMime(value);
  return `data:${mime};base64,${value}`;
}

function pickImageSrc(item) {
  const rawUrl = String(item?.url || '').trim();
  const rawUrlLower = rawUrl.toLowerCase();
  if (
    rawUrl &&
    rawUrl !== 'https://assets.grok.com/' &&
    rawUrl !== 'https://assets.grok.com' &&
    rawUrlLower !== 'error' &&
    rawUrlLower !== 'null' &&
    rawUrlLower !== 'undefined'
  ) {
    return toAbsoluteUrl(rawUrl);
  }
  const b64json = String(item?.b64_json || '').trim();
  if (b64json) return toImageDataUrl(b64json);
  const base64 = String(item?.base64 || '').trim();
  if (base64) return toImageDataUrl(base64);
  return '';
}

function showUserMsg(role, content) {
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  wrap.innerHTML = `
    <div class="msg-role">${escapeHtml(role)}</div>
    <div class="msg-bubble"></div>
  `;
  const bubble = wrap.querySelector('.msg-bubble');
  renderContent(bubble, content, role !== 'assistant');
  q('chat-messages').appendChild(wrap);
  q('chat-messages').scrollTop = q('chat-messages').scrollHeight;
  return bubble;
}

function setChatSendingState(sending) {
  chatSending = Boolean(sending);
  const sendBtn = q('panel-chat')?.querySelector('button[onclick="sendChat()"]');
  if (sendBtn) sendBtn.disabled = chatSending;
  document.querySelectorAll('.chat-retry-btn').forEach((btn) => {
    btn.disabled = chatSending;
  });
}

function appendCacheBust(url) {
  const raw = String(url || '').trim();
  if (!raw || raw.startsWith('data:')) return raw;
  try {
    const parsed = new URL(raw, window.location.href);
    parsed.searchParams.set('_retry', String(Date.now()));
    return parsed.toString();
  } catch (e) {
    const sep = raw.includes('?') ? '&' : '?';
    return `${raw}${sep}_retry=${Date.now()}`;
  }
}

function retryImageFromButton(button) {
  const src = String(button?.dataset?.src || '').trim();
  const alt = String(button?.dataset?.alt || 'image').trim() || 'image';
  if (!src || button.classList.contains('loading')) return;

  button.classList.add('loading');
  button.textContent = '重试中...';

  const probe = new Image();
  probe.onload = () => {
    const img = document.createElement('img');
    img.alt = alt;
    img.src = probe.src;
    bindRetryableImage(img);
    button.replaceWith(img);
  };
  probe.onerror = () => {
    button.classList.remove('loading');
    button.textContent = '点击重试';
  };
  probe.src = appendCacheBust(src);
}

function bindRetryableImage(img) {
  if (!img || img.dataset.retryBound === '1') return;
  img.dataset.retryBound = '1';
  img.addEventListener('error', () => {
    const src = String(img.currentSrc || img.getAttribute('src') || '').trim();
    if (!src || !img.isConnected) return;
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'img-retry';
    retryBtn.textContent = '点击重试';
    retryBtn.title = '图片加载失败，点击重试';
    retryBtn.dataset.src = src;
    retryBtn.dataset.alt = String(img.alt || 'image');
    retryBtn.addEventListener('click', () => retryImageFromButton(retryBtn));
    img.replaceWith(retryBtn);
  });
}

function bindRetryableImages(root) {
  if (!root) return;
  root.querySelectorAll('img').forEach((img) => bindRetryableImage(img));
}

function attachAssistantRetryAction(bubbleEl) {
  if (!bubbleEl || bubbleEl.querySelector('.msg-actions')) return;
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'chat-retry-btn';
  retryBtn.textContent = '重试上一条回答';
  retryBtn.title = '重试上一条回答';
  retryBtn.disabled = chatSending;
  retryBtn.addEventListener('click', retryLastAssistantAnswer);
  actions.appendChild(retryBtn);
  bubbleEl.appendChild(actions);
}

function findLastUserMessageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

function getSelectedChatModel() {
  const sel = q('model-select');
  const options = Array.from(sel?.options || [])
    .map((opt) => String(opt.value || '').trim())
    .filter(Boolean);
  const current = String(sel?.value || '').trim();
  if (current && options.includes(current)) return current;
  const fallback = options.includes(PREFERRED_CHAT_MODEL) ? PREFERRED_CHAT_MODEL : (options[0] || '');
  if (sel && fallback) sel.value = fallback;
  return fallback;
}

function mdImagesToHtml(text) {
  return String(text).replace(/!\[[^\]]*]\(([^)]+)\)/g, (m, url) => {
    const safe = escapeHtml(String(url || '').trim());
    return safe ? `<img src="${safe}" alt="image" />` : '';
  });
}

function sanitizeHtml(html) {
  const allowedTags = new Set(['A', 'IMG', 'VIDEO', 'SOURCE', 'BR', 'P', 'PRE', 'CODE', 'DIV', 'SPAN']);
  const allowedAttrs = {
    A: new Set(['href', 'target', 'rel']),
    IMG: new Set(['src', 'alt']),
    VIDEO: new Set(['src', 'controls', 'preload', 'poster']),
    SOURCE: new Set(['src', 'type']),
    P: new Set([]),
    PRE: new Set([]),
    CODE: new Set([]),
    DIV: new Set([]),
    SPAN: new Set([]),
  };

  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return '';

  function cleanNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createTextNode('');

    const el = node;
    const tag = el.tagName.toUpperCase();
    if (!allowedTags.has(tag)) {
      const frag = document.createDocumentFragment();
      Array.from(el.childNodes).forEach((c) => frag.appendChild(cleanNode(c)));
      return frag;
    }

    const out = document.createElement(tag.toLowerCase());
    const okAttrs = allowedAttrs[tag] || new Set();
    Array.from(el.attributes || []).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (!okAttrs.has(name)) return;
      const val = String(attr.value || '');
      if (tag === 'A' && name === 'href') {
        if (!(val.startsWith('http://') || val.startsWith('https://') || val.startsWith('/'))) return;
      }
      if ((tag === 'IMG' || tag === 'VIDEO' || tag === 'SOURCE') && name === 'src') {
        if (!(val.startsWith('http://') || val.startsWith('https://') || val.startsWith('/') || val.startsWith('data:')))
          return;
      }
      out.setAttribute(name, val);
    });

    Array.from(el.childNodes).forEach((c) => out.appendChild(cleanNode(c)));
    return out;
  }

  const cleaned = cleanNode(root);
  const container = document.createElement('div');
  container.appendChild(cleaned);
  return container.innerHTML;
}

function renderContent(container, content, forceText) {
  container.innerHTML = '';
  const text = String(content || '');

  if (forceText) {
    const pre = document.createElement('pre');
    pre.textContent = text;
    container.appendChild(pre);
    return;
  }

  const html = sanitizeHtml(mdImagesToHtml(text).replace(/\n/g, '<br/>'));
  if (!html.trim()) {
    const pre = document.createElement('pre');
    pre.textContent = text;
    container.appendChild(pre);
    return;
  }
  container.innerHTML = html;
  normalizeVideoElements(container);
  if (container.closest('#panel-chat')) {
    hideImagesInChatPanel(container);
  } else {
    bindRetryableImages(container);
  }
}

function normalizeVideoElements(container) {
  if (!container) return;
  container.querySelectorAll('video').forEach((videoEl) => {
    videoEl.querySelectorAll('br').forEach((br) => br.remove());
    if (!videoEl.hasAttribute('controls')) videoEl.setAttribute('controls', '');
    if (!videoEl.hasAttribute('preload')) videoEl.setAttribute('preload', 'metadata');
    const src = String(videoEl.getAttribute('src') || '').trim();
    if (src) videoEl.setAttribute('src', toAbsoluteUrl(src));
    videoEl.querySelectorAll('source').forEach((sourceEl) => {
      const sourceSrc = String(sourceEl.getAttribute('src') || '').trim();
      if (!sourceSrc) return;
      sourceEl.setAttribute('src', toAbsoluteUrl(sourceSrc));
    });
  });
}

function hideImagesInChatPanel(container) {
  if (!container) return;
  container.querySelectorAll('img').forEach((img) => {
    const tip = document.createElement('span');
    tip.className = 'chat-image-hidden';
    tip.textContent = '[图片已隐藏]';
    img.replaceWith(tip);
  });
}

async function init() {
  if (isAdminChat()) {
    const adminSession = await ensureApiKey();
    if (adminSession === null) return;
    imagineAdminSessionAuth = typeof adminSession === 'string' ? adminSession.trim() : '';
    try {
      const res = await fetch('/api/v1/admin/config', { headers: buildAuthHeaders(adminSession) });
      if (res.status === 401) return logout();
      if (res.ok) {
        const cfg = await res.json();
        const k = String(cfg?.app?.api_key || '').trim();
        if (k) {
          q('api-key-input').value = k;
          localStorage.setItem(STORAGE_KEY, k);
        }
      }
    } catch (e) {}
  }

  const saved = localStorage.getItem(STORAGE_KEY) || '';
  if (!q('api-key-input').value) q('api-key-input').value = saved;
  const effectiveKey = q('api-key-input').value || saved || imagineAdminSessionAuth || '';
  WORKFLOW_STORAGE_KEY = 'grok2api_workflow_state_v2' + deriveStorageKeySuffix(effectiveKey);
  loadWorkflowState();

  bindFileInputs();
  bindWorkflowEvents();
  q('image-run-mode')?.addEventListener('change', () => {
    if (getImageRunMode() !== 'continuous') {
      stopImageContinuous();
    }
    updateImageModeUI();
  });
  window.addEventListener('beforeunload', () => {
    stopImageContinuous();
  });
  await refreshModels();
  await refreshImageGenerationMethod();
  await detectWorkflowCapabilities();
  renderWorkflowState();
  updateWorkflowBoardVisibility(currentTab);
  bindImaginePreview();
  refreshImagineTabData(true);

  chatMessages = [];
  q('chat-messages').innerHTML = '';
  showUserMsg('system', '提示：选择模型后即可开始聊天；生图/编辑/视频请切换到对应 Tab。');
}

function bindFileInputs() {
  q('chat-file').addEventListener('change', () => {
    const files = Array.from(q('chat-file').files || []);
    if (!files.length) return;
    addAttachments('chat', files);
    q('chat-file').value = '';
  });

  q('video-file').addEventListener('change', () => {
    const files = Array.from(q('video-file').files || []);
    if (!files.length) return;
    addAttachments('video', files);
    q('video-file').value = '';
  });
}

function bindWorkflowEvents() {
  q('workflow-nsfw-toggle')?.addEventListener('change', (e) => {
    setWorkflowNsfwEnabled(Boolean(e.target?.checked));
  });
  q('workflow-clear-selection-btn')?.addEventListener('click', clearWorkflowSelection);

  q('video-stitch-btn')?.addEventListener('click', stitchSelectedVideos);
  q('video-select-all-btn')?.addEventListener('click', () => selectAllVideoClips(true));
  q('video-clear-clips-btn')?.addEventListener('click', clearVideoClips);

  q('edit-run-btn')?.addEventListener('click', generateImageEdit);
  q('edit-clear-btn')?.addEventListener('click', clearEditResults);
}

function addAttachments(kind, files) {
  const list = kind === 'video' ? videoAttachments : chatAttachments;
  files.forEach((f) => {
    if (!String(f.type || '').toLowerCase().startsWith('image/')) return;
    const url = URL.createObjectURL(f);
    list.push({ file: f, previewUrl: url });
  });
  renderAttachments(kind);
}

function renderAttachments(kind) {
  const list = kind === 'video' ? videoAttachments : chatAttachments;
  const info = kind === 'video' ? q('video-attach-info') : q('chat-attach-info');
  const box = kind === 'video' ? q('video-attach-preview') : q('chat-attach-preview');
  info.textContent = list.length ? `已选择 ${list.length} 张图片` : '';
  box.innerHTML = '';
  if (!list.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  list.forEach((it, idx) => {
    const div = document.createElement('div');
    div.className = 'attach-item';
    div.innerHTML = `<img src="${it.previewUrl}" alt="img"><button title="移除">×</button>`;
    div.querySelector('button').addEventListener('click', () => {
      try { URL.revokeObjectURL(it.previewUrl); } catch (e) {}
      list.splice(idx, 1);
      renderAttachments(kind);
    });
    box.appendChild(div);
  });
}

function normalizeWorkflowState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const gallery = Array.isArray(data.gallery) ? data.gallery : [];
  const videoClips = Array.isArray(data.videoClips) ? data.videoClips : [];
  return {
    selectedImage: String(data.selectedImage || '').trim(),
    selectedOrigin: String(data.selectedOrigin || '').trim(),
    parentPostId: String(data.parentPostId || '').trim(),
    nsfwEnabled: data.nsfwEnabled !== false,
    gallery: gallery
      .map((it, idx) => ({
        id: String(it?.id || `img-${idx}-${Date.now()}`),
        src: String(it?.src || '').trim(),
        origin: String(it?.origin || '').trim(),
        parentPostId: String(it?.parentPostId || '').trim(),
        createdAt: Number(it?.createdAt || Date.now()),
      }))
      .filter((it) => Boolean(it.src))
      .slice(0, 120),
    videoClips: videoClips
      .map((it, idx) => ({
        id: String(it?.id || `clip-${idx}-${Date.now()}`),
        url: String(it?.url || '').trim(),
        createdAt: Number(it?.createdAt || Date.now()),
        selected: it?.selected !== false,
      }))
      .filter((it) => Boolean(it.url))
      .slice(0, 60),
  };
}

function isPersistableMediaSrc(src) {
  const value = String(src || '').trim();
  if (!value) return false;
  if (value.startsWith('data:')) return false;
  return value.length < 2048;
}

function saveWorkflowState() {
  try {
    const persistableGallery = workflowState.gallery.filter((it) => isPersistableMediaSrc(it?.src));
    const selectedImage = isPersistableMediaSrc(workflowState.selectedImage) ? workflowState.selectedImage : '';
    const persistable = {
      ...workflowState,
      selectedImage,
      selectedOrigin: selectedImage ? workflowState.selectedOrigin : '',
      parentPostId: selectedImage ? workflowState.parentPostId : '',
      gallery: persistableGallery,
    };
    localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(persistable));
  } catch (e) {}
}

function loadWorkflowState() {
  try {
    const raw = localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) return;
    workflowState = normalizeWorkflowState(JSON.parse(raw));
  } catch (e) {
    workflowState = normalizeWorkflowState({});
  }
}

function findWorkflowItemBySrc(src) {
  const normalized = toAbsoluteUrl(src);
  return workflowState.gallery.find((it) => it.src === normalized) || null;
}

function addWorkflowImage(src, origin) {
  const normalized = toAbsoluteUrl(src);
  if (!normalized) return null;
  let item = findWorkflowItemBySrc(normalized);
  if (!item) {
    item = {
      id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      src: normalized,
      origin: String(origin || '').trim(),
      parentPostId: '',
      createdAt: Date.now(),
    };
    workflowState.gallery.unshift(item);
  } else if (origin && !item.origin) {
    item.origin = String(origin).trim();
  }
  if (workflowState.gallery.length > 120) workflowState.gallery = workflowState.gallery.slice(0, 120);
  const dataImages = workflowState.gallery.filter((it) => String(it.src || '').startsWith('data:'));
  if (dataImages.length > 24) {
    const keepDataIds = new Set(dataImages.slice(0, 24).map((it) => it.id));
    workflowState.gallery = workflowState.gallery.filter(
      (it) => !String(it.src || '').startsWith('data:') || keepDataIds.has(it.id),
    );
  }
  saveWorkflowState();
  renderWorkflowGallery();
  return item;
}

function removeWorkflowImage(id) {
  const before = workflowState.gallery.length;
  workflowState.gallery = workflowState.gallery.filter((it) => it.id !== id);
  if (before === workflowState.gallery.length) return;
  if (!workflowState.gallery.find((it) => it.src === workflowState.selectedImage)) {
    workflowState.selectedImage = '';
    workflowState.selectedOrigin = '';
    workflowState.parentPostId = '';
  }
  saveWorkflowState();
  renderWorkflowState();
}

function setWorkflowSelection(src, origin, ensureParent = true) {
  const item = addWorkflowImage(src, origin);
  if (!item) return;
  workflowState.selectedImage = item.src;
  workflowState.selectedOrigin = item.origin || String(origin || '').trim();
  workflowState.parentPostId = String(item.parentPostId || '').trim();
  saveWorkflowState();
  renderWorkflowState();
  if (ensureParent && !workflowState.parentPostId) {
    ensureParentPostIdForSelection(false, true);
  }
}

function clearWorkflowSelection() {
  workflowState.selectedImage = '';
  workflowState.selectedOrigin = '';
  workflowState.parentPostId = '';
  saveWorkflowState();
  renderWorkflowState();
}

function setWorkflowNsfwEnabled(enabled) {
  workflowState.nsfwEnabled = Boolean(enabled);
  saveWorkflowState();
  renderWorkflowState();
}

function renderSelectedPreview(container, emptyText) {
  if (!container) return;
  container.innerHTML = '';
  const src = String(workflowState.selectedImage || '').trim();
  if (!src) {
    const tip = document.createElement('div');
    tip.className = 'workflow-empty';
    tip.textContent = emptyText;
    container.appendChild(tip);
    return;
  }
  const img = document.createElement('img');
  img.src = src;
  img.alt = 'selected-image';
  bindRetryableImage(img);
  container.appendChild(img);
}

function renderWorkflowGallery() {
  const box = q('workflow-gallery');
  const empty = q('workflow-gallery-empty');
  if (!box) return;
  box.innerHTML = '';
  if (!workflowState.gallery.length) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  workflowState.gallery.forEach((item) => {
    const card = document.createElement('div');
    const active = workflowState.selectedImage === item.src;
    card.className = `workflow-gallery-item${active ? ' is-active' : ''}`;
    card.innerHTML = `
      <img src="${escapeHtml(toAbsoluteUrl(item.src))}" alt="workflow-image" />
      <div class="workflow-gallery-meta">${escapeHtml(item.origin || 'image')}</div>
      <div class="workflow-gallery-actions">
        <button type="button" class="wf-btn-select">选中</button>
        <button type="button" class="wf-btn-remove">移除</button>
      </div>
    `;
    bindRetryableImage(card.querySelector('img'));
    card.querySelector('.wf-btn-select')?.addEventListener('click', () => {
      setWorkflowSelection(item.src, item.origin, true);
    });
    card.querySelector('.wf-btn-remove')?.addEventListener('click', () => {
      removeWorkflowImage(item.id);
    });
    box.appendChild(card);
  });
}

function renderVideoClips() {
  const list = q('video-clip-list');
  const count = q('video-clip-count');
  if (count) count.textContent = String(workflowState.videoClips.length);
  if (!list) return;
  list.innerHTML = '';
  if (!workflowState.videoClips.length) {
    list.innerHTML = '<div class="workflow-empty">暂无视频片段</div>';
    return;
  }
  workflowState.videoClips.forEach((clip) => {
    const row = document.createElement('div');
    row.className = 'clip-row';
    row.innerHTML = `
      <input type="checkbox" class="checkbox" ${clip.selected !== false ? 'checked' : ''} />
      <div class="clip-content">
        <video controls preload="metadata" src="${escapeHtml(clip.url)}"></video>
        <a href="${escapeHtml(clip.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(clip.url)}</a>
      </div>
    `;
    row.querySelector('input')?.addEventListener('change', (e) => {
      clip.selected = Boolean(e.target?.checked);
      saveWorkflowState();
    });
    list.appendChild(row);
  });
}

function renderWorkflowState() {
  const selectedLabel = q('workflow-selected-label');
  const globalParent = q('workflow-parent-post-id');
  const videoParent = q('video-parent-post-id');
  const editRefInfo = q('edit-reference-info');
  const videoRefInfo = q('video-reference-info');
  const nsfwToggle = q('workflow-nsfw-toggle');

  renderSelectedPreview(q('workflow-selected-preview'), '未选择工作图');
  renderSelectedPreview(q('edit-reference-preview'), '请先在生图结果中选择一张图');
  renderSelectedPreview(q('video-reference-preview'), '将使用工作流中已选图片');

  if (selectedLabel) {
    selectedLabel.textContent = workflowState.selectedImage
      ? `来源：${workflowState.selectedOrigin || 'image'}`
      : '未选择工作图';
  }
  const parentText = workflowState.parentPostId || (workflowBusy ? '解析中...' : '-');
  if (globalParent) globalParent.textContent = parentText;
  if (videoParent) videoParent.textContent = parentText;
  if (editRefInfo) editRefInfo.textContent = workflowState.selectedImage ? '已加载工作图，可直接编辑' : '未选择工作图';
  if (videoRefInfo) {
    if (workflowState.parentPostId) videoRefInfo.textContent = '已命中 parentPostId，生视频无需重新上传';
    else if (workflowState.selectedImage) videoRefInfo.textContent = '已选工作图，首次会自动解析 parentPostId';
    else videoRefInfo.textContent = '可选：从生图/编辑结果中选择一张图';
  }
  if (nsfwToggle) nsfwToggle.checked = workflowState.nsfwEnabled !== false;

  renderWorkflowGallery();
  renderVideoClips();
}

function updateImagineTabStats(pool = null, galleryCount = null) {
  const setText = (id, text) => {
    const el = q(id);
    if (el) el.textContent = String(text);
  };
  if (pool) {
    setText('imagine-stat-total', pool.total ?? '-');
    setText('imagine-stat-available', pool.available ?? '-');
    setText('imagine-stat-status', Number(pool.available || 0) > 0 ? '正常' : '无可用');
  }
  if (galleryCount !== null && galleryCount !== undefined) {
    setText('imagine-stat-gallery', galleryCount);
  }
}

function setImagineTabGeneratingState(running) {
  imagineTabGenerating = Boolean(running);
  const btn = q('imagine-tab-generate-btn');
  if (btn) btn.disabled = imagineTabGenerating;
}

function setImagineTabProgress(show, percent = 0, stage = '', status = '') {
  const panel = q('imagine-tab-progress');
  const bar = q('imagine-tab-progress-bar');
  const stageEl = q('imagine-tab-progress-stage');
  const statusEl = q('imagine-tab-progress-status');
  if (panel) panel.classList.toggle('hidden', !show);
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
  if (stageEl) stageEl.textContent = stage || '';
  if (statusEl) statusEl.textContent = status || '';
}

function base64UrlEncodeUtf8(input) {
  const bytes = new TextEncoder().encode(String(input || ''));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isAllowedUpstreamMediaHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return false;
  return h === 'assets.grok.com' || h === 'grok.com' || h.endsWith('.grok.com') || h.endsWith('.x.ai');
}

function encodeAssetProxyPath(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('/images/')) return '';
  try {
    const u = new URL(value);
    if (!isAllowedUpstreamMediaHost(u.hostname)) return '';
    return `u_${base64UrlEncodeUtf8(u.toString())}`;
  } catch (_) {
    if (value.startsWith('/api/v1/imagine/gallery/file/')) return '';
    const path = value.startsWith('/') ? value : `/${value}`;
    return `p_${base64UrlEncodeUtf8(path)}`;
  }
}

function toLocalMediaProxyUrl(raw) {
  const encoded = encodeAssetProxyPath(raw);
  return encoded ? `/images/${encoded}` : '';
}

function normalizeImagineGalleryUrl(rawUrl, filename) {
  const raw = String(rawUrl || '').trim();
  const name = String(filename || '').trim();
  const rewritePath = (path) => {
    if (!path.startsWith('/api/v1/imagine/gallery/') || path.startsWith('/api/v1/imagine/gallery/file/')) {
      return path;
    }
    const suffix = path.slice('/api/v1/imagine/gallery/'.length);
    if (!suffix || suffix.includes('/')) return path;
    return `/api/v1/imagine/gallery/file/${suffix}`;
  };
  if (raw) {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      try {
        const u = new URL(raw);
        const rewritten = rewritePath(u.pathname || '');
        if (rewritten !== (u.pathname || '')) u.pathname = rewritten;
        const proxied = toLocalMediaProxyUrl(u.toString());
        if (proxied) return proxied;
        return u.toString();
      } catch (e) {}
    }
    const relRewritten = rewritePath(raw);
    const proxied = toLocalMediaProxyUrl(relRewritten);
    if (proxied) return proxied;
    return relRewritten;
  }
  if (name) {
    const fallback = `/api/v1/imagine/gallery/file/${encodeURIComponent(name)}`;
    return toLocalMediaProxyUrl(fallback) || fallback;
  }
  return '';
}

function extractImagineImageUrls(payload) {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  return items
    .map((it) => toAbsoluteUrl(normalizeImagineGalleryUrl(it?.url, it?.filename)))
    .filter(Boolean);
}

function renderImagineTabGalleryCards(items) {
  const gallery = q('imagine-tab-gallery');
  if (!gallery) return;
  if (!Array.isArray(items) || !items.length) {
    gallery.innerHTML = '<div class="workflow-empty">暂无图片</div>';
    updateImagineTabStats(null, 0);
    return;
  }
  gallery.innerHTML = items
    .map((img) => {
      const name = String(img?.name || img?.filename || '').trim();
      const rawUrl = normalizeImagineGalleryUrl(img?.url, name);
      const src = toAbsoluteUrl(rawUrl);
      const encodedSrc = encodeURIComponent(src);
      const encodedName = encodeURIComponent(name);
      const active = workflowState.selectedImage && toAbsoluteUrl(workflowState.selectedImage) === src;
      return `
        <div class="imagine-tab-card${active ? ' is-active' : ''}">
          <img alt="imagine-image" src="${escapeHtml(src)}" onclick="openImaginePreview(decodeURIComponent('${encodedSrc}'))" />
          <div class="imagine-tab-actions">
            <button type="button" onclick="syncImagineTabImage(decodeURIComponent('${encodedSrc}'))">选中工作图</button>
            <button type="button" onclick="goImagineTabEdit(decodeURIComponent('${encodedSrc}'))">去编辑</button>
            <button type="button" onclick="goImagineTabVideo(decodeURIComponent('${encodedSrc}'))">去视频</button>
            <button type="button" onclick="deleteImagineTabImage(decodeURIComponent('${encodedName}'))">删除</button>
          </div>
        </div>
      `;
    })
    .join('');
  gallery.querySelectorAll('img').forEach((img) => bindRetryableImage(img));
  updateImagineTabStats(null, items.length);
}

function prependImagineTabGeneratedCards(urls) {
  const gallery = q('imagine-tab-gallery');
  if (!gallery || !Array.isArray(urls) || !urls.length) return;

  if (gallery.querySelector('.workflow-empty')) {
    gallery.innerHTML = '';
  }

  const existingSet = new Set(
    Array.from(gallery.querySelectorAll('.imagine-tab-card img'))
      .map((img) => toAbsoluteUrl(String(img.getAttribute('src') || '').trim()))
      .filter(Boolean),
  );

  let added = 0;
  urls
    .map((raw) => toAbsoluteUrl(raw))
    .filter(Boolean)
    .reverse()
    .forEach((src) => {
      if (existingSet.has(src)) return;
      existingSet.add(src);
      const encodedSrc = encodeURIComponent(src);
      const card = document.createElement('div');
      card.className = 'imagine-tab-card';
      card.innerHTML = `
        <img alt="imagine-image" src="${escapeHtml(src)}" onclick="openImaginePreview(decodeURIComponent('${encodedSrc}'))" />
        <div class="imagine-tab-actions">
          <button type="button" onclick="syncImagineTabImage(decodeURIComponent('${encodedSrc}'))">选中工作图</button>
          <button type="button" onclick="goImagineTabEdit(decodeURIComponent('${encodedSrc}'))">去编辑</button>
          <button type="button" onclick="goImagineTabVideo(decodeURIComponent('${encodedSrc}'))">去视频</button>
        </div>
      `;
      const imgEl = card.querySelector('img');
      if (imgEl) bindRetryableImage(imgEl);
      gallery.prepend(card);
      added += 1;
    });

  if (added > 0) {
    updateImagineTabStats(null, gallery.querySelectorAll('.imagine-tab-card').length);
  }
}

async function refreshImagineTabGalleryWithRetry(expectedUrls) {
  const expected = Array.isArray(expectedUrls)
    ? expectedUrls.map((raw) => toAbsoluteUrl(raw)).filter(Boolean)
    : [];

  const maxAttempts = expected.length ? 5 : 1;
  for (let i = 0; i < maxAttempts; i += 1) {
    const items = await loadImagineTabGallery(true);
    if (!expected.length) return;
    const fetched = new Set(
      items
        .map((img) => {
          const name = String(img?.name || img?.filename || '').trim();
          return toAbsoluteUrl(normalizeImagineGalleryUrl(img?.url, name));
        })
        .filter(Boolean),
    );
    const allReady = expected.every((u) => fetched.has(u));
    if (allReady) return;
    if (i < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 320 * (i + 1)));
    }
  }
}

async function loadImagineTabSsoStatus(silent = true) {
  const tbody = q('imagine-tab-sso-body');
  try {
    const { res, payload } = await fetchImagineTabJson('/api/v1/imagine/status');
    if (!res.ok) throw new Error(extractApiErrorMessage(payload, res.status));
    const pool = payload?.sso_pool || {};
    const tokens = Array.isArray(pool.tokens) ? pool.tokens : [];

    updateImagineTabStats(pool, null);

    if (tbody) {
      if (!tokens.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-[var(--accents-4)] py-4">暂无 Token</td></tr>';
      } else {
        tbody.innerHTML = tokens
          .map((t) => {
            const failCount = Number(t.fail_count || 0);
            const daily = Number(t.daily_count || 0);
            const limit = Number(t.daily_limit || 0);
            const remain = Math.max(0, limit - daily);
            const badgeClass = failCount > 0 ? 'badge-red' : 'badge-green';
            const badgeText = failCount > 0 ? '失败' : '正常';
            return `
              <tr>
                <td class="text-left font-mono text-xs">${escapeHtml(String(t.token || '***'))}</td>
                <td>${daily}</td>
                <td>${remain}</td>
                <td><span class="badge ${badgeClass}">${badgeText}</span></td>
                <td class="text-xs text-[var(--accents-5)]">${t.available ? '可用' : '不可用'}</td>
              </tr>
            `;
          })
          .join('');
      }
    }
    return pool;
  } catch (e) {
    if (e?.message === '请先填写 API Key') {
      if (!silent) showToast('请先填写 API Key', 'warning');
      return null;
    }
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-[var(--error)] py-4">加载失败: ${escapeHtml(e?.message || e)}</td></tr>`;
    }
    if (!silent) showToast(`Imagine 状态加载失败: ${e?.message || e}`, 'error');
    return null;
  }
}

async function loadImagineTabGallery(silent = true) {
  try {
    const { res, payload } = await fetchImagineTabJson('/api/v1/imagine/gallery');
    if (!res.ok) throw new Error(extractApiErrorMessage(payload, res.status));

    const items = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.images) ? payload.images : []);
    renderImagineTabGalleryCards(items);
    return items;
  } catch (e) {
    if (e?.message === '请先填写 API Key') {
      if (!silent) showToast('请先填写 API Key', 'warning');
      return [];
    }
    const gallery = q('imagine-tab-gallery');
    if (gallery) gallery.innerHTML = `<div class="workflow-empty">加载失败: ${escapeHtml(e?.message || e)}</div>`;
    if (!silent) showToast(`Imagine 图片库加载失败: ${e?.message || e}`, 'error');
    return [];
  }
}

async function refreshImagineTabData(silent = true) {
  await loadImagineTabGallery(silent);
}

function syncImagineTabImage(src, silent = false) {
  const value = toAbsoluteUrl(src);
  if (!value) return;
  setWorkflowSelection(value, 'imagine-gallery', true);
  loadImagineTabGallery(true);
  if (!silent) showToast('已设为工作图', 'success');
}

function goImagineTabEdit(src) {
  syncImagineTabImage(src, true);
  switchTab('edit');
}

function goImagineTabVideo(src) {
  syncImagineTabImage(src, true);
  switchTab('video');
}

async function deleteImagineTabImage(name) {
  const filename = String(name || '').trim();
  if (!filename) return;
  if (!confirm('确认删除这张图片吗？')) return;
  try {
    const { res, payload } = await fetchImagineTabJson(`/api/v1/imagine/gallery/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(extractApiErrorMessage(payload, res.status));
    await loadImagineTabGallery(true);
    showToast('删除成功', 'success');
  } catch (e) {
    showToast(`删除失败: ${e?.message || e}`, e?.message === '请先填写 API Key' ? 'warning' : 'error');
  }
}

async function clearImagineTabGallery() {
  if (!confirm('确认清空 Imagine 图片库吗？')) return;
  try {
    const { res, payload } = await fetchImagineTabJson('/api/v1/imagine/gallery/clear', {
      method: 'POST',
    });
    if (!res.ok) throw new Error(extractApiErrorMessage(payload, res.status));
    await refreshImagineTabData(true);
    showToast('已清空图片库', 'success');
  } catch (e) {
    showToast(`清空失败: ${e?.message || e}`, e?.message === '请先填写 API Key' ? 'warning' : 'error');
  }
}

async function reloadImagineTabSso() {
  try {
    const { res, payload } = await fetchImagineTabJson('/api/v1/imagine/sso/reload', { method: 'POST' });
    if (!res.ok) throw new Error(extractApiErrorMessage(payload, res.status));
    await loadImagineTabSsoStatus(true);
    showToast('Imagine SSO 已重载', 'success');
  } catch (e) {
    showToast(`重载失败: ${e?.message || e}`, e?.message === '请先填写 API Key' ? 'warning' : 'error');
  }
}

async function resetImagineTabSso() {
  if (!confirm('确认重置 Imagine 每日用量吗？')) return;
  try {
    const { res, payload } = await fetchImagineTabJson('/api/v1/imagine/sso/reset', { method: 'POST' });
    if (!res.ok) throw new Error(extractApiErrorMessage(payload, res.status));
    await loadImagineTabSsoStatus(true);
    showToast('Imagine 每日用量已重置', 'success');
  } catch (e) {
    showToast(`重置失败: ${e?.message || e}`, e?.message === '请先填写 API Key' ? 'warning' : 'error');
  }
}

function buildImagineGenerateBody() {
  const sizeMap = {
    '1:1': '1024x1024',
    '2:3': '1024x1536',
    '3:2': '1536x1024',
  };
  const ratio = String(q('imagine-tab-aspect')?.value || '2:3').trim();
  const n = Math.max(1, Math.min(4, Math.floor(Number(q('imagine-tab-count')?.value || 1) || 1)));
  const stream = Boolean(q('imagine-tab-stream')?.checked);
  return {
    prompt: String(q('imagine-tab-prompt')?.value || '').trim(),
    size: sizeMap[ratio] || '1024x1536',
    n,
    stream,
  };
}

async function handleImagineGeneratedUrls(urls) {
  if (!Array.isArray(urls) || !urls.length) return;
  urls.forEach((src) => addWorkflowImage(src, 'imagine-generate'));
  prependImagineTabGeneratedCards(urls);
  if (!workflowState.selectedImage) {
    setWorkflowSelection(urls[0], 'imagine-generate', true);
  } else {
    saveWorkflowState();
    renderWorkflowState();
  }
}

async function generateImagineTabNonStream(body) {
  const { res, payload } = await fetchImagineTabJson('/api/v1/imagine/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: false }),
  });
  if (!res.ok) {
    throw new Error(extractApiErrorMessage(payload, res.status));
  }
  const urls = extractImagineImageUrls(payload);
  if (!urls.length) throw new Error('未返回有效图片');
  await handleImagineGeneratedUrls(urls);
  return urls;
}

async function generateImagineTabStream(body) {
  const { res, payload, rawError } = await fetchImagineTabStream('/api/v1/imagine/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok || !res.body) {
    const fallback = String(rawError || '').slice(0, 200);
    throw new Error(extractApiErrorMessage(payload, res.status, fallback || `HTTP ${res.status}`));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completedUrls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const raw of lines) {
      const line = String(raw || '').trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt = null;
      try {
        evt = JSON.parse(payload);
      } catch (e) {
        continue;
      }
      const evtType = String(evt?.event || '').trim();
      if (evtType === 'progress') {
        const stageRaw = String(evt?.stage || '').trim();
        const stage = stageRaw === 'final' ? '完成阶段' : stageRaw === 'medium' ? '生成中' : '预览中';
        const pct = stageRaw === 'final' ? 90 : stageRaw === 'medium' ? 60 : 30;
        const status = evt?.image_id ? `图片: ${String(evt.image_id).slice(0, 8)}...` : '';
        setImagineTabProgress(true, pct, stage, status);
      } else if (evtType === 'complete') {
        completedUrls = extractImagineImageUrls(evt);
        setImagineTabProgress(true, 100, '完成', '');
      } else if (evtType === 'error') {
        throw new Error(evt?.message || evt?.error || '未知错误');
      }
    }
  }

  if (!completedUrls.length) throw new Error('未返回有效图片');
  await handleImagineGeneratedUrls(completedUrls);
  return completedUrls;
}

async function generateImagineTab() {
  if (imagineTabGenerating) return showToast('任务进行中，请稍候', 'warning');
  const body = buildImagineGenerateBody();
  if (!body.prompt) return showToast('请输入 Imagine prompt', 'warning');

  setImagineTabGeneratingState(true);
  setImagineTabProgress(true, 5, '准备中...', '');
  try {
    let generatedUrls = [];
    if (body.stream) {
      generatedUrls = await generateImagineTabStream(body);
    } else {
      generatedUrls = await generateImagineTabNonStream(body);
      setImagineTabProgress(true, 100, '完成', '');
    }
    await refreshImagineTabGalleryWithRetry(generatedUrls);
    showToast('Imagine 生成完成', 'success');
  } catch (e) {
    setImagineTabProgress(true, 100, '失败', e?.message || String(e));
    showToast(`Imagine 生成失败: ${e?.message || e}`, 'error');
  } finally {
    setImagineTabGeneratingState(false);
    setTimeout(() => setImagineTabProgress(false, 0, '', ''), 2500);
  }
}

function buildWorkflowActionRow(src, origin) {
  const row = document.createElement('div');
  row.className = 'workflow-inline-actions';
  row.innerHTML = `
    <button type="button" class="wf-inline-btn">选中工作图</button>
    <button type="button" class="wf-inline-btn">去编辑</button>
    <button type="button" class="wf-inline-btn">去视频</button>
  `;
  const [selectBtn, editBtn, videoBtn] = Array.from(row.querySelectorAll('button'));
  selectBtn?.addEventListener('click', () => setWorkflowSelection(src, origin, true));
  editBtn?.addEventListener('click', () => {
    setWorkflowSelection(src, origin, true);
    switchTab('edit');
  });
  videoBtn?.addEventListener('click', () => {
    setWorkflowSelection(src, origin, true);
    switchTab('video');
  });
  return row;
}

function attachWorkflowActions(container, src, origin) {
  if (!container || !src) return;
  const absolute = toAbsoluteUrl(src);
  addWorkflowImage(absolute, origin);
  if (container.querySelector('.workflow-inline-actions')) return;
  container.appendChild(buildWorkflowActionRow(absolute, origin));
}

async function ensureParentPostIdForSelection(force = false, silent = false) {
  const selectedRaw = String(workflowState.selectedImage || '').trim();
  if (!selectedRaw) return '';
  const selected = toAbsoluteUrl(normalizeImagineGalleryUrl(selectedRaw, ''));
  if (!getUserApiKey()) return '';

  if (selected && selected !== selectedRaw) {
    workflowState.selectedImage = selected;
    saveWorkflowState();
  }

  const item = findWorkflowItemBySrc(selected);
  if (!force && item?.parentPostId) {
    workflowState.parentPostId = item.parentPostId;
    saveWorkflowState();
    renderWorkflowState();
    return item.parentPostId;
  }
  if (workflowBusy) return workflowState.parentPostId;

  workflowBusy = true;
  renderWorkflowState();
  try {
    const endpoint = String(workflowCapabilities.parentPostEndpoint || '/v1/video/parent-post').trim();
    const headers = { ...buildApiHeaders(), 'Content-Type': 'application/json' };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ image_url: selected }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error?.message || payload?.detail || `HTTP ${res.status}`);
    const postId = String(payload?.parent_post_id || '').trim();
    if (!postId) throw new Error('parent_post_id is empty');

    workflowState.parentPostId = postId;
    if (item) item.parentPostId = postId;
    saveWorkflowState();
    renderWorkflowState();
    return postId;
  } catch (e) {
    if (!silent) showToast(`解析 parentPostId 失败: ${e?.message || e}`, 'error');
    return '';
  } finally {
    workflowBusy = false;
    renderWorkflowState();
  }
}

function extractVideoUrlsFromContent(content) {
  const urls = [];
  const pushUrl = (raw) => {
    const value = String(raw || '').trim();
    if (!value) return;
    const absolute = toAbsoluteUrl(value);
    if (!absolute) return;
    if (!urls.includes(absolute)) urls.push(absolute);
  };
  const html = String(content || '').trim();
  if (!html) return urls;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  doc.querySelectorAll('video,source,a').forEach((el) => {
    let raw = '';
    if (el.tagName.toUpperCase() === 'A') raw = String(el.getAttribute('href') || '').trim();
    else raw = String(el.getAttribute('src') || '').trim();
    pushUrl(raw);
  });
  const markdownRegex = /\[[^\]]*]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/gi;
  for (const m of html.matchAll(markdownRegex)) {
    pushUrl(m[1]);
  }
  const plainUrlRegex = /(https?:\/\/[^\s"'<>]+|\/v1\/files\/video\/[^\s"'<>]+)/gi;
  for (const m of html.matchAll(plainUrlRegex)) {
    pushUrl(m[1]);
  }
  return urls;
}

function addVideoClip(url, selected = true) {
  const absolute = toAbsoluteUrl(url);
  if (!absolute) return null;
  let clip = workflowState.videoClips.find((it) => it.url === absolute) || null;
  if (!clip) {
    clip = {
      id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url: absolute,
      createdAt: Date.now(),
      selected,
    };
    workflowState.videoClips.unshift(clip);
  } else {
    clip.selected = selected;
  }
  if (workflowState.videoClips.length > 60) workflowState.videoClips = workflowState.videoClips.slice(0, 60);
  saveWorkflowState();
  renderVideoClips();
  return clip;
}

function captureVideoClipsFromContent(content) {
  const urls = extractVideoUrlsFromContent(content);
  urls.forEach((url) => addVideoClip(url, true));
}

function selectAllVideoClips(flag) {
  workflowState.videoClips.forEach((it) => {
    it.selected = Boolean(flag);
  });
  saveWorkflowState();
  renderVideoClips();
}

async function stitchSelectedVideos() {
  if (workflowCapabilities.videoStitchEnabled === false) {
    return showToast('当前部署未启用视频拼接（CF 模式）', 'warning');
  }
  const selected = workflowState.videoClips.filter((it) => it.selected !== false).map((it) => it.url);
  if (selected.length < 2) return showToast('请至少选择 2 段视频进行拼接', 'warning');

  const headers = { ...buildApiHeaders(), 'Content-Type': 'application/json' };
  if (!headers.Authorization) return showToast('请先填写 API Key', 'warning');

  const btn = q('video-stitch-btn');
  const oldText = btn?.textContent || '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '拼接中...';
  }

  try {
    const res = await fetch('/v1/video/stitch', {
      method: 'POST',
      headers,
      body: JSON.stringify({ videos: selected }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.detail || payload?.error || `HTTP ${res.status}`);
    const url = String(payload?.url || '').trim();
    if (!url) throw new Error('No stitched video URL');
    addVideoClip(url, true);
    showToast(`拼接完成（${payload?.mode || 'copy'}）`, 'success');

    const results = q('video-results');
    if (results) {
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      renderContent(
        bubble,
        `<video controls preload="none"><source src="${escapeHtml(url)}" type="video/mp4"></video>`,
        false,
      );
      results.prepend(bubble);
    }
  } catch (e) {
    showToast(`视频拼接失败: ${e?.message || e}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '拼接选中片段';
    }
  }
}

function clearVideoClips() {
  workflowState.videoClips = [];
  saveWorkflowState();
  renderVideoClips();
}

function getImageRunMode() {
  const value = String(q('image-run-mode')?.value || 'single').trim().toLowerCase();
  return value === 'continuous' ? 'continuous' : 'single';
}

function getImageContinuousConcurrency() {
  return Math.max(1, Math.min(3, Math.floor(Number(q('image-concurrency')?.value || 1) || 1)));
}

function getImageContinuousActiveCount() {
  return imageContinuousSockets.filter((it) => it && it.active && !it.closed).length;
}

function getImageContinuousOpenCount() {
  return imageContinuousSockets.filter((it) => {
    const ws = it?.ws;
    if (!ws || it?.closed) return false;
    return ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING;
  }).length;
}

function setImageStatusText(text) {
  const el = q('image-status-text');
  if (el) el.textContent = String(text || '-');
}

function updateImageContinuousStats() {
  imageContinuousActive = getImageContinuousActiveCount();
  const countEl = q('image-count-value');
  const activeEl = q('image-active-value');
  const latencyEl = q('image-latency-value');
  const errorEl = q('image-error-value');
  if (countEl) countEl.textContent = String(imageContinuousCount);
  if (activeEl) activeEl.textContent = String(imageContinuousActive);
  if (latencyEl) {
    if (imageContinuousLatencyCount > 0) {
      latencyEl.textContent = `${Math.round(imageContinuousLatencyTotal / imageContinuousLatencyCount)}ms`;
    } else {
      latencyEl.textContent = '-';
    }
  }
  if (errorEl) errorEl.textContent = imageContinuousLastError || '-';
}

function updateImageContinuousButtons() {
  const isContinuous = imageGenerationExperimental && getImageRunMode() === 'continuous';
  const startBtn = q('image-start-btn');
  const stopBtn = q('image-stop-btn');
  if (startBtn) startBtn.disabled = !isContinuous || imageContinuousRunning;
  if (stopBtn) stopBtn.disabled = !isContinuous || !imageContinuousRunning;
}

function updateImageRunModeUI() {
  const isContinuous = imageGenerationExperimental && getImageRunMode() === 'continuous';
  const nWrap = q('image-n-wrap');
  const generateWrap = q('image-generate-wrap');
  const resultBox = q('image-results');
  const continuousWrap = q('image-continuous-wrap');
  const emptyState = q('image-empty-state');
  const waterfall = q('image-waterfall');

  if (nWrap) nWrap.classList.toggle('hidden', isContinuous);
  if (generateWrap) generateWrap.classList.toggle('hidden', isContinuous);
  if (resultBox) resultBox.classList.toggle('hidden', isContinuous);
  if (continuousWrap) continuousWrap.classList.toggle('hidden', !isContinuous);
  if (resultBox) resultBox.classList.remove('waterfall-layout');

  if (emptyState && waterfall) {
    emptyState.classList.toggle('hidden', waterfall.children.length > 0);
  }

  if (isContinuous && imageContinuousRunning) {
    setImageStatusText(imageContinuousActive > 0 ? 'Running' : 'Connecting');
  } else if (isContinuous) {
    setImageStatusText('Idle');
  }

  updateImageContinuousButtons();
  updateImageContinuousStats();
}

function updateImageModeUI() {
  const isExperimental = imageGenerationExperimental;
  const hint = q('image-mode-hint');
  const aspectWrap = q('image-aspect-wrap');
  const concurrencyWrap = q('image-concurrency-wrap');
  const runModeWrap = q('image-run-mode-wrap');
  const runMode = q('image-run-mode');

  if (!isExperimental && imageContinuousRunning) {
    stopImageContinuous();
  }

  if (hint) hint.classList.toggle('hidden', !isExperimental);
  if (aspectWrap) aspectWrap.classList.toggle('hidden', !isExperimental);
  if (concurrencyWrap) concurrencyWrap.classList.toggle('hidden', !isExperimental);
  if (runModeWrap) runModeWrap.classList.toggle('hidden', !isExperimental);
  if (runMode && !isExperimental) runMode.value = 'single';

  updateImageRunModeUI();
}

function clearImageContinuousError() {
  imageContinuousLastError = '';
  updateImageContinuousStats();
}

function setImageContinuousError(message) {
  imageContinuousLastError = String(message || '').trim() || 'unknown';
  updateImageContinuousStats();
}

function resetImageContinuousMetrics(resetCount) {
  if (resetCount) imageContinuousCount = 0;
  imageContinuousLatencyTotal = 0;
  imageContinuousLatencyCount = 0;
  imageContinuousActive = 0;
  clearImageContinuousError();
  updateImageContinuousStats();
}

function appendWaterfallImage(item, connectionIndex) {
  const src = pickImageSrc(item);
  if (!src) return;

  const waterfall = q('image-waterfall');
  if (!waterfall) return;

  const seq = Number(item?.sequence) || waterfall.children.length + 1;
  const elapsed = Math.max(0, Number(item?.elapsed_ms) || 0);
  const ratio = String(item?.aspect_ratio || '').trim();

  const card = document.createElement('div');
  card.className = 'waterfall-item';
  card.innerHTML = `
    <img alt="image" src="${src}" />
    <div class="waterfall-meta">
      <span>#${seq} 路 WS${connectionIndex + 1}</span>
      <span>${ratio || '-'} 路 ${elapsed > 0 ? `${elapsed}ms` : '-'}</span>
    </div>
  `;
  waterfall.prepend(card);
  const imageEl = card.querySelector('img');
  bindRetryableImage(imageEl);
  imageEl?.addEventListener('click', () => openImaginePreview(src));
  attachWorkflowActions(card, src, 'ws-waterfall');
  if (!workflowState.selectedImage) {
    setWorkflowSelection(src, 'ws-waterfall', false);
  }

  imageContinuousCount += 1;
  if (elapsed > 0) {
    imageContinuousLatencyTotal += elapsed;
    imageContinuousLatencyCount += 1;
  }

  const emptyState = q('image-empty-state');
  if (emptyState) emptyState.classList.add('hidden');
  updateImageContinuousStats();
}

function clearImageWaterfall() {
  const waterfall = q('image-waterfall');
  const emptyState = q('image-empty-state');
  if (waterfall) waterfall.innerHTML = '';
  if (emptyState) emptyState.classList.remove('hidden');
  resetImageContinuousMetrics(true);
}

function buildImagineWsUrl() {
  const key = getUserApiKey();
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL('/api/v1/admin/imagine/ws', `${proto}//${window.location.host}`);
  if (key) url.searchParams.set('api_key', key);
  return url.toString();
}

function parseWsMessage(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function openImageContinuousSocket(socketIndex, runToken, prompt, aspectRatio, attempt = 0) {
  const wsUrl = buildImagineWsUrl();
  const ws = new WebSocket(wsUrl);
  const socketState = {
    index: socketIndex,
    ws,
    runToken,
    attempt,
    active: false,
    closed: false,
    hadError: false,
    lastError: '',
    runId: '',
  };
  imageContinuousSockets.push(socketState);
  updateImageContinuousStats();

  ws.onopen = () => {
    if (!imageContinuousRunning || runToken !== imageContinuousRunToken || getImageRunMode() !== 'continuous') {
      try { ws.close(1000, 'stale'); } catch (e) {}
      return;
    }
    clearImageContinuousError();
    ws.send(JSON.stringify({ type: 'start', prompt, aspect_ratio: aspectRatio }));
  };

  ws.onmessage = (event) => {
    const data = parseWsMessage(event?.data);
    if (!data || runToken !== imageContinuousRunToken) return;
    const msgType = String(data?.type || '').trim();

    if (msgType === 'status') {
      const status = String(data?.status || '').trim().toLowerCase();
      socketState.runId = String(data?.run_id || socketState.runId || '');
      socketState.active = status === 'running';
      updateImageContinuousStats();
      if (imageContinuousRunning) {
        if (status === 'running') {
          clearImageContinuousError();
          setImageStatusText('Running');
        }
        if (status === 'stopped') setImageStatusText('Stopped');
      }
      updateImageContinuousButtons();
      return;
    }

    if (msgType === 'image') {
      socketState.active = true;
      clearImageContinuousError();
      appendWaterfallImage(data, socketIndex);
      if (imageContinuousRunning) setImageStatusText('Running');
      updateImageContinuousButtons();
      return;
    }

    if (msgType === 'error') {
      const message = String(data?.message || 'unknown error').trim() || 'unknown error';
      setImageContinuousError(message);
      if (imageContinuousRunning) setImageStatusText('Running (with errors)');
      return;
    }

    if (msgType === 'pong') {
      if (imageContinuousRunning && imageContinuousActive <= 0) setImageStatusText('Connected');
    }
  };

  ws.onerror = () => {
    if (runToken !== imageContinuousRunToken) return;
    socketState.hadError = true;
    socketState.lastError = `WS${socketIndex + 1} connection error`;
  };

  ws.onclose = (event) => {
    socketState.closed = true;
    socketState.active = false;
    updateImageContinuousStats();

    if (runToken !== imageContinuousRunToken) return;
    if (imageContinuousRunning) {
      const stillActive = getImageContinuousActiveCount();
      const stillOpen = getImageContinuousOpenCount();

      if (event?.code === 1008 && stillActive <= 0 && stillOpen <= 0) {
        setImageContinuousError('WebSocket auth rejected. Check API key.');
        setImageStatusText('Auth failed');
      } else if (socketState.hadError && stillActive <= 0 && stillOpen <= 0) {
        const closeCode = Number(event?.code || 0);
        const closeReason = String(event?.reason || '').trim();
        if (closeCode > 0) {
          const suffix = closeReason ? `: ${closeReason}` : '';
          setImageContinuousError(`WebSocket closed (${closeCode})${suffix}`);
        } else {
          setImageContinuousError(socketState.lastError || `WS${socketIndex + 1} connection error`);
        }
        setImageStatusText('Disconnected');
      }

      if (
        event?.code !== 1000 &&
        event?.code !== 1008 &&
        socketState.attempt < 1 &&
        getImageRunMode() === 'continuous' &&
        imageGenerationExperimental
      ) {
        setTimeout(() => {
          if (!imageContinuousRunning || runToken !== imageContinuousRunToken) return;
          if (getImageContinuousOpenCount() >= imageContinuousDesiredConcurrency) return;
          openImageContinuousSocket(socketIndex, runToken, prompt, aspectRatio, socketState.attempt + 1);
        }, 1200);
      }

      if (stillActive <= 0 && stillOpen <= 0 && event?.code === 1000) {
        setImageStatusText('Stopped');
      }
      updateImageContinuousButtons();
    }
  };
}

function stopImageContinuous() {
  imageContinuousRunToken += 1;
  imageContinuousRunning = false;
  imageContinuousActive = 0;

  imageContinuousSockets.forEach((state) => {
    const ws = state?.ws;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }));
      }
    } catch (e) {}
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'client stop');
      }
    } catch (e) {}
    state.closed = true;
    state.active = false;
  });
  imageContinuousSockets = [];

  if (imageGenerationExperimental && getImageRunMode() === 'continuous') {
    setImageStatusText('Stopped');
  } else {
    setImageStatusText('Idle');
  }
  updateImageContinuousButtons();
  updateImageContinuousStats();
}

function startImageContinuous() {
  if (!imageGenerationExperimental || getImageRunMode() !== 'continuous') {
    return;
  }
  const prompt = String(q('image-prompt')?.value || '').trim();
  if (!prompt) {
    showToast('Please input prompt', 'warning');
    return;
  }
  if (!getUserApiKey()) {
    showToast('Please input API key first', 'warning');
    return;
  }

  const aspectRatio = String(q('image-aspect')?.value || '2:3').trim() || '2:3';
  const concurrency = getImageContinuousConcurrency();
  const token = imageContinuousRunToken + 1;
  imageContinuousDesiredConcurrency = concurrency;

  stopImageContinuous();
  imageContinuousRunToken = token;
  imageContinuousRunning = true;
  clearImageContinuousError();
  imageContinuousActive = 0;
  if (!q('image-waterfall')?.children?.length) resetImageContinuousMetrics(true);

  setImageStatusText('Connecting');
  updateImageContinuousButtons();
  updateImageContinuousStats();

  for (let i = 0; i < concurrency; i += 1) {
    openImageContinuousSocket(i, token, prompt, aspectRatio);
  }
}

function isExperimentalImageMethod(method) {
  const value = String(method || '').trim().toLowerCase();
  return (
    value === 'imagine_ws_experimental' ||
    value === 'imagine_ws' ||
    value === 'experimental' ||
    value === 'new' ||
    value === 'new_method'
  );
}

async function refreshImageGenerationMethod() {
  const headers = buildApiHeaders();
  imageGenerationMethod = 'legacy';
  imageGenerationExperimental = false;

  if (!headers.Authorization) {
    stopImageContinuous();
    updateImageModeUI();
    return;
  }

  try {
    const res = await fetch(`/v1/images/method?t=${Date.now()}`, {
      headers,
      cache: 'no-store',
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const method = String(data?.image_generation_method || data?.method || '').trim().toLowerCase();
      imageGenerationMethod = method || 'legacy';
      imageGenerationExperimental = isExperimentalImageMethod(imageGenerationMethod);
    }
  } catch (e) {}

  if (!imageGenerationExperimental) {
    stopImageContinuous();
  }

  updateImageModeUI();
}

async function refreshModels() {
  const sel = q('model-select');
  const previousValue = String(sel.value || '').trim();
  sel.innerHTML = '';

  const headers = buildApiHeaders();
  if (!headers.Authorization) {
    showToast('请先填写 API Key', 'warning');
    return;
  }

  try {
    const res = await fetch('/v1/models', { headers });
    if (res.status === 401) {
      showToast('API Key 无效或未授权', 'error');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    models = Array.isArray(data?.data) ? data.data : [];

    const imageModelIds = new Set(['grok-imagine', 'grok-imagine-1.0']);
    const filtered = models.filter((m) => {
      const id = String(m.id || '');
      if (currentTab === 'imagine') return imageModelIds.has(id);
      if (currentTab === 'image') return imageModelIds.has(id);
      if (currentTab === 'edit') return id === 'grok-imagine-1.0-edit';
      if (currentTab === 'video') return id === 'grok-imagine-1.0-video';
      return !/imagine/i.test(id) || id === 'grok-4-heavy';
    });

    const filteredIds = [];
    filtered.forEach((m) => {
      const opt = document.createElement('option');
      const id = String(m.id || '');
      const label = String(m.display_name || id);
      filteredIds.push(id);
      opt.value = id;
      opt.textContent = `${label} (${id})`;
      sel.appendChild(opt);
    });

    if (currentTab === 'imagine') {
      if (filteredIds.includes('grok-imagine')) {
        sel.value = 'grok-imagine';
      } else {
        sel.value = filteredIds.includes('grok-imagine-1.0') ? 'grok-imagine-1.0' : (filteredIds[0] || '');
      }
      return;
    }
    if (currentTab === 'image') {
      if (previousValue && filteredIds.includes(previousValue)) {
        sel.value = previousValue;
      } else if (filteredIds.includes('grok-imagine')) {
        sel.value = 'grok-imagine';
      } else if (filteredIds.includes('grok-imagine-1.0')) {
        sel.value = 'grok-imagine-1.0';
      } else {
        sel.value = filteredIds[0] || '';
      }
      return;
    }
    if (currentTab === 'edit') {
      sel.value = filteredIds.includes('grok-imagine-1.0-edit') ? 'grok-imagine-1.0-edit' : (filteredIds[0] || '');
      return;
    }
    if (currentTab === 'video') {
      sel.value = filteredIds.includes('grok-imagine-1.0-video') ? 'grok-imagine-1.0-video' : (filteredIds[0] || '');
      return;
    }
    if (previousValue && filteredIds.includes(previousValue)) {
      sel.value = previousValue;
    } else if (filteredIds.includes(PREFERRED_CHAT_MODEL)) {
      sel.value = PREFERRED_CHAT_MODEL;
    } else {
      sel.value = filteredIds[0] || '';
    }
  } catch (e) {
    showToast('加载模型失败: ' + (e?.message || e), 'error');
  }
}

function saveApiKey() {
  const oldKey = String(localStorage.getItem(STORAGE_KEY) || '').trim();
  const k = getUserApiKey();
  if (!k) return showToast('请输入 API Key', 'warning');
  stopImageContinuous();
  localStorage.setItem(STORAGE_KEY, k);
  if (oldKey !== k) {
    workflowState.parentPostId = '';
    workflowState.gallery.forEach((it) => {
      it.parentPostId = '';
    });
    saveWorkflowState();
    renderWorkflowState();
  }
  showToast('已保存', 'success');
  refreshModels();
  refreshImageGenerationMethod();
}

function clearApiKey() {
  stopImageContinuous();
  localStorage.removeItem(STORAGE_KEY);
  q('api-key-input').value = '';
  imageGenerationMethod = 'legacy';
  imageGenerationExperimental = false;
  updateImageModeUI();
  workflowState.parentPostId = '';
  workflowState.gallery.forEach((it) => {
    it.parentPostId = '';
  });
  saveWorkflowState();
  renderWorkflowState();
  showToast('已清除', 'success');
}

function switchTab(tab) {
  if (currentTab === 'image' && tab !== 'image') {
    stopImageContinuous();
  }
  currentTab = tab;
  ['chat', 'image', 'edit', 'video'].forEach((t) => {
    const tabEl = q(`tab-${t}`);
    const panelEl = q(`panel-${t}`);
    if (tabEl) tabEl.classList.toggle('active', t === tab);
    if (panelEl) panelEl.classList.toggle('hidden', t !== tab);
  });
  updateWorkflowBoardVisibility(tab);
  refreshModels();
  if (tab === 'image') refreshImageGenerationMethod();
  renderWorkflowState();
  if (tab === 'video' && workflowState.selectedImage && !workflowState.parentPostId) {
    ensureParentPostIdForSelection(false, true);
  }
}

function pickChatImage() {
  q('chat-file').click();
}

function pickVideoImage() {
  q('video-file').click();
}

async function uploadImages(files) {
  const headers = buildApiHeaders();
  if (!headers.Authorization) throw new Error('Missing API Key');

  const uploaded = [];
  for (const f of files) {
    const fd = new FormData();
    fd.append('file', f);
    const res = await fetch('/v1/uploads/image', { method: 'POST', headers, body: fd });
    if (res.status === 401) throw new Error('Unauthorized');
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Upload failed (${res.status})`);
    uploaded.push(toAbsoluteUrl(String(data.url || '')));
  }
  return uploaded.filter(Boolean);
}

async function retryLastAssistantAnswer() {
  if (chatSending) return showToast('请求进行中，请稍候重试', 'warning');

  const lastUserIndex = findLastUserMessageIndex(chatMessages);
  if (lastUserIndex < 0) return showToast('没有可重试的回答', 'warning');

  const retryMessages = chatMessages.slice(0, lastUserIndex + 1);
  const model = getSelectedChatModel();
  if (!model) return showToast('当前没有可用聊天模型', 'error');

  const stream = Boolean(q('stream-toggle').checked);
  const headers = { ...buildApiHeaders(), 'Content-Type': 'application/json' };
  if (!headers.Authorization) return showToast('请先填写 API Key', 'warning');

  const assistantBubble = showUserMsg('assistant', '');
  setChatSendingState(true);
  try {
    const body = { model, messages: retryMessages, stream };
    if (stream) {
      const content = await streamChat(body, assistantBubble, false);
      chatMessages = [...retryMessages, { role: 'assistant', content }];
    } else {
      const res = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('API Key 无效或未授权');
      if (!res.ok) throw new Error(data?.error?.message || data?.detail || `HTTP ${res.status}`);
      const content = String(data?.choices?.[0]?.message?.content || '');
      renderContent(assistantBubble, content, false);
      chatMessages = [...retryMessages, { role: 'assistant', content }];
    }
    attachAssistantRetryAction(assistantBubble);
  } catch (e) {
    showToast('重试失败: ' + (e?.message || e), 'error');
  } finally {
    setChatSendingState(false);
  }
}

async function sendChat() {
  if (chatSending) return showToast('请求进行中，请稍候重试', 'warning');

  const prompt = String(q('chat-input').value || '').trim();
  if (!prompt && !chatAttachments.length) return showToast('请输入内容或上传图片', 'warning');

  const model = getSelectedChatModel();
  if (!model) return showToast('当前没有可用聊天模型', 'error');
  const stream = Boolean(q('stream-toggle').checked);

  const headers = { ...buildApiHeaders(), 'Content-Type': 'application/json' };
  if (!headers.Authorization) return showToast('请先填写 API Key', 'warning');

  setChatSendingState(true);
  try {
    let imgUrls = [];
    if (chatAttachments.length) {
      showToast('上传图片中...', 'info');
      imgUrls = await uploadImages(chatAttachments.map((x) => x.file));
    }

    const userContent = imgUrls.length
      ? [{ type: 'text', text: prompt || ' ' }, ...imgUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
      : prompt;

    chatMessages.push({ role: 'user', content: userContent });

    showUserMsg('user', prompt || '[图片]');
    q('chat-input').value = '';
    chatAttachments.forEach((a) => {
      try { URL.revokeObjectURL(a.previewUrl); } catch (e) {}
    });
    chatAttachments = [];
    renderAttachments('chat');

    const body = { model, messages: chatMessages, stream };

    if (stream) {
      const assistantBubble = showUserMsg('assistant', '');
      await streamChat(body, assistantBubble);
      attachAssistantRetryAction(assistantBubble);
    } else {
      const res = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('API Key 无效或未授权');
      if (!res.ok) throw new Error(data?.error?.message || data?.detail || `HTTP ${res.status}`);
      const content = data?.choices?.[0]?.message?.content || '';
      chatMessages.push({ role: 'assistant', content });
      const assistantBubble = showUserMsg('assistant', content);
      attachAssistantRetryAction(assistantBubble);
    }
  } catch (e) {
    showToast('发送失败: ' + (e?.message || e), 'error');
  } finally {
    setChatSendingState(false);
  }
}

async function streamChat(body, bubbleEl, commitHistory = true) {
  const headers = { ...buildApiHeaders(), 'Content-Type': 'application/json' };
  const res = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        if (commitHistory) chatMessages.push({ role: 'assistant', content: acc });
        return acc;
      }
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          acc += delta;
          renderContent(bubbleEl, acc, false);
          q('chat-messages').scrollTop = q('chat-messages').scrollHeight;
        }
      } catch (e) {}
    }
  }

  if (commitHistory) chatMessages.push({ role: 'assistant', content: acc });
  return acc;
}

function createImageCard(index) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.dataset.index = String(index);
  card.innerHTML = `
    <div class="result-placeholder">等待生成...</div>
    <div class="result-progress"><div class="result-progress-bar"></div></div>
    <div class="result-meta"><span>#${index + 1}</span><span class="result-status">0%</span></div>
  `;
  return card;
}

function ensureImageCard(cardMap, index) {
  const key = Number(index) || 0;
  if (cardMap.has(key)) return cardMap.get(key);
  const card = createImageCard(key);
  q('image-results').appendChild(card);
  cardMap.set(key, card);
  return card;
}

function updateImageCardProgress(card, progress) {
  const pct = Math.max(0, Math.min(100, Number(progress) || 0));
  const bar = card.querySelector('.result-progress-bar');
  const status = card.querySelector('.result-status');
  if (bar) bar.style.width = `${pct}%`;
  if (status) status.textContent = `${pct}%`;
}

function updateImageCardCompleted(card, src, failed) {
  const placeholder = card.querySelector('.result-placeholder');
  const progress = card.querySelector('.result-progress');
  const status = card.querySelector('.result-status');

  if (progress) progress.remove();

  if (failed) {
    card.classList.add('is-error');
    if (placeholder) placeholder.textContent = '生成失败';
    if (status) status.textContent = '失败';
    return;
  }

  card.classList.remove('is-error');
  if (placeholder) placeholder.remove();

  const img = document.createElement('img');
  img.alt = 'image';
  img.src = src;
  bindRetryableImage(img);
  img.addEventListener('click', () => openImaginePreview(src));
  card.insertBefore(img, card.firstChild);
  attachWorkflowActions(card, src, 'image-result');
  if (!workflowState.selectedImage) {
    setWorkflowSelection(src, 'image-result', false);
  }

  if (status) status.textContent = '完成';
}

function buildImageRequestConfig() {
  const ratio = String(q('image-aspect')?.value || '2:3');
  const concurrency = Math.max(1, Math.min(3, Math.floor(Number(q('image-concurrency')?.value || 1) || 1)));
  if (!imageGenerationExperimental) {
    return { size: '1024x1024', concurrency: 1 };
  }
  return { size: ratio, concurrency };
}

async function streamImage(body, headers) {
  const res = await fetch('/v1/images/generations', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true }),
  });

  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const cardMap = new Map();
  const completedSet = new Set();
  let rendered = 0;
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() || '';

    for (const block of blocks) {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      if (!lines.length) continue;

      let event = '';
      const dataLines = [];
      lines.forEach((line) => {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      });

      const payload = dataLines.join('\n').trim();
      if (!payload) continue;
      if (payload === '[DONE]') return rendered;

      let obj = null;
      try {
        obj = JSON.parse(payload);
      } catch (e) {
        continue;
      }

      const type = String(obj?.type || event || '').trim();
      const idx = Math.max(0, Number(obj?.index) || 0);
      const card = ensureImageCard(cardMap, idx);

      if (type === 'image_generation.partial_image') {
        updateImageCardProgress(card, obj?.progress ?? 0);
        continue;
      }

      if (type === 'image_generation.completed') {
        const src = pickImageSrc(obj);
        const failed = !src;
        updateImageCardCompleted(card, src, failed);
        if (!failed && !completedSet.has(idx)) {
          completedSet.add(idx);
          rendered += 1;
        }
      }
    }
  }

  return rendered;
}

async function generateImage() {
  const prompt = String(q('image-prompt').value || '').trim();
  if (!prompt) return showToast('请输入 prompt', 'warning');

  const headers = { ...buildApiHeaders(), 'Content-Type': 'application/json' };
  if (!headers.Authorization) return showToast('请先填写 API Key', 'warning');

  if (imageGenerationExperimental && getImageRunMode() === 'continuous') {
    startImageContinuous();
    return;
  }

  stopImageContinuous();

  const model = String(q('model-select').value || 'grok-imagine-1.0').trim();
  const n = Math.max(1, Math.min(10, Math.floor(Number(q('image-n').value || 1) || 1)));
  const stream = Boolean(q('stream-toggle').checked);
  const useStream = stream && n <= 2;
  const { size, concurrency } = buildImageRequestConfig();

  q('image-results').innerHTML = '';
  showToast('生成中...', 'info');

  const reqBody = { prompt, model, n, size, concurrency };
  try {
    if (stream && !useStream) {
      showToast('n > 2 disables stream and falls back to non-stream mode.', 'warning');
    }

    if (useStream) {
      const rendered = await streamImage(reqBody, headers);
      if (!rendered) throw new Error('No image generated');
      return;
    }

    const res = await fetch('/v1/images/generations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...reqBody, stream: false }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.detail || `HTTP ${res.status}`);

    const items = Array.isArray(data?.data) ? data.data : [];
    if (!items.length) throw new Error('No image generated');

    let rendered = 0;
    items.forEach((it, idx) => {
      const src = pickImageSrc(it);
      const card = createImageCard(idx);
      q('image-results').appendChild(card);
      if (!src) {
        updateImageCardCompleted(card, '', true);
        return;
      }
      rendered += 1;
      updateImageCardCompleted(card, src, false);
    });

    if (!rendered) throw new Error('Image data is empty or unsupported');
  } catch (e) {
    showToast('生图失败: ' + (e?.message || e), 'error');
  }
}

function setEditGeneratingState(running) {
  editGenerating = Boolean(running);
  const btn = q('edit-run-btn');
  if (btn) btn.disabled = editGenerating;
}

function clearEditResults() {
  const box = q('edit-results');
  if (box) box.innerHTML = '';
}

function dataUrlToBlob(dataUrl) {
  const raw = String(dataUrl || '');
  const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) throw new Error('Invalid data URL');
  const mime = match[1] || 'image/png';
  const b64 = match[2] || '';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function sourceToImageFile(src) {
  const value = String(src || '').trim();
  if (!value) throw new Error('Missing image source');

  let blob = null;
  if (value.startsWith('data:image/')) {
    blob = dataUrlToBlob(value);
  } else {
    const normalized = toAbsoluteUrl(normalizeImagineGalleryUrl(value, '')) || value;
    const res = await fetch(normalized, { cache: 'no-store', headers: buildApiHeaders() });
    if (!res.ok) throw new Error(`Load image failed (${res.status})`);
    blob = await res.blob();
  }
  const ext = (blob.type || 'image/png').split('/')[1] || 'png';
  const filename = `workflow-${Date.now()}.${ext}`;
  return new File([blob], filename, { type: blob.type || 'image/png' });
}

async function generateImageEdit() {
  if (editGenerating) return showToast('编辑任务进行中，请稍候', 'warning');
  const prompt = String(q('edit-prompt')?.value || '').trim();
  if (!prompt) return showToast('请输入编辑 prompt', 'warning');

  const selectedSrc = String(workflowState.selectedImage || '').trim();
  if (!selectedSrc) return showToast('请先在生图结果中选择一张工作图', 'warning');

  const headers = buildApiHeaders();
  if (!headers.Authorization) return showToast('请先填写 API Key', 'warning');

  const n = Math.max(1, Math.min(6, Math.floor(Number(q('edit-n')?.value || 1) || 1)));
  const model = 'grok-imagine-1.0-edit';

  setEditGeneratingState(true);
  try {
    const imageFile = await sourceToImageFile(selectedSrc);
    const fd = new FormData();
    fd.append('prompt', prompt);
    fd.append('model', model);
    fd.append('n', String(n));
    fd.append('stream', 'false');
    fd.append('response_format', 'url');
    fd.append('image', imageFile, imageFile.name);

    const res = await fetch('/v1/images/edits', {
      method: 'POST',
      headers,
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || data?.detail || `HTTP ${res.status}`);

    const items = Array.isArray(data?.data) ? data.data : [];
    if (!items.length) throw new Error('No edited image returned');
    clearEditResults();

    let firstSrc = '';
    items.forEach((it, idx) => {
      const src = pickImageSrc(it);
      if (!src) return;
      if (!firstSrc) firstSrc = src;
      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <img alt="edit-image" src="${src}" />
        <div class="result-meta"><span>#${idx + 1}</span><span>编辑结果</span></div>
      `;
      bindRetryableImage(card.querySelector('img'));
      card.querySelector('img')?.addEventListener('click', () => openImaginePreview(src));
      attachWorkflowActions(card, src, 'edit-result');
      q('edit-results')?.appendChild(card);
    });
    if (!q('edit-results')?.children?.length) throw new Error('Edited image data is empty');

    if (firstSrc) {
      setWorkflowSelection(firstSrc, 'edit-result', true);
      showToast('编辑完成，已自动选中第一张结果', 'success');
    } else {
      showToast('编辑完成', 'success');
    }
  } catch (e) {
    showToast(`图片编辑失败: ${e?.message || e}`, 'error');
  } finally {
    setEditGeneratingState(false);
  }
}

function setVideoGeneratingState(running) {
  videoGenerating = Boolean(running);
  const btn = q('panel-video')?.querySelector('button[onclick="generateVideo()"]');
  if (btn) btn.disabled = videoGenerating;
}

async function generateVideo() {
  if (videoGenerating) return showToast('视频任务进行中，请稍候', 'warning');
  const prompt = String(q('video-prompt').value || '').trim();
  if (!prompt) return showToast('请输入 prompt', 'warning');

  const model = String(q('model-select').value || 'grok-imagine-1.0-video').trim();
  const stream = Boolean(q('stream-toggle').checked);
  const headers = { ...buildApiHeaders(), 'Content-Type': 'application/json' };
  if (!headers.Authorization) return showToast('请先填写 API Key', 'warning');

  const videoConfig = {
    aspect_ratio: String(q('video-aspect').value || '3:2'),
    video_length: Number(q('video-length').value || 6),
    // Keep a single stable output profile to maximize playback compatibility.
    resolution: 'SD',
    preset: 'normal',
    parent_post_id: '',
    nsfw_enabled: workflowState.nsfwEnabled !== false,
  };

  setVideoGeneratingState(true);
  try {
    let imgUrls = [];
    if (videoAttachments.length) {
      showToast('上传参考图中...', 'info');
      imgUrls = await uploadImages(videoAttachments.slice(0, 1).map((x) => x.file));
    } else {
      if (workflowState.selectedImage && !workflowState.parentPostId) {
        await ensureParentPostIdForSelection(false, true);
      }
      if (workflowState.parentPostId) {
        videoConfig.parent_post_id = workflowState.parentPostId;
      } else if (workflowState.selectedImage) {
        const normalized = toAbsoluteUrl(normalizeImagineGalleryUrl(workflowState.selectedImage, ''));
        imgUrls = [normalized || workflowState.selectedImage];
      }
    }

    const userContent = imgUrls.length
      ? [{ type: 'text', text: prompt }, ...imgUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
      : prompt;

    const reqBody = { model, messages: [{ role: 'user', content: userContent }], stream, video_config: videoConfig };

    q('video-results').innerHTML = '';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    q('video-results').appendChild(bubble);

    let content = '';
    if (stream) {
      content = await streamVideo(reqBody, bubble);
    } else {
      const res = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(reqBody) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.detail || `HTTP ${res.status}`);
      content = String(data?.choices?.[0]?.message?.content || '');
      renderContent(bubble, content, false);
    }

    captureVideoClipsFromContent(content);

    videoAttachments.forEach((a) => {
      try { URL.revokeObjectURL(a.previewUrl); } catch (e) {}
    });
    videoAttachments = [];
    renderAttachments('video');
  } catch (e) {
    showToast('生成视频失败: ' + (e?.message || e), 'error');
  } finally {
    setVideoGeneratingState(false);
  }
}

async function streamVideo(body, bubbleEl) {
  const headers = { ...buildApiHeaders(), 'Content-Type': 'application/json' };
  const res = await fetch('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let acc = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return acc;
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          acc += delta;
          renderContent(bubbleEl, acc, false);
        }
      } catch (e) {}
    }
  }
  return acc;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
