let currentFilter = 'all';
let latestState = {
  watches: [],
  notifications: [],
  unread_count: 0,
  check_logs: [],
  channels: [],
  demo_portals: []
};

// Mandatory fallback for browsers without native <dialog closedby="any"> support
function setupDialogLightDismissFallbacks() {
  const dialogs = document.querySelectorAll('dialog');
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialogs.forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (isDialogContent) return;
        dialog.close();
      });
    });
  }
}

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

function formatStatusLabel(status) {
  switch (status) {
    case 'triggered_open':
      return '🟢 OPEN — Applications Live!';
    case 'active_monitoring':
      return '🔵 Actively Monitoring Webpage';
    case 'hibernating':
      return '🟣 Hibernating Until Window';
    case 'config_error':
      return '⚠️ Entity Mismatch (Auto-Resolve Paused)';
    case 'expired_closed':
      return '🔴 Deadline Passed / Closed';
    case 'paused':
      return '⏸ Paused';
    default:
      return status;
  }
}

function formatPollAfter(unixSec) {
  if (!unixSec) return 'Ready now';
  const nowSec = Math.floor(Date.now() / 1000);
  if (unixSec <= nowSec) return 'Ready now (Next cycle)';
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function fetchOverview() {
  const res = await fetch('/api/overview');
  latestState = await res.json();
  renderAll();
}

function renderAll() {
  renderDemoPortals();
  renderWatches();
  renderNotifications();
  renderChannels();
  renderCheckLogs();
}

function renderDemoPortals() {
  const container = document.getElementById('demoPortalsContainer');
  if (!container) return;

  container.innerHTML = latestState.demo_portals
    .map((p) => {
      const statusBadge = p.is_open
        ? `<span class="status-badge badge-triggered_open">🟢 PORTAL OPEN</span>`
        : `<span class="status-badge badge-paused">🔒 CLOSED (Opens ${escapeHtml(p.open_date_text)})</span>`;
      const toggleBtnLabel = p.is_open
        ? '🔒 Reset Portal to Closed'
        : '🚀 Simulate Applications Opening Now!';
      const toggleBtnClass = p.is_open ? 'btn btn-sm btn-secondary' : 'btn btn-sm btn-success';

      return `
        <div class="portal-card ${p.is_open ? 'is-open' : ''}">
          <div class="portal-top">
            <div>
              <div class="portal-title">${escapeHtml(p.title)}</div>
              <div class="portal-org">${escapeHtml(p.organization)} • ${escapeHtml(p.award_amount)}</div>
            </div>
            ${statusBadge}
          </div>
          <div style="font-size: 12.5px; color: #cbd5e1;">
            ${escapeHtml(p.custom_banner || '')}
          </div>
          <div class="portal-actions">
            <a href="/demo/scholarships/${encodeURIComponent(p.slug)}" target="_blank" style="color: #38bdf8; font-size: 12.5px; text-decoration: none; font-weight: 600;">
              View External Webpage ↗
            </a>
            <button type="button" class="${toggleBtnClass}" data-toggle-portal="${escapeHtml(p.slug)}" data-next-open="${!p.is_open}">
              ${toggleBtnLabel}
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('[data-toggle-portal]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const slug = btn.getAttribute('data-toggle-portal');
      const nextOpen = btn.getAttribute('data-next-open') === 'true';
      btn.disabled = true;
      btn.textContent = 'Updating & Scraping...';
      await fetch(`/api/demo-portals/${encodeURIComponent(slug)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_open: nextOpen, trigger_check: true })
      });
      await fetchOverview();
    });
  });
}

