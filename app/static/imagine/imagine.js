let apiKey = null;

document.addEventListener('DOMContentLoaded', async () => {
  apiKey = await ensureApiKey();
  if (!apiKey) return;
  loadSsoStatus();
  loadGallery();
});

function authHeaders() {
  return apiKey ? { 'Authorization': apiKey } : {};
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

    tbody.innerHTML = tokens.map(t => `
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

    el.innerHTML = items.map(img => {
      const name = img.name || img.filename || '';
      const url = img.url || `/api/v1/imagine/gallery/file/${name}`;
      return `
        <div class="imagine-gallery-item" onclick="openLightbox('${url}')">
          <img src="${url}" alt="${name}" loading="lazy">
          <button class="imagine-delete-btn" onclick="event.stopPropagation();deleteImage('${name}')" title="删除">&#x2715;</button>
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
      headers: authHeaders()
    });
    loadGallery();
  } catch (_) {}
}

async function clearGallery() {
  if (!confirm('确认清空所有图片？')) return;
  try {
    await fetch('/api/v1/imagine/gallery/clear', {
      method: 'POST',
      headers: authHeaders()
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
    stream: document.getElementById('stream').checked
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
      body: JSON.stringify({ ...body, stream: false })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.detail || 'Generation failed');
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
      body: JSON.stringify(body)
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
