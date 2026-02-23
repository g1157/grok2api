document.addEventListener('DOMContentLoaded', () => {
    loadHeader();
    loadGallery();
    loadSsoStatus();
});

function loadHeader() {
    fetch('/static/common/header.html')
        .then(r => r.text())
        .then(html => {
            document.getElementById('nav-placeholder').innerHTML = html;
            const links = document.querySelectorAll('#nav-placeholder a');
            links.forEach(a => {
                if (a.textContent.trim().toLowerCase().includes('imagine')) {
                    a.classList.add('font-bold', 'text-blue-600');
                }
            });
        })
        .catch(() => {});
}

function getAuthHeaders() {
    const token = localStorage.getItem('admin_token') || '';
    return { 'Authorization': 'Bearer ' + token };
}

async function generateImages() {
    const prompt = document.getElementById('prompt').value.trim();
    if (!prompt) return;

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
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, stream: false })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Generation failed');
        loadGallery();
    } catch (e) {
        alert('Error: ' + e.message);
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
    stage.textContent = 'Starting...';
    status.textContent = '';

    try {
        const res = await fetch('/api/v1/imagine/generate', {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Generation failed');
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
                        stage.textContent = evt.stage || 'Processing...';
                        const pct = evt.size ? Math.min(90, Math.floor(evt.size / 1000)) : 0;
                        bar.style.width = pct + '%';
                        status.textContent = `Image: ${evt.image_id || '...'} (${evt.stage || ''})`;
                    } else if (evtType === 'complete') {
                        bar.style.width = '100%';
                        stage.textContent = 'Complete';
                        loadGallery();
                    } else if (evtType === 'error') {
                        stage.textContent = 'Error';
                        status.textContent = evt.message || 'Unknown error';
                    }
                } catch (_) {}
            }
        }

        bar.style.width = '100%';
        stage.textContent = 'Complete';
        loadGallery();
    } catch (e) {
        stage.textContent = 'Failed';
        status.textContent = e.message;
    } finally {
        btn.disabled = false;
        setTimeout(() => panel.classList.add('hidden'), 3000);
    }
}

async function loadGallery() {
    try {
        const res = await fetch('/api/v1/imagine/gallery', { headers: getAuthHeaders() });
        const data = await res.json();
        const el = document.getElementById('gallery');

        if (!data.images || data.images.length === 0) {
            el.innerHTML = '<p class="text-[var(--accents-4)] col-span-full text-center py-8">No images yet</p>';
            return;
        }

        el.innerHTML = data.images.map(img => `
            <div class="gallery-item">
                <img src="/api/v1/imagine/gallery/file/${img.filename}" alt="${img.filename || ''}" loading="lazy">
                <button class="delete-btn" onclick="deleteImage('${img.filename}')" title="Delete">&#x2715;</button>
            </div>
        `).join('');
    } catch (_) {}
}

async function deleteImage(filename) {
    if (!confirm('Delete this image?')) return;
    try {
        await fetch('/api/v1/imagine/gallery/' + encodeURIComponent(filename), {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        loadGallery();
    } catch (_) {}
}

async function clearGallery() {
    if (!confirm('Clear all images?')) return;
    try {
        await fetch('/api/v1/imagine/gallery/clear', {
            method: 'POST',
            headers: getAuthHeaders()
        });
        loadGallery();
    } catch (_) {}
}

async function loadSsoStatus() {
    try {
        const res = await fetch('/api/v1/imagine/status', { headers: getAuthHeaders() });
        const data = await res.json();
        const pool = data.sso_pool || {};
        const tokens = pool.tokens || [];
        const tbody = document.getElementById('sso-tbody');

        if (!tokens.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-[var(--accents-4)] py-4">No tokens configured</td></tr>';
            return;
        }

        tbody.innerHTML = tokens.map(t => `
            <tr>
                <td class="font-mono text-xs">${t.token || '***'}</td>
                <td>${t.daily_count ?? 0}</td>
                <td>${Math.max(0, (t.daily_limit || 10) - (t.daily_count || 0))}</td>
                <td><span class="badge ${t.fail_count > 0 ? 'badge-fail' : 'badge-ok'}">${t.fail_count > 0 ? 'Failed' : 'OK'}</span></td>
                <td class="text-xs text-[var(--accents-4)]">${t.available ? 'Available' : 'Exhausted'}</td>
            </tr>
        `).join('');
    } catch (_) {
        document.getElementById('sso-tbody').innerHTML = '<tr><td colspan="5" class="text-center text-[var(--error)] py-4">Failed to load</td></tr>';
    }
}

async function reloadSso() {
    try {
        await fetch('/api/v1/imagine/sso/reload', { method: 'POST', headers: getAuthHeaders() });
        loadSsoStatus();
    } catch (_) {}
}

async function resetDailyUsage() {
    if (!confirm('Reset daily usage counters?')) return;
    try {
        await fetch('/api/v1/imagine/sso/reset', { method: 'POST', headers: getAuthHeaders() });
        loadSsoStatus();
    } catch (_) {}
}