function renderWatches() {
  const container = document.getElementById('watchesListContainer');
  const countBadge = document.getElementById('watchesCountBadge');
  if (!container) return;

  const filtered =
    currentFilter === 'all'
      ? latestState.watches
      : latestState.watches.filter((w) => w.status === currentFilter);

  if (countBadge) {
    countBadge.textContent = String(latestState.watches.length);
  }

  if (filtered.length === 0) {
    container.innerHTML = `<div class="muted" style="padding: 18px 0;">No watches match this filter. Try extracting one from the AI chat simulator above!</div>`;
    return;
  }

  container.innerHTML = filtered
    .map((w) => {
      const applyButtonHtml =
        w.status === 'triggered_open' && (w.detected_apply_url || w.target_url)
          ? `<a class="btn btn-sm btn-success" href="${escapeHtml(w.detected_apply_url || w.target_url)}" target="_blank" style="text-decoration:none;">Apply on Portal Now ↗</a>`
          : '';
      const oracleCount = Array.isArray(w.oracle_responses) ? w.oracle_responses.length : 0;

      return `
        <article class="watch-card status-${escapeHtml(w.status)}">
          <div class="watch-top">
            <div>
              <h3 class="watch-title">${escapeHtml(w.title)}</h3>
              <div style="font-size: 12px; color: #94a3b8;">
                Captured via <strong>${escapeHtml(w.source_chat_client)}</strong> • Target Window: <strong>${escapeHtml(w.window_label || w.window_start_date || 'Immediate')}</strong>
              </div>
            </div>
            <span class="status-badge badge-${escapeHtml(w.status)}">${formatStatusLabel(w.status)}</span>
          </div>

          <div class="watch-context">
            <strong>💬 AI Chat Planning Context:</strong> ${escapeHtml(w.chat_context)}
          </div>

          <div class="watch-meta">
            <span>🔗 <strong>Monitored URL:</strong> ${
              w.target_url
                ? `<a href="${escapeHtml(w.target_url)}" target="_blank">${escapeHtml(w.target_url)}</a>`
                : 'Date-only Reminder'
            }</span>
            <span>⏱ <strong>Last Checked:</strong> ${escapeHtml(formatTime(w.last_checked_at))}</span>
            <span>⏭ <strong>Next Poll (poll_after):</strong> ${escapeHtml(formatPollAfter(w.poll_after))}</span>
            <span>📜 <strong>Oracle Records:</strong> ${oracleCount}</span>
            ${
              w.detected_deadline
                ? `<span style="color:#34d399;">📅 <strong>Detected Deadline:</strong> ${escapeHtml(w.detected_deadline)}</span>`
                : ''
            }
          </div>

          <div class="watch-summary">
            <strong>Resolution Engine Verdict:</strong> ${escapeHtml(w.last_status_summary || 'Pending check')}
          </div>

          <div class="watch-footer">
            <div class="channel-tags">
              <span class="channel-tag">${w.is_auto_resolve ? '🤖 Auto-Resolve ON' : '⚠️ Auto-Resolve OFF'}</span>
              ${(w.notify_channels || [])
                .map((ch) => `<span class="channel-tag">🔔 ${escapeHtml(ch.toUpperCase())}</span>`)
                .join('')}
              ${w.recipient_email ? `<span class="channel-tag">✉️ ${escapeHtml(w.recipient_email)}</span>` : ''}
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              ${applyButtonHtml}
              <button type="button" class="btn btn-sm btn-secondary" data-check-watch="${escapeHtml(w.id)}">
                🔍 Check Webpage Now
              </button>
              <button type="button" class="btn btn-sm btn-secondary" data-delete-watch="${escapeHtml(w.id)}">
                🗑
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  container.querySelectorAll('[data-check-watch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-check-watch');
      btn.disabled = true;
      btn.textContent = 'Checking...';
      await fetch(`/api/watches/${encodeURIComponent(id)}/check`, { method: 'POST' });
      await fetchOverview();
    });
  });

  container.querySelectorAll('[data-delete-watch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-delete-watch');
      await fetch(`/api/watches/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await fetchOverview();
    });
  });
}

