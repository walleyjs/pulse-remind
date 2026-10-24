function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' (' + d.toLocaleDateString() + ')';
}

let sandboxState = {
  demo_portals: [],
  check_logs: []
};

async function fetchSandboxData() {
  try {
    const res = await fetch('/api/dev/sandbox');
    const data = await res.json();
    sandboxState.demo_portals = data.demo_portals || [];
    sandboxState.check_logs = data.check_logs || [];
    renderPortals();
    renderLogs();
  } catch (err) {
    console.error('Failed to load sandbox data', err);
  }
}

function renderPortals() {
  const container = document.getElementById('demoPortalsContainer');
  if (!container) return;

  container.innerHTML = (sandboxState.demo_portals || [])
    .map((p) => {
      const statusBadge = p.is_open
        ? `<span class="status-badge badge-triggered_open">🟢 PORTAL OPEN</span>`
        : `<span class="status-badge badge-paused">🔒 CLOSED (Opens ${escapeHtml(p.open_date_text)})</span>`;
      const toggleBtnLabel = p.is_open
        ? '🔒 Reset Portal to Closed'
        : '🚀 Simulate Applications Opening Now!';
      const toggleBtnClass = p.is_open ? 'btn btn-sm btn-secondary' : 'btn btn-sm btn-success';

      return `
      <div class="portal-card ${p.is_open ? 'portal-card-open' : ''}">
        <div class="portal-card-top">
          <h3>${escapeHtml(p.title)}</h3>
          ${statusBadge}
        </div>
        <p class="portal-meta">${escapeHtml(p.organization)} &bull; ${escapeHtml(p.award_amount_text)}</p>
        <p class="portal-desc">${escapeHtml(p.description)}</p>
        <div class="portal-card-actions">
          <a href="/demo/scholarships/${encodeURIComponent(p.slug)}" target="_blank" class="link-external">
            View External Webpage &nearr;
          </a>
          <button type="button" class="${toggleBtnClass}" data-portal-slug="${encodeURIComponent(p.slug)}" data-is-open="${p.is_open ? 'true' : 'false'}">
            ${toggleBtnLabel}
          </button>
        </div>
      </div>
    `;
    })
    .join('');

  container.querySelectorAll('button[data-portal-slug]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.getAttribute('data-portal-slug');
      const isCurrentlyOpen = btn.getAttribute('data-is-open') === 'true';
      btn.disabled = true;
      btn.textContent = 'Updating...';

      try {
        await fetch(`/api/demo/portals/${slug}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_open: !isCurrentlyOpen, run_check_now: true })
        });
        await fetchSandboxData();
      } catch (e) {
        alert('Failed to toggle portal: ' + (e instanceof Error ? e.message : String(e)));
      }
    });
  });
}

function renderLogs() {
  const container = document.getElementById('checkLogsContainer');
  if (!container) return;

  if (sandboxState.check_logs.length === 0) {
    container.innerHTML = '<p class="empty-state">No check logs recorded yet.</p>';
    return;
  }

  container.innerHTML = sandboxState.check_logs
    .slice(0, 15)
    .map((log) => `
      <div class="log-item">
        <div class="log-top">
          <span class="status-indicator ${log.is_open ? 'dot-open' : 'dot-closed'}"></span>
          <span class="log-status">${log.is_open ? 'OPEN DETECTED' : 'Closed / Unchanged'}</span>
          <span class="log-confidence">${Math.round(log.confidence * 100)}% conf</span>
          <span class="log-time">${formatTime(log.checked_at)}</span>
        </div>
        <p class="log-summary">${escapeHtml(log.summary)}</p>
      </div>
    `)
    .join('');
}

function setupChatExtractor() {
  const form = document.getElementById('chatExtractForm');
  const resultBox = document.getElementById('extractResultBox');
  const textarea = document.getElementById('chatTranscriptInput');

  const presets = {
    'end-of-month': `User: I want to apply for the Horizon Global AI Fellowship, but it won't open until the end of this month.\nAssistant: I will set a PulseRemind watch so you get alerted when the portal goes live!`,
    'early-next-year': `User: The Commonwealth Emerging Leaders Grant doesn't open until early next year (January 2027).\nAssistant: I've added a calendar alarm and scheduled check!`,
    'multi': `User: WWDC tickets drop at the end of the month, and Gates Cambridge opens early next year.\nAssistant: I've extracted both into your opportunity watch queue.`
  };

  document.querySelectorAll('button[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      const key = b.getAttribute('data-preset');
      if (textarea && presets[key]) textarea.value = presets[key];
    });
  });

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('extractSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const transcript = textarea ? textarea.value : '';
        const email = document.getElementById('extractEmailInput')?.value || '';
        const res = await fetch('/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'dev_extract',
            method: 'tools/call',
            params: {
              name: 'extract_watches_from_chat',
              arguments: { transcript, auto_create: true, recipient_email: email || undefined }
            }
          })
        });
        const data = await res.json();
        if (resultBox) {
          resultBox.classList.remove('hidden');
          resultBox.innerHTML = `<pre class="code-block" style="margin-top:12px;">${escapeHtml(JSON.stringify(data.result?.structured || data, null, 2))}</pre>`;
        }
        await fetchSandboxData();
      } catch (err) {
        alert('Failed: ' + (err instanceof Error ? err.message : String(err)));
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  fetchSandboxData();
  setupChatExtractor();

  document.getElementById('checkAllNowBtn')?.addEventListener('click', async () => {
    await fetch('/api/watches/check-all', { method: 'POST' });
    await fetchSandboxData();
  });

  document.getElementById('testChannelsBtn')?.addEventListener('click', async () => {
    const res = await fetch('/api/channels/test', { method: 'POST' });
    const data = await res.json();
    alert('Dispatched test alerts across enabled channels!');
    await fetchSandboxData();
  });
});
