let currentFilter = 'all';
let latestState = {
  authenticated: false,
  tenant_id: null,
  user_email: null,
  watches: [],
  notifications: [],
  unread_count: 0,
  check_logs: [],
  channels: []
};

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
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + d.toLocaleDateString() + ')';
}

function calculateCountdown(targetDateIso) {
  if (!targetDateIso) return null;
  const target = new Date(targetDateIso).getTime();
  if (isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return { expired: true, text: 'Window Reached / Active' };

  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  if (days > 0) {
    return {
      expired: false,
      days,
      text: `${days}d ${hours.toString().padStart(2, '0')}h ${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`
    };
  }
  return {
    expired: false,
    days: 0,
    text: `${hours.toString().padStart(2, '0')}h ${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`
  };
}

function getTemporalPhaseBadge(watch) {
  if (watch.status === 'triggered_open') {
    return '<span class="status-badge badge-live">🟢 LIVE NOW — Applications / Tickets Open</span>';
  }
  if (watch.status === 'expired_closed') {
    return '<span class="status-badge badge-closed">🔴 Deadline Passed / Closed</span>';
  }

  const target = watch.window_start_date || watch.detected_deadline;
  if (!target) {
    return '<span class="status-badge badge-sampling">🔵 Active Sampling</span>';
  }

  const targetMs = new Date(target).getTime();
  const diffDays = (targetMs - Date.now()) / (1000 * 86400);

  if (diffDays > 21) {
    return '<span class="status-badge badge-hibernating">🟣 HIBERNATING (Check ~7d)</span>';
  }
  if (diffDays > 3) {
    return '<span class="status-badge badge-approaching">🔵 APPROACHING (2h - 24h)</span>';
  }
  return '<span class="status-badge badge-sampling">⚡ BURST SAMPLING (Minutes)</span>';
}

function getCategoryIcon(cat) {
  switch (cat) {
    case 'tickets': return '🎟️ Tickets';
    case 'product_launch': return '🚀 Product Launch';
    case 'regulatory_deadline': return '⚖️ Regulatory / SEC';
    case 'visa_slot': return '✈️ Visa Slot';
    case 'conference': return '🎤 Conference';
    case 'hackathon': return '💻 Hackathon';
    case 'grant': return '💰 Grant';
    case 'calendar_reminder': return '🗓️ Calendar';
    default: return '🎓 Opportunity';
  }
}

async function fetchOverview() {
  try {
    const res = await fetch('/api/overview');
    latestState = await res.json();
    updateSessionIndicator();
    renderAll();
  } catch (err) {
    console.error('Failed to fetch personal overview', err);
  }
}

function updateSessionIndicator() {
  const label = document.getElementById('sessionLabel');
  const dot = document.getElementById('sessionStatusIndicator');
  const input = document.getElementById('currentTenantInput');

  if (latestState.authenticated && latestState.tenant_id) {
    const shortId = latestState.tenant_id.replace(/^tenant_/, '').slice(0, 10);
    if (label) label.textContent = `Vault: ${shortId}`;
    if (dot) dot.style.background = '#10b981';
    if (input) input.value = latestState.tenant_id + (latestState.user_email ? ` (${latestState.user_email})` : '');
  } else {
    if (label) label.textContent = 'Guest Vault';
    if (dot) dot.style.background = '#94a3b8';
    if (input) input.value = 'Guest (Anonymous session)';
  }
}

function renderAll() {
  renderWatches();
  renderNotifications();
  renderChannels();
}

function renderWatches() {
  const container = document.getElementById('watchesListContainer');
  const countBadge = document.getElementById('watchesCountBadge');
  if (!container) return;

  const allWatches = latestState.watches || [];
  if (countBadge) countBadge.textContent = String(allWatches.length);

  // If user has NO watches in this session: render pristine Zero-State showcase
  if (allWatches.length === 0) {
    container.innerHTML = `
      <div class="zero-state-showcase">
        <div style="font-size:36px;margin-bottom:8px;">🎯</div>
        <h3 style="margin:0 0 6px;font-size:17px;">Your Private Watch Vault is Empty</h3>
        <p class="muted" style="max-width:540px;margin:0 auto 18px;">
          PulseRemind captures events directly from AI chats. Once you or your LLM schedules an event or reminder, it will appear here with live countdowns and checklists.
        </p>

        <div class="showcase-grid">
          <div class="showcase-card">
            <h4>🎟️ Glastonbury 2027 Coach + Tickets</h4>
            <p>Target Window: October 2026. Monitors ticket sale hydration state with sub-minute bursts before drop.</p>
          </div>
          <div class="showcase-card">
            <h4>🚀 PlayStation 6 Pre-Order Drops</h4>
            <p>Monitors Schema.org InStock vs SoldOut with ETag short-circuiting and immediate Web Push.</p>
          </div>
          <div class="showcase-card">
            <h4>⚖️ SEC Form 10-K Annual Filing</h4>
            <p>AoE (UTC-12) deadline resolution with dual VALARM calendar sync and multi-probe anti-flap verification.</p>
          </div>
        </div>

        <button type="button" class="btn btn-primary" id="zeroStateCreateBtn">+ Create First Watch</button>
      </div>
    `;

    document.getElementById('zeroStateCreateBtn')?.addEventListener('click', () => {
      document.getElementById('createWatchDialog')?.showModal();
    });
    return;
  }

  // Filter watches by current status tab
  const filtered = allWatches.filter((w) => {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'triggered_open') return w.status === 'triggered_open';
    if (currentFilter === 'hibernating') return w.status === 'hibernating';
    if (currentFilter === 'active_monitoring') {
      return w.status === 'active_monitoring' || w.status === 'exponential_approach' || w.status === 'active_sampling';
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<p class="empty-state">No watches matching filter "${currentFilter}".</p>`;
    return;
  }

  container.innerHTML = filtered
    .map((w) => {
      const catLabel = getCategoryIcon(w.category);
      const phaseBadge = getTemporalPhaseBadge(w);
      const targetDate = w.window_start_date || w.detected_deadline;
      const countdown = calculateCountdown(targetDate);

      let countdownHtml = '';
      if (countdown) {
        if (countdown.expired) {
          countdownHtml = `<span class="countdown-meter live">🟢 ${escapeHtml(countdown.text)}</span>`;
        } else {
          const isUrgent = countdown.days <= 3;
          countdownHtml = `<span class="countdown-meter ${isUrgent ? 'urgent' : ''}" data-target-date="${escapeHtml(targetDate)}">⏳ ${escapeHtml(countdown.text)}</span>`;
        }
      }

      // Parse Action Checklist items
      const meta = w.resolution_config?.provider_metadata || {};
      const completedList = Array.isArray(meta.checklist_completed) ? meta.checklist_completed : [];
      const rawChecklist = w.chat_context || '';
      const checklistItems = rawChecklist
        .split('\n')
        .map((l) => l.trim().replace(/^[0-9.\-\s*]+/, ''))
        .filter((l) => l.length > 2);

      let checklistHtml = '';
      if (checklistItems.length > 0) {
        checklistHtml = `
          <div class="watch-checklist">
            <div class="checklist-title">📋 AI Action Checklist</div>
            ${checklistItems
              .map((item) => {
                const isChecked = completedList.includes(item);
                return `
                <label class="checklist-checkbox-label ${isChecked ? 'is-done' : ''}">
                  <input type="checkbox" data-watch-id="${w.id}" data-item="${escapeHtml(item)}" ${isChecked ? 'checked' : ''} />
                  <span>${escapeHtml(item)}</span>
                </label>
              `;
              })
              .join('')}
          </div>
        `;
      }

      // Calendar Links
      const googleCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('🔔 ' + w.title)}&dates=${(w.window_start_date || '20261101').replace(/[-:]/g, '')}T090000Z/${(w.window_start_date || '20261101').replace(/[-:]/g, '')}T100000Z&details=${encodeURIComponent(w.chat_context || w.title)}`;
      const icsDownloadUrl = `/api/watches/${encodeURIComponent(w.id)}/calendar.ics`;

      return `
        <div class="watch-card" data-watch-id="${w.id}">
          <div class="watch-card-header">
            <div>
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
                <span class="cat-pill" style="font-size:11px;">${catLabel}</span>
                ${phaseBadge}
                ${countdownHtml}
              </div>
              <h3 class="watch-title">${escapeHtml(w.title)}</h3>
              <p class="watch-window-label">Window: <strong>${escapeHtml(w.window_label || w.window_start_date || 'Upcoming')}</strong> ${w.detected_deadline ? `&bull; Deadline: <strong style="color:#f59e0b;">${escapeHtml(w.detected_deadline)}</strong>` : ''}</p>
            </div>
            <div class="watch-card-menu">
              <button type="button" class="btn btn-sm btn-secondary btn-check-now" data-watch-id="${w.id}" title="Trigger check immediately">
                Check Now
              </button>
              <button type="button" class="btn btn-sm btn-danger btn-delete-watch" data-watch-id="${w.id}" title="Delete watch">
                &times;
              </button>
            </div>
          </div>

          ${checklistHtml}

          <div class="cal-btn-group">
            <a class="btn-cal-small" href="${googleCalUrl}" target="_blank">🗓️ Google Calendar</a>
            <a class="btn-cal-small" href="${icsDownloadUrl}" download="${w.id}.ics">📥 Apple / Outlook (.ics)</a>
            ${w.target_url ? `<a class="btn-cal-small" href="${escapeHtml(w.target_url)}" target="_blank" style="color:#38bdf8;">🔗 Official Site &nearr;</a>` : ''}
          </div>

          <div class="watch-card-footer" style="margin-top:10px;">
            <span class="footer-meta">Last checked: ${formatTime(w.last_checked_at)}</span>
            <span class="footer-meta">Alerts: ${(w.notify_channels || []).join(', ')}</span>
          </div>
        </div>
      `;
    })
    .join('');

  // Attach checklist interactive toggle handlers
  container.querySelectorAll('input[type="checkbox"][data-watch-id]').forEach((chk) => {
    chk.addEventListener('change', async () => {
      const watchId = chk.getAttribute('data-watch-id');
      const itemText = chk.getAttribute('data-item');
      const completed = chk.checked;
      const label = chk.closest('.checklist-checkbox-label');
      if (label) {
        if (completed) label.classList.add('is-done');
        else label.classList.remove('is-done');
      }

      try {
        await fetch(`/api/watches/${encodeURIComponent(watchId)}/checklist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item: itemText, completed })
        });
      } catch (err) {
        console.error('Checklist update failed', err);
      }
    });
  });

  // Attach Check Now and Delete handlers
  container.querySelectorAll('.btn-check-now').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-watch-id');
      btn.textContent = 'Checking...';
      try {
        await fetch(`/api/watches/${encodeURIComponent(id)}/check`, { method: 'POST' });
        await fetchOverview();
      } catch {
        alert('Check failed');
      }
    });
  });

  container.querySelectorAll('.btn-delete-watch').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-watch-id');
      if (confirm('Delete this monitored watch?')) {
        await fetch(`/api/watches/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await fetchOverview();
      }
    });
  });
}

function renderNotifications() {
  const container = document.getElementById('notificationsContainer');
  const badge = document.getElementById('unreadBadge');
  if (!container) return;

  const list = latestState.notifications || [];
  const unread = list.filter((n) => !n.is_read).length;

  if (badge) {
    if (unread > 0) {
      badge.textContent = `${unread} new`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (list.length === 0) {
    container.innerHTML = '<p class="empty-state">No alerts in your private feed yet.</p>';
    return;
  }

  container.innerHTML = list
    .slice(0, 15)
    .map((n) => {
      const chipClass = n.delivery_status === 'opened' ? 'opened' : (n.delivery_status === 'delivered' ? 'delivered' : 'simulated');
      return `
      <div class="notification-item ${n.is_read ? '' : 'unread'}" data-notif-id="${n.id}">
        <div class="notif-header">
          <span class="delivery-chip ${chipClass}">${escapeHtml(n.delivery_status || 'delivered')}</span>
          <span class="notif-channel">${escapeHtml(n.channel)}</span>
          <span class="notif-time">${formatTime(n.created_at)}</span>
        </div>
        <div class="notif-title">${escapeHtml(n.subject)}</div>
        <div class="notif-msg">${escapeHtml(n.message)}</div>
      </div>
    `;
    })
    .join('');

  container.querySelectorAll('.notification-item.unread').forEach((item) => {
    item.addEventListener('click', async () => {
      const id = item.getAttribute('data-notif-id');
      await fetch(`/api/notifications/${encodeURIComponent(id)}/open`, { method: 'POST' });
      item.classList.remove('unread');
    });
  });
}

function renderChannels() {
  const container = document.getElementById('channelsConfigContainer');
  if (!container) return;

  const channels = latestState.channels || [];
  if (channels.length === 0) {
    container.innerHTML = '<p class="empty-state">Loading channels...</p>';
    return;
  }

  container.innerHTML = channels
    .map((ch) => {
      const isEnabled = Boolean(ch.enabled);
      let desc = '';
      if (ch.channel === 'email') desc = ch.config?.default_recipient ? `Default: ${escapeHtml(ch.config.default_recipient)}` : 'Recipient email not set';
      else if (ch.channel === 'in_app') desc = 'Real-time in-browser dashboard stream';
      else if (ch.channel === 'web_push') desc = 'Browser Push Notifications (VAPID ES256)';
      else desc = ch.config?.webhook_url ? 'Webhook connected' : 'Webhook URL not configured';

      return `
      <div class="channel-row">
        <div>
          <strong style="text-transform:capitalize;font-size:13px;">${escapeHtml(ch.channel.replace('_', ' '))}</strong>
          <div style="font-size:11.5px;color:var(--text-muted);">${desc}</div>
        </div>
        <label class="switch">
          <input type="checkbox" data-channel="${ch.channel}" ${isEnabled ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
      </div>
    `;
    })
    .join('');

  container.querySelectorAll('input[data-channel]').forEach((chk) => {
    chk.addEventListener('change', async () => {
      const channel = chk.getAttribute('data-channel');
      const enabled = chk.checked;
      await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, enabled })
      });
      await fetchOverview();
    });
  });
}