function renderNotifications() {
  const container = document.getElementById('notificationsContainer');
  const unreadBadge = document.getElementById('unreadBadge');
  if (!container) return;

  if (unreadBadge) {
    if (latestState.unread_count > 0) {
      unreadBadge.textContent = `${latestState.unread_count} new`;
      unreadBadge.classList.remove('hidden');
    } else {
      unreadBadge.classList.add('hidden');
    }
  }

  if (latestState.notifications.length === 0) {
    container.innerHTML = `<div class="muted">No alerts dispatched yet. Flip one of the Simulated Scholarship Portals above to <strong>Open</strong> to trigger multi-channel notifications!</div>`;
    return;
  }

  container.innerHTML = latestState.notifications
    .map((n) => {
      const isEmailPreview = n.channel === 'email';
      const previewLink = isEmailPreview
        ? `<a href="/api/notifications/${encodeURIComponent(n.id)}/email-preview" target="_blank" style="color:#38bdf8; font-weight:600; text-decoration:none; font-size:12px;">✉️ View Rendered HTML Email ↗</a>`
        : n.preview_url
          ? `<a href="${escapeHtml(n.preview_url)}" target="_blank" style="color:#34d399; font-weight:600; text-decoration:none; font-size:12px;">Open Portal Link ↗</a>`
          : '';

      return `
        <div class="notif-item ${!n.is_read ? 'unread' : ''}">
          <div class="notif-top">
            <span class="notif-channel">${escapeHtml(n.channel)} • ${escapeHtml(n.delivery_status)}</span>
            <span style="font-size:11px; color:#94a3b8;">${escapeHtml(formatTime(n.created_at))}</span>
          </div>
          <div style="font-weight:700; margin-bottom:4px; color:#f8fafc;">${escapeHtml(n.subject)}</div>
          <div style="font-size:12px; color:#cbd5e1; white-space:pre-line; margin-bottom:6px;">${escapeHtml(n.message)}</div>
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:11px; color:#94a3b8;">To: ${escapeHtml(n.recipient || 'User')}</span>
            ${previewLink}
          </div>
        </div>
      `;
    })
    .join('');
}

