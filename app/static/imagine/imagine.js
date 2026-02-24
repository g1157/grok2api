let apiKey = null;
const WORKFLOW_STORAGE_KEY = 'grok2api_workflow_state_v2';
let workflowApiBearer = '';

let workflowBusy = false;
let workflowState = normalizeWorkflowState({});

document.addEventListener('DOMContentLoaded', async () => {
  apiKey = await ensureApiKey();
  if (!apiKey) return;
  loadWorkflowState();
  renderWorkflowState();
  loadSsoStatus();
  loadGallery();
});

function authHeaders() {
  return apiKey ? { 'Authorization': apiKey } : {};
}

async function resolveWorkflowAuthCandidates() {
  const candidates = [];
  const sessionAuth = String(apiKey || '').trim();
  if (sessionAuth) candidates.push(sessionAuth);

  if (!workflowApiBearer) {
    try {
      const res = await fetch('/api/v1/admin/config', { headers: authHeaders() });
      if (res.ok) {
        const cfg = await res.json().catch(() => ({}));
        const appKey = String(cfg?.app?.api_key || '').trim();
        if (appKey) workflowApiBearer = `Bearer ${appKey}`;
      }
    } catch (_) {}
  }
  if (workflowApiBearer && !candidates.includes(workflowApiBearer)) {
    candidates.push(workflowApiBearer);
  }
  candidates.push('');
  return candidates;
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toAbsoluteUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')) return value;
  try {
    return new URL(value, window.location.href).toString();
  } catch (_) {
    return value;
  }
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
        src: toAbsoluteUrl(String(it?.src || '').trim()),
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

function loadWorkflowState() {
  try {
    const raw = localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) return;
    workflowState = normalizeWorkflowState(JSON.parse(raw));
  } catch (_) {
    workflowState = normalizeWorkflowState({});
  }
}

function saveWorkflowState() {
  try {
    localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(workflowState));
  } catch (_) {}
}

function findWorkflowItemBySrc(src) {
  const target = toAbsoluteUrl(src);
  return workflowState.gallery.find((it) => it.src === target) || null;
}

function addWorkflowImage(src, origin) {
  const normalized = toAbsoluteUrl(src);
  if (!normalized) return null;
  let item = findWorkflowItemBySrc(normalized);
  if (!item) {
    item = {
      id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      src: normalized,
      origin: String(origin || '').trim() || 'imagine',
      parentPostId: '',
      createdAt: Date.now(),
    };
    workflowState.gallery.unshift(item);
  } else if (origin && !item.origin) {
    item.origin = String(origin).trim();
  }
  if (workflowState.gallery.length > 120) {
    workflowState.gallery = workflowState.gallery.slice(0, 120);
  }
  return item;
}

function renderWorkflowState() {
  const selectedUrlEl = document.getElementById('workflow-selected-url');
  const parentEl = document.getElementById('workflow-parent-post-id');
  const preview = document.getElementById('workflow-preview');

  const selected = String(workflowState.selectedImage || '').trim();
  if (selectedUrlEl) {
    selectedUrlEl.textContent = selected || '-';
    selectedUrlEl.title = selected || '';
  }
  if (parentEl) {
    parentEl.textContent = workflowState.parentPostId || (workflowBusy ? '解析中...' : '-');
  }
  if (preview) {
    if (selected) {
      preview.innerHTML = `<img src="${escapeHtml(selected)}" alt="workflow-selected" loading="lazy">`;
    } else {
      preview.innerHTML = '<span class="workflow-empty-tip">未选择工作图</span>';
    }
  }
}

function setWorkflowSelection(src, origin) {
  const item = addWorkflowImage(src, origin);
  if (!item) return null;
  workflowState.selectedImage = item.src;
  workflowState.selectedOrigin = item.origin || String(origin || '').trim();
  workflowState.parentPostId = String(item.parentPostId || '').trim();
  saveWorkflowState();
  renderWorkflowState();
  return item;
}

