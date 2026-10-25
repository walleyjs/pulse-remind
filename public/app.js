// PulseRemind / Cue — Minimalist Frontend Controller
// Pure Vanilla JavaScript, zero external dependencies

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

function extractDomain(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function formatTime(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function calculateCountdown(targetDateIso) {
  if (!targetDateIso) return null;
  const target = new Date(targetDateIso).getTime();
  if (isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return { expired: true, text: 'Trigger Window Active' };

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
    return '<span class="status-pill active"><span class="status-pill-dot"></span>Triggered Live</span>';
  }
  if (watch.status === 'expired_closed') {
    return '<span class="status-pill hibernating"><span class="status-pill-dot"></span>Closed</span>';
  }

  const target = watch.window_start_date || watch.detected_deadline;
  if (!target) {
    return '<span class="status-pill active"><span class="status-pill-dot"></span>Sampling</span>';
  }

  const targetMs = new Date(target).getTime();
  const diffDays = (targetMs - Date.now()) / (1000 * 86400);

  if (diffDays > 21) {
    return '<span class="status-pill hibernating"><span class="status-pill-dot"></span>Hibernating</span>';
  }
  if (diffDays > 3) {
    return '<span class="status-pill approaching"><span class="status-pill-dot"></span>Approaching</span>';
  }
  return '<span class="status-pill active"><span class="status-pill-dot"></span>Burst Monitoring</span>';
}

function getCategoryLabel(cat) {
  switch (cat) {
    case 'tickets': return 'Tickets & Passes';
    case 'product_launch': return 'Product Drop';
    case 'regulatory_deadline': return 'Regulatory';
    case 'visa_slot': return 'Visa Appointment';
    case 'conference': return 'Conference';
    case 'hackathon': return 'Hackathon';
    case 'grant': return 'Grant';
    case 'calendar_reminder': return 'Calendar Event';
    default: return 'Opportunity';
  }
}

async function fetchOverview() {
  try {
    const res = await fetch('/api/overview');
    latestState = await res.json();
    updateSessionIndicator();
    renderAll();
  } catch (err) {
    console.error('Failed to fetch overview state', err);
  }
}

function updateSessionIndicator() {
  const label = document.getElementById('sessionLabel');
  const dot = document.getElementById('sessionStatusIndicator');
  const input = document.getElementById('currentTenantInput');

  if (latestState.authenticated && latestState.tenant_id) {
    const email = latestState.user_email;
    if (email) {
      if (label) label.textContent = email;
    } else {
      const shortId = latestState.tenant_id.replace(/^tenant_/, '').slice(0, 8);
      if (label) label.textContent = `Vault ${shortId}`;
    }
    if (dot) dot.style.background = '#10b981';
    if (input) input.value = latestState.tenant_id + (email ? ` (${email})` : '');
  } else {
    if (label) label.textContent = 'Guest Vault';
    if (dot) dot.style.background = '#71717a';
    if (input) input.value = 'Guest (Anonymous Ephemeral Session)';
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

  // Pristine Minimalist Empty State
  if (allWatches.length === 0) {
    container.innerHTML = `
      <div class="zero-state-view">
        <div class="zero-state-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        </div>
        <h3 class="zero-state-title">No Monitored Events</h3>
        <p class="zero-state-desc">
          When an AI assistant schedules a reminder or monitors an upcoming release, your active watches and live countdowns will appear here.
        </p>
        <button type="button" class="btn btn-secondary btn-compact" id="zeroStateCreateBtn">
          + New Watch
        </button>
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
      const catLabel = getCategoryLabel(w.category);
      const phaseBadge = getTemporalPhaseBadge(w);
      const targetDate = w.window_start_date || w.detected_deadline;
      const countdown = calculateCountdown(targetDate);
      const domain = extractDomain(w.target_url);

      let countdownHtml = '';
      if (countdown) {
        if (countdown.expired) {
          countdownHtml = `<span class="countdown-clock live">${escapeHtml(countdown.text)}</span>`;
        } else {
          const isUrgent = countdown.days <= 3;
          countdownHtml = `<span class="countdown-clock ${isUrgent ? 'urgent' : ''}" data-target-date="${escapeHtml(targetDate)}">${escapeHtml(countdown.text)}</span>`;
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
          <div class="checklist-container">
            ${checklistItems
              .map((item) => {
                const isChecked = completedList.includes(item);
                return `
                <label class="checklist-label ${isChecked ? 'is-done' : ''}">
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
      const googleCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(w.title)}&dates=${(w.window_start_date || '20261101').replace(/[-:]/g, '')}T090000Z/${(w.window_start_date || '20261101').replace(/[-:]/g, '')}T100000Z&details=${encodeURIComponent(w.chat_context || w.title)}`;
      const icsDownloadUrl = `/api/watches/${encodeURIComponent(w.id)}/calendar.ics`;

      const isTriggered = w.status === 'triggered_open';

      return `
        <article class="watch-row ${isTriggered ? 'is-triggered' : ''}" data-watch-id="${w.id}">
          <div class="watch-row-header">
            <div style="flex: 1; min-width: 0;">
              <div class="watch-meta-strip">
                ${phaseBadge}
                <span class="category-tag">${escapeHtml(catLabel)}</span>
                ${domain ? `<span class="domain-tag">${escapeHtml(domain)}</span>` : ''}
                ${countdownHtml}
              </div>
              <h3 class="watch-title">${escapeHtml(w.title)}</h3>
              <p class="watch-window-summary">
                Target: <strong>${escapeHtml(w.window_label || w.window_start_date || 'Unspecified')}</strong>
                ${w.detected_deadline ? ` · Deadline: <strong>${escapeHtml(w.detected_deadline)}</strong>` : ''}
              </p>
            </div>
            <div class="watch-row-actions">
              <button type="button" class="btn btn-secondary btn-compact btn-check-now" data-watch-id="${w.id}" title="Run immediate verification check">
                Check
              </button>
              <button type="button" class="btn btn-danger btn-compact btn-delete-watch" data-watch-id="${w.id}" title="Delete watch" aria-label="Delete watch">
                &times;
              </button>
            </div>
          </div>

          ${checklistHtml}

          <div class="watch-bottom-strip">
            <div class="action-links-group">
              <a class="link-btn" href="${googleCalUrl}" target="_blank" rel="noopener">Add to Google Cal</a>
              <a class="link-btn" href="${icsDownloadUrl}" download="${w.id}.ics">Download .ics</a>
              ${w.target_url ? `<a class="link-btn primary-link" href="${escapeHtml(w.target_url)}" target="_blank" rel="noopener">Visit Site ↗</a>` : ''}
              <button type="button" class="btn-text btn-toggle-drawer" data-watch-id="${w.id}">Details ▾</button>
            </div>
            <span class="domain-tag">Last checked: ${formatTime(w.last_checked_at)}</span>
          </div>

          <div class="inspection-drawer hidden" id="drawer-${w.id}">
            <div class="inspection-grid">
              <div class="inspection-item">
                <span class="inspection-key">Watch ID</span>
                <span class="inspection-value">${escapeHtml(w.id)}</span>
              </div>
              <div class="inspection-item">
                <span class="inspection-key">ETag / State Hash</span>
                <span class="inspection-value">${escapeHtml(w.resolution_config?.etag || 'None / Polling')}</span>
              </div>
              <div class="inspection-item">
                <span class="inspection-key">Channels</span>
                <span class="inspection-value">${escapeHtml((w.notify_channels || []).join(', ') || 'In-App')}</span>
              </div>
              <div class="inspection-item">
                <span class="inspection-key">Claim URL</span>
                <span class="inspection-value"><a href="/claim?token=${escapeHtml(w.subscriber_token || '')}" class="endpoint-link" target="_blank">Direct Claim Link ↗</a></span>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  // Attach checklist interactive toggle handlers
  container.querySelectorAll('input[type="checkbox"][data-watch-id]').forEach((chk) => {
    chk.addEventListener('change', async () => {
      const watchId = chk.getAttribute('data-watch-id');
      const itemText = chk.getAttribute('data-item');
      const completed = chk.checked;
      const label = chk.closest('.checklist-label');
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

  // Attach drawer toggle handlers
  container.querySelectorAll('.btn-toggle-drawer').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-watch-id');
      const drawer = document.getElementById(`drawer-${id}`);
      if (drawer) {
        const isHidden = drawer.classList.toggle('hidden');
        btn.textContent = isHidden ? 'Details ▾' : 'Hide Details ▴';
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
        btn.textContent = 'Check';
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
      badge.textContent = `${unread}`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (list.length === 0) {
    container.innerHTML = '<p class="empty-state">No alerts or checks dispatched yet.</p>';
    return;
  }

  container.innerHTML = list
    .slice(0, 15)
    .map((n) => {
      return `
      <div class="activity-item ${n.is_read ? '' : 'unread'}" data-notif-id="${n.id}">
        <div class="activity-header">
          <span class="activity-channel">${escapeHtml(n.channel)}</span>
          <span class="activity-time">${formatTime(n.created_at)}</span>
        </div>
        <div class="activity-subject">${escapeHtml(n.subject)}</div>
        <div class="activity-body">${escapeHtml(n.message)}</div>
      </div>
    `;
    })
    .join('');

  container.querySelectorAll('.activity-item.unread').forEach((item) => {
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
      if (ch.channel === 'email') desc = ch.config?.default_recipient ? escapeHtml(ch.config.default_recipient) : 'Unbound — set via chat or session';
      else if (ch.channel === 'in_app') desc = 'In-browser feed & live state';
      else if (ch.channel === 'web_push') desc = 'Standard W3C Web Push';
      else desc = ch.config?.webhook_url ? 'Webhook connected' : 'Not configured';

      return `
      <div class="channel-card">
        <div class="channel-info">
          <strong>${escapeHtml(ch.channel.replace('_', ' '))}</strong>
          <span>${desc}</span>
        </div>
        <label class="switch" aria-label="Toggle ${escapeHtml(ch.channel)}">
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
    document.querySelectorAll('.countdown-clock[data-target-date]').forEach((el) => {
      const dateIso = el.getAttribute('data-target-date');
      const cd = calculateCountdown(dateIso);
      if (cd) {
        if (cd.expired) {
          el.className = 'countdown-clock live';
          el.textContent = 'Trigger Window Active';
        } else {
          el.textContent = cd.text;
          if (cd.days <= 3) el.classList.add('urgent');
        }
      }
    });
  }, 1000);
}

function setupFilterTabs() {
  document.querySelectorAll('.segment-btn').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.segment-btn').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      currentFilter = tab.getAttribute('data-status') || 'all';
      renderWatches();
    });
  });
}

function setupModals() {
  // Light dismiss fallback for all dialogs (modern web guidance)
  document.querySelectorAll('dialog').forEach((dialog) => {
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isInside = (
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width
        );
        if (!isInside) dialog.close();
      });
    }
  });

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
      alert('Browser Push Notifications enabled');
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