// Living countdown clock updater (ticks every 1000ms)
function startLivingTimers() {
  setInterval(() => {
    document.querySelectorAll('.countdown-meter[data-target-date]').forEach((el) => {
      const dateIso = el.getAttribute('data-target-date');
      const cd = calculateCountdown(dateIso);
      if (cd) {
        if (cd.expired) {
          el.className = 'countdown-meter live';
          el.textContent = '🟢 Portal Open!';
        } else {
          el.textContent = `⏳ ${cd.text}`;
          if (cd.days <= 3) el.classList.add('urgent');
        }
      }
    });
  }, 1000);
}

function setupFilterTabs() {
  document.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.getAttribute('data-status') || 'all';
      renderWatches();
    });
  });
}

function setupModals() {
  // Create Watch Modal
  const createDialog = document.getElementById('createWatchDialog');
  document.getElementById('openCreateModalBtn')?.addEventListener('click', () => createDialog?.showModal());
  document.getElementById('closeCreateModalBtn')?.addEventListener('click', () => createDialog?.close());
  document.getElementById('cancelCreateModalBtn')?.addEventListener('click', () => createDialog?.close());

  document.getElementById('createWatchForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = {
      title: form.title.value,
      category: form.category.value,
      window_start_date: form.window_start_date.value || undefined,
      target_url: form.target_url.value || undefined,
      chat_context: form.chat_context.value,
      recipient_email: form.recipient_email.value || undefined,
      rrule: form.rrule.value || undefined
    };

    await fetch('/api/watches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    createDialog?.close();
    form.reset();
    await fetchOverview();
  });

  // MCP Config Modal
  const mcpDialog = document.getElementById('mcpConfigDialog');
  document.getElementById('openMcpModalBtn')?.addEventListener('click', () => {
    const origin = window.location.origin;
    const snippet = {
      mcpServers: {
        pulseremind: {
          command: 'npx',
          args: ['-y', 'pulseremind-ai-chat-tools']
        }
      }
    };
    const codeEl = document.getElementById('mcpConfigSnippet');
    if (codeEl) codeEl.textContent = JSON.stringify(snippet, null, 2);
    mcpDialog?.showModal();
  });
  document.getElementById('closeMcpModalBtn')?.addEventListener('click', () => mcpDialog?.close());
  document.getElementById('doneMcpModalBtn')?.addEventListener('click', () => mcpDialog?.close());

  // Session / Identity Modal
  const sessionDialog = document.getElementById('sessionDialog');
  document.getElementById('openSessionBtn')?.addEventListener('click', () => sessionDialog?.showModal());
  document.getElementById('closeSessionModalBtn')?.addEventListener('click', () => sessionDialog?.close());

  document.getElementById('switchTenantForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = document.getElementById('tenantEmailLogin').value.trim();
    if (!val) return;
    await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(val.includes('@') ? { email: val } : { tenant_id: val })
    });
    sessionDialog?.close();
    await fetchOverview();
  });

  document.getElementById('logoutSessionBtn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    sessionDialog?.close();
    await fetchOverview();
  });

  // Browser Push Activation
  document.getElementById('browserPushQuickBtn')?.addEventListener('click', async () => {
    if (!('Notification' in window)) {
      alert('Browser notifications are not supported in this browser.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      alert('Browser Push Notifications enabled!');
    }
  });

  document.getElementById('markReadBtn')?.addEventListener('click', async () => {
    await fetch('/api/notifications/read-all', { method: 'POST' });
    await fetchOverview();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  fetchOverview();
  setupFilterTabs();
  setupModals();
  startLivingTimers();
});