async function ensureWorkflowParentPostId(force = false, silent = false) {
  const selected = String(workflowState.selectedImage || '').trim();
  if (!selected) return '';

  const item = findWorkflowItemBySrc(selected);
  if (!force && item?.parentPostId) {
    workflowState.parentPostId = String(item.parentPostId || '').trim();
    saveWorkflowState();
    renderWorkflowState();
    return workflowState.parentPostId;
  }
  if (workflowBusy) return workflowState.parentPostId;

  workflowBusy = true;
  renderWorkflowState();
  try {
    const authCandidates = await resolveWorkflowAuthCandidates();
    let lastMessage = 'parent_post_id request failed';

    for (const auth of authCandidates) {
      const headers = { 'Content-Type': 'application/json' };
      if (auth) headers.Authorization = auth;
      const res = await fetch('/v1/video/parent-post', {
        method: 'POST',
        headers,
        body: JSON.stringify({ image_url: selected }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        const postId = String(payload?.parent_post_id || '').trim();
        if (!postId) {
          lastMessage = 'parent_post_id is empty';
          continue;
        }
        workflowState.parentPostId = postId;
        if (item) item.parentPostId = postId;
        saveWorkflowState();
        renderWorkflowState();
        return postId;
      }
      lastMessage = String(payload?.error?.message || payload?.detail || `HTTP ${res.status}`);
      if (res.status !== 401 && res.status !== 403) break;
    }

    throw new Error(lastMessage);
  } catch (e) {
    if (!silent && typeof showToast === 'function') {
      showToast('解析 parentPostId 失败: ' + (e?.message || e), 'error');
    }
    return '';
  } finally {
    workflowBusy = false;
    renderWorkflowState();
  }
}

async function syncToWorkflow(rawUrl, origin = 'imagine-gallery', resolveParent = true, silent = false) {
  const src = toAbsoluteUrl(rawUrl);
  if (!src) return;
  setWorkflowSelection(src, origin);
  renderWorkflowState();
  if (resolveParent) {
    await ensureWorkflowParentPostId(false, silent);
  }
  if (!silent && typeof showToast === 'function') {
    showToast('已同步到全局工作流', 'success');
  }
  loadGallery();
}

async function resolveWorkflowParentPostId() {
  if (!workflowState.selectedImage) {
    if (typeof showToast === 'function') showToast('请先在图片库中选择一张工作图', 'warning');
    return;
  }
  const postId = await ensureWorkflowParentPostId(true, false);
  if (postId && typeof showToast === 'function') {
    showToast('parentPostId 已更新', 'success');
  }
}

function extractImageUrls(payload) {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  return items
    .map((it) => toAbsoluteUrl(String(it?.url || '').trim()))
    .filter(Boolean);
}

// ---------- Stats ----------

function updateStats(pool, galleryCount) {
  const el = (id) => document.getElementById(id);
  if (pool) {
    el('stat-total').textContent = pool.total ?? '-';
    el('stat-available').textContent = pool.available ?? '-';
    el('stat-status').textContent = (pool.available ?? 0) > 0 ? '正常' : '无可用';
  }
  if (galleryCount !== undefined) {
    el('stat-gallery').textContent = galleryCount;
  }
}

// ---------- SSO Status ----------

async function loadSsoStatus() {
  try {
    const res = await fetch('/api/v1/imagine/status', { headers: authHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const pool = data.sso_pool || {};
    const tokens = pool.tokens || [];
    const tbody = document.getElementById('sso-tbody');

    updateStats(pool);

    if (!tokens.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-[var(--accents-4)] py-4">暂无 Token</td></tr>';
      return;
    }

    tbody.innerHTML = tokens.map((t) => `
      <tr>
        <td class="font-mono text-xs">${t.token || '***'}</td>
        <td>${t.daily_count ?? 0}</td>
        <td>${Math.max(0, (t.daily_limit || 50) - (t.daily_count || 0))}</td>
        <td><span class="imagine-badge ${t.fail_count > 0 ? 'imagine-badge-fail' : 'imagine-badge-ok'}">${t.fail_count > 0 ? '失败' : '正常'}</span></td>
        <td class="text-xs text-[var(--accents-4)]">${t.available ? '可用' : '不可用'}</td>
      </tr>
    `).join('');
  } catch (e) {
    document.getElementById('sso-tbody').innerHTML =
      `<tr><td colspan="5" class="text-center text-[var(--error)] py-4">加载失败: ${e.message}</td></tr>`;
  }
}

async function reloadSso() {
  try {
    await fetch('/api/v1/imagine/sso/reload', { method: 'POST', headers: authHeaders() });
    if (typeof showToast === 'function') showToast('SSO 已重新加载', 'success');
    loadSsoStatus();
  } catch (_) {}
}

async function resetDailyUsage() {
  if (!confirm('确认重置每日用量计数器？')) return;
  try {
    await fetch('/api/v1/imagine/sso/reset', { method: 'POST', headers: authHeaders() });
    if (typeof showToast === 'function') showToast('已重置', 'success');
    loadSsoStatus();
  } catch (_) {}
}

// ---------- Gallery ----------

async function loadGallery() {
  try {
    const res = await fetch('/api/v1/imagine/gallery', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('gallery');

    // Backend returns { success, data: [...], total } or { images: [...] }
    const items = data.data || data.images || [];
    updateStats(null, items.length);

    if (!items.length) {
      el.innerHTML = '<p class="text-[var(--accents-4)] col-span-full text-center py-8 text-sm">暂无图片</p>';
      return;
    }

    el.innerHTML = items.map((img) => {
      const name = String(img.name || img.filename || '');
      const rawUrl = String(img.url || `/api/v1/imagine/gallery/file/${name}`);
      const url = toAbsoluteUrl(rawUrl);
      const encodedName = encodeURIComponent(name);
      const encodedUrl = encodeURIComponent(url);
      const active = workflowState.selectedImage && toAbsoluteUrl(workflowState.selectedImage) === url;
      return `
        <div class="imagine-gallery-item${active ? ' is-selected' : ''}" onclick="openLightbox(decodeURIComponent('${encodedUrl}'))">
          <img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy">
          <div class="imagine-gallery-actions">
            <button class="imagine-sync-btn" onclick="event.stopPropagation();syncToWorkflow(decodeURIComponent('${encodedUrl}'), 'imagine-gallery', true);">设为工作图</button>
            <button class="imagine-delete-btn" onclick="event.stopPropagation();deleteImage(decodeURIComponent('${encodedName}'))" title="删除">&#x2715;</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (_) {}
}

async function deleteImage(name) {
  if (!confirm('确认删除此图片？')) return;
  try {
    await fetch('/api/v1/imagine/gallery/' + encodeURIComponent(name), {
      method: 'DELETE',
      headers: authHeaders(),
    });
    loadGallery();
  } catch (_) {}
}

async function clearGallery() {
  if (!confirm('确认清空所有图片？')) return;
  try {
    await fetch('/api/v1/imagine/gallery/clear', {
      method: 'POST',
      headers: authHeaders(),
    });
    loadGallery();
  } catch (_) {}
}

// ---------- Lightbox ----------

function openLightbox(url) {
  const overlay = document.getElementById('lightbox');
  document.getElementById('lightbox-img').src = url;
  overlay.classList.remove('hidden');
  overlay.classList.add('is-open');
}

function closeLightbox(e) {
  if (e.target === e.currentTarget || e.target.id === 'lightbox') {
    const overlay = document.getElementById('lightbox');
    overlay.classList.remove('is-open');
    overlay.classList.add('hidden');
  }
}

// ---------- Generation ----------

async function generateImages() {
  const prompt = document.getElementById('prompt').value.trim();
  if (!prompt) {
    if (typeof showToast === 'function') showToast('请输入 Prompt', 'error');
    return;
  }

  const btn = document.getElementById('btn-generate');
  btn.disabled = true;

  const sizeMap = { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024' };
  const ratio = document.getElementById('aspect-ratio').value;
  const body = {
    prompt,
    size: sizeMap[ratio] || '1024x1024',
    n: parseInt(document.getElementById('count').value),
    stream: document.getElementById('stream').checked,
  };

  if (body.stream) {
    await generateStream(body, btn);
  } else {
    await generateNonStream(body, btn);
  }
}

async function generateNonStream(body, btn) {
  try {
    const res = await fetch('/api/v1/imagine/generate', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: false }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.detail || 'Generation failed');

    const urls = extractImageUrls(data);
    if (urls.length) {
      for (const url of urls) addWorkflowImage(url, 'imagine-generate');
      if (!workflowState.selectedImage) {
        await syncToWorkflow(urls[0], 'imagine-generate', true, true);
      } else {
        saveWorkflowState();
        renderWorkflowState();
      }
    }

    if (typeof showToast === 'function') showToast('生成完成', 'success');
    loadGallery();
  } catch (e) {
    if (typeof showToast === 'function') showToast('生成失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function generateStream(body, btn) {
  const panel = document.getElementById('progress-panel');
  const bar = document.getElementById('progress-bar');
  const stage = document.getElementById('progress-stage');
  const status = document.getElementById('progress-status');

  panel.classList.remove('hidden');
  bar.style.width = '0%';
  stage.textContent = '连接中...';
  status.textContent = '';

  try {
    const res = await fetch('/api/v1/imagine/generate', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || err.detail || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const evt = JSON.parse(payload);
          const evtType = evt.event || '';
          if (evtType === 'progress') {
            const stageText = evt.stage === 'final' ? '完成' : evt.stage === 'medium' ? '生成中' : '预览';
            stage.textContent = stageText;
            const pct = evt.stage === 'final' ? 90 : evt.stage === 'medium' ? 60 : 30;
            bar.style.width = pct + '%';
            status.textContent = evt.image_id ? `图片: ${String(evt.image_id).slice(0, 8)}...` : '';
          } else if (evtType === 'complete') {
            bar.style.width = '100%';
            stage.textContent = '完成';
            const urls = extractImageUrls(evt);
            if (urls.length) {
              for (const url of urls) addWorkflowImage(url, 'imagine-generate');
              if (!workflowState.selectedImage) {
                await syncToWorkflow(urls[0], 'imagine-generate', true, true);
              } else {
                saveWorkflowState();
                renderWorkflowState();
              }
            }
            if (typeof showToast === 'function') showToast('生成完成', 'success');
            loadGallery();
          } else if (evtType === 'error') {
            stage.textContent = '失败';
            status.textContent = evt.message || evt.error || '未知错误';
            if (typeof showToast === 'function') showToast(evt.message || '生成失败', 'error');
          }
        } catch (_) {}
      }
    }

    loadGallery();
  } catch (e) {
    stage.textContent = '失败';
    status.textContent = e.message;
    if (typeof showToast === 'function') showToast('生成失败: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    setTimeout(() => panel.classList.add('hidden'), 3000);
  }
}