function renderChannels() {
  const container = document.getElementById('channelsConfigContainer');
  if (!container) return;

  const channelLabels = {
    in_app: '🖥️ In-App Web Dashboard',
    email: '✉️ Email Notifications',
    slack: '💬 Slack Webhook',
    discord: '🎮 Discord Webhook',
    telegram: '✈️ Telegram Bot Alert',
    whatsapp: '📱 WhatsApp / SMS Webhook'
  };

  container.innerHTML = latestState.channels
    .map((ch) => {
      let configFieldHtml = '';
      if (ch.channel === 'email') {
        configFieldHtml = `<input class="channel-input" data-cfg-key="default_recipient" placeholder="Recipient email" value="${escapeHtml(ch.config.default_recipient || 'student@university.edu')}" />`;
      } else if (ch.channel === 'slack' || ch.channel === 'discord') {
        configFieldHtml = `<input class="channel-input" data-cfg-key="webhook_url" placeholder="https://hooks.slack.com/services/... (optional for sandbox)" value="${escapeHtml(ch.config.webhook_url || '')}" />`;
      } else if (ch.channel === 'telegram') {
        configFieldHtml = `<input class="channel-input" data-cfg-key="chat_id" placeholder="Telegram Chat ID (e.g. @student_alerts)" value="${escapeHtml(ch.config.chat_id || '')}" />`;
      } else if (ch.channel === 'whatsapp') {
        configFieldHtml = `<input class="channel-input" data-cfg-key="phone_number" placeholder="WhatsApp number (+1555...)" value="${escapeHtml(ch.config.phone_number || '+15550192834')}" />`;
      }

      return `
        <div class="channel-item" data-channel-card="${escapeHtml(ch.channel)}">
          <div class="channel-row">
            <strong>${channelLabels[ch.channel] || ch.channel}</strong>
            <label style="font-size:12px; display:flex; align-items:center; gap:6px; cursor:pointer;">
              <input type="checkbox" data-channel-toggle="${escapeHtml(ch.channel)}" ${ch.enabled ? 'checked' : ''} />
              ${ch.enabled ? 'Enabled' : 'Disabled'}
            </label>
          </div>
          ${
            configFieldHtml
              ? `<div style="display:flex; gap:6px; margin-top:6px;">
                   ${configFieldHtml}
                   <button type="button" class="btn btn-sm btn-secondary" data-save-channel="${escapeHtml(ch.channel)}">Save</button>
                 </div>`
              : ''
          }
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('[data-channel-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const chName = checkbox.getAttribute('data-channel-toggle');
      const card = container.querySelector(`[data-channel-card="${chName}"]`);
      const input = card?.querySelector('[data-cfg-key]');
      const existing = latestState.channels.find((c) => c.channel === chName);
      const nextConfig = { ...(existing?.config || {}) };
      if (input) {
        nextConfig[input.getAttribute('data-cfg-key')] = input.value;
      }
      await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: chName, enabled: checkbox.checked, config: nextConfig })
      });
      await fetchOverview();
    });
  });

  container.querySelectorAll('[data-save-channel]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const chName = btn.getAttribute('data-save-channel');
      const card = container.querySelector(`[data-channel-card="${chName}"]`);
      const checkbox = card?.querySelector('[data-channel-toggle]');
      const input = card?.querySelector('[data-cfg-key]');
      const existing = latestState.channels.find((c) => c.channel === chName);
      const nextConfig = { ...(existing?.config || {}) };
      if (input) {
        nextConfig[input.getAttribute('data-cfg-key')] = input.value;
      }
      btn.textContent = 'Saved!';
      await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: chName, enabled: Boolean(checkbox?.checked), config: nextConfig })
      });
      setTimeout(() => fetchOverview(), 400);
    });
  });
}

function renderCheckLogs() {
  const container = document.getElementById('checkLogsContainer');
  if (!container) return;

  if (latestState.check_logs.length === 0) {
    container.innerHTML = `<div class="muted">No page scrapes logged yet. Click <strong>Check All Pages Now</strong> to run live checks.</div>`;
    return;
  }

  container.innerHTML = latestState.check_logs
    .map((log) => {
      const watch = latestState.watches.find((w) => w.id === log.watch_id);
      const badge = log.is_open
        ? `<span style="color:#34d399; font-weight:700;">🟢 OPEN</span>`
        : !log.entity_validated
          ? `<span style="color:#f87171; font-weight:700;">⚠️ Entity Mismatch</span>`
          : `<span style="color:#94a3b8; font-weight:600;">🔒 Closed</span>`;
      const cacheBadge = log.cache_hit ? '⚡ 120s Cache Hit' : '🌐 Live Scrape';
      const entityBadge = log.entity_validated ? '✅ Entity Verified' : '❌ Entity Mismatch';
      return `
        <div class="log-item">
          <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
            <strong>${escapeHtml(watch ? watch.title : log.watch_id)}</strong>
            ${badge}
          </div>
          <div style="color:#cbd5e1;">${escapeHtml(log.summary)}</div>
          <div style="font-size:11px; color:#64748b; margin-top:4px;">
            HTTP ${log.http_status || 'N/A'} • ${cacheBadge} • ${entityBadge} • ${escapeHtml(formatTime(log.checked_at))}
          </div>
        </div>
      `;
    })
    .join('');
}

// Wire up interactions on DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  setupDialogLightDismissFallbacks();
  fetchOverview();

  // Filter tabs
  document.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.getAttribute('data-status') || 'all';
      renderWatches();
    });
  });

  // Preset Chat Transcripts
  const presets = {
    'end-of-month': `User: We're planning my graduate school funding for next fall. I really want to apply for the Horizon Global AI Scholarship, but the portal says applications won't open until the end of this month.\nAssistant: Let's polish your research proposal now, and I'll register a PulseRemind watch for the Horizon Global AI Scholarship so you get alerted the moment it opens at the end of the month!`,
    'early-next-year': `User: What about UK fellowships? The Commonwealth Emerging Leaders Grant covers full tuition, right?\nAssistant: Yes! However, the 2027 cycle for the Commonwealth Emerging Leaders Grant doesn't open until early next year (January 2027). I'll schedule a hibernating web monitor for early next year so you don't miss the opening day.`,
    'multi': `User: Let's track both: the Horizon Global AI Fellowship opening at the end of this month, and the Gates Innovation Graduate Scholarship opening early next year.\nAssistant: Got it! Setting up web-monitored reminders for both scholarships right now.`
  };

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-preset');
      const textarea = document.getElementById('chatTranscriptInput');
      if (textarea && presets[key]) {
        textarea.value = presets[key];
      }
    });
  });

  // Chat Extract Form
  const extractForm = document.getElementById('chatExtractForm');
  extractForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const transcript = document.getElementById('chatTranscriptInput').value;
    const recipientEmail = document.getElementById('extractEmailInput').value;
    const submitBtn = document.getElementById('extractSubmitBtn');
    const resultBox = document.getElementById('extractResultBox');

    submitBtn.disabled = true;
    submitBtn.textContent = 'Analyzing Chat & Registering Watches...';

    const res = await fetch('/api/chat/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript,
        auto_create: true,
        recipient_email: recipientEmail
      })
    });
    const data = await res.json();

    submitBtn.disabled = false;
    submitBtn.textContent = '✨ Extract & Schedule Reminders from Chat';

    if (resultBox) {
      resultBox.classList.remove('hidden');
      const names = (data.created_watches || []).map((w) => `"${w.title}" (${w.window_label})`).join(', ');
      resultBox.innerHTML = `✅ <strong>MCP Tool <code>extract_watches_from_chat</code> succeeded!</strong> Created ${data.created_watches?.length || 0} smart watch(es): <strong>${escapeHtml(names)}</strong>.`;
    }
    await fetchOverview();
  });

  // Check All Pages button
  const checkAllBtn = document.getElementById('checkAllNowBtn');
  checkAllBtn?.addEventListener('click', async () => {
    checkAllBtn.disabled = true;
    checkAllBtn.textContent = '⏳ Scraping All Pages...';
    await fetch('/api/watches/check-all', { method: 'POST' });
    checkAllBtn.disabled = false;
    checkAllBtn.textContent = '🔄 Check All Pages Now';
    await fetchOverview();
  });

  // Mark notifications read
  document.getElementById('markReadBtn')?.addEventListener('click', async () => {
    await fetch('/api/notifications/read-all', { method: 'POST' });
    await fetchOverview();
  });

  // Send Test Alert across enabled channels
  const testChannelsBtn = document.getElementById('testChannelsBtn');
  testChannelsBtn?.addEventListener('click', async () => {
    testChannelsBtn.disabled = true;
    testChannelsBtn.textContent = 'Sending...';
    await fetch('/api/channels/test', { method: 'POST' });
    testChannelsBtn.disabled = false;
    testChannelsBtn.textContent = 'Send Test Alert';
    await fetchOverview();
  });

  // Create Watch Modal Dialog (always open with showModal() per light-dismiss-a-dialog guide)
  const createDialog = document.getElementById('createWatchDialog');
  document.getElementById('openCreateModalBtn')?.addEventListener('click', () => {
    createDialog?.showModal();
  });
  document.getElementById('closeCreateModalBtn')?.addEventListener('click', () => {
    createDialog?.close();
  });
  document.getElementById('cancelCreateModalBtn')?.addEventListener('click', () => {
    createDialog?.close();
  });

  document.getElementById('createWatchForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const channels = Array.from(form.querySelectorAll('input[name="channel"]:checked')).map((el) => el.value);

    await fetch('/api/watches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title.value,
        window_label: form.window_label.value,
        window_start_date: form.window_start_date.value,
        target_url: form.target_url.value || `${window.location.origin}/demo/scholarships/global-ai-fellowship`,
        condition_text: form.condition_text.value,
        chat_context: form.chat_context.value,
        recipient_email: form.recipient_email.value,
        notify_channels: channels.length ? channels : ['in_app', 'email'],
        source_chat_client: 'Dashboard Manual Watch'
      })
    });

    form.reset();
    createDialog?.close();
    await fetchOverview();
  });

  // MCP Config Modal Dialog (always open with showModal() per light-dismiss-a-dialog guide)
  const mcpDialog = document.getElementById('mcpConfigDialog');
  const mcpSnippet = document.getElementById('mcpConfigSnippet');
  if (mcpSnippet) {
    mcpSnippet.textContent = JSON.stringify(
      {
        mcpServers: {
          pulseremind: {
            command: 'node',
            args: ['--no-warnings', '/path/to/pulseremind/src/pkg/mcp/stdio-server.ts']
          }
        }
      },
      null,
      2
    );
  }
  document.getElementById('openMcpModalBtn')?.addEventListener('click', () => {
    mcpDialog?.showModal();
  });
  document.getElementById('closeMcpModalBtn')?.addEventListener('click', () => {
    mcpDialog?.close();
  });
  document.getElementById('doneMcpModalBtn')?.addEventListener('click', () => {
    mcpDialog?.close();
  });
});
