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

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function calculateCountdown(targetDateIso, isTriggered = false) {
  if (!targetDateIso) return null;
  const target = new Date(targetDateIso).getTime();
  if (isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    if (isTriggered) {
      return { expired: true, isTriggered: true, text: 'Triggered · Portal Open' };
    }
    return { expired: true, isTriggered: false, text: 'Monitoring Window Active' };
  }

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
  if (watch.status === 'cooled_down') {
    return '<span class="status-pill hibernating"><span class="status-pill-dot"></span>Race Cooled Down</span>';
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
    case 'deal_or_promo': return 'Verified Deal';
    case 'regulatory_deadline': return 'Regulatory';
    case 'visa_slot': return 'Visa Appointment';
    case 'conference': return 'Conference';
    case 'hackathon': return 'Hackathon';
    case 'grant': return 'Grant';
    case 'calendar_reminder': return 'Calendar Event';
    default: return 'Opportunity';
  }
}

function buildCommerceBadgesHtml(w) {
  const pred = w.commerce_predicate;
  const state = w.last_commerce_state;
  if (!pred && !state && !w.cluster_group_id) return '';

  const pills = [];
  if (w.cluster_group_id) {
    pills.push(`<span class="category-tag" title="Competitive Multi-Store Cluster Race (${escapeHtml(w.cluster_group_id)})">Cluster Race</span>`);
  }
  if (pred?.targetPrice != null) {
    pills.push(`<span class="category-tag">Target &le; $${Number(pred.targetPrice).toFixed(2)}</span>`);
  }
  if (state?.extracted?.currentPrice != null) {
    const cur = Number(state.extracted.currentPrice).toFixed(2);
    const dropTxt = state.effectiveDropPercentage != null ? ` (-${state.effectiveDropPercentage}%)` : '';
    pills.push(`<span class="status-pill ${state.satisfied ? 'active' : 'approaching'}">Live: $${cur}${escapeHtml(dropTxt)}</span>`);
  }
  if (state?.extracted?.ratingConfidenceScore != null) {
    const pct = (Number(state.extracted.ratingConfidenceScore) * 100).toFixed(1);
    pills.push(`<span class="category-tag" title="95% Wilson Score Lower Bound">Wilson Rating: ${pct}%</span>`);
  } else if (pred?.minRatingConfidence != null) {
    const pct = (Number(pred.minRatingConfidence) * 100).toFixed(0);
    pills.push(`<span class="category-tag">Min Rating: ${pct}%</span>`);
  }
  if (pred?.requiredPromoCode) {
    const verified = state?.extracted?.promoCodeVerified;
    const statusIcon = verified === true ? '✓' : verified === false ? '✗' : '•';
    pills.push(`<span class="category-tag">Promo: ${escapeHtml(pred.requiredPromoCode)} ${statusIcon}</span>`);
  }
  return pills.join('');
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

function renderWatchCardHtml(w, isDrawerOpen = false) {
  const catLabel = getCategoryLabel(w.category);
  const phaseBadge = getTemporalPhaseBadge(w);
  const targetDate = w.window_start_date || w.detected_deadline;
  const isTriggered = w.status === 'triggered_open';
  const countdown = calculateCountdown(targetDate, isTriggered);
  const domain = extractDomain(w.target_url);

  let countdownHtml = '';
  if (countdown) {
    if (countdown.expired) {
      const badgeClass = countdown.isTriggered ? 'countdown-clock live' : 'countdown-clock approaching';
      countdownHtml = `<span class="${badgeClass}">${escapeHtml(countdown.text)}</span>`;
    } else {
      const isUrgent = countdown.days <= 3;
      countdownHtml = `<span class="countdown-clock ${isUrgent ? 'urgent' : ''}" data-target-date="${escapeHtml(targetDate)}">${escapeHtml(countdown.text)}</span>`;
    }
  }
  const commerceBadgesHtml = buildCommerceBadgesHtml(w);

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

  const googleCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(w.title)}&dates=${(w.window_start_date || '20261101').replace(/[-:]/g, '')}T090000Z/${(w.window_start_date || '20261101').replace(/[-:]/g, '')}T100000Z&details=${encodeURIComponent(w.chat_context || w.title)}`;
  const icsDownloadUrl = `/api/watches/${encodeURIComponent(w.id)}/calendar.ics`;

  return `
    <article class="watch-row ${isTriggered ? 'is-triggered' : ''}" data-watch-id="${w.id}">
      <div class="watch-row-header">
        <div style="flex: 1; min-width: 0;">
          <div class="watch-meta-strip">
            ${phaseBadge}
            <span class="category-tag">${escapeHtml(catLabel)}</span>
            ${domain ? `<span class="domain-tag">${escapeHtml(domain)}</span>` : ''}
            ${commerceBadgesHtml}
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
          <button type="button" class="btn-text btn-toggle-drawer" data-watch-id="${w.id}">${isDrawerOpen ? 'Hide Details ▴' : 'Details ▾'}</button>
        </div>
        <span class="domain-tag last-checked-tag">Last checked: ${formatTime(w.last_checked_at)}</span>
      </div>

      <div class="inspection-drawer ${isDrawerOpen ? '' : 'hidden'}" id="drawer-${w.id}">
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
}

function updateWatchCardDom(cardEl, w, isDrawerOpen) {
  const isTriggered = w.status === 'triggered_open';
  const targetClass = `watch-row ${isTriggered ? 'is-triggered' : ''}`;
  if (cardEl.className !== targetClass) cardEl.className = targetClass;

  const titleEl = cardEl.querySelector('.watch-title');
  if (titleEl && titleEl.textContent !== w.title) {
    titleEl.textContent = w.title;
  }

  const summaryEl = cardEl.querySelector('.watch-window-summary');
  if (summaryEl) {
    const summaryHtml = `Target: <strong>${escapeHtml(w.window_label || w.window_start_date || 'Unspecified')}</strong>${w.detected_deadline ? ` · Deadline: <strong>${escapeHtml(w.detected_deadline)}</strong>` : ''}`;
    if (summaryEl.innerHTML !== summaryHtml) {
      summaryEl.innerHTML = summaryHtml;
    }
  }

  const lastCheckedEl = cardEl.querySelector('.last-checked-tag');
  if (lastCheckedEl) {
    const text = `Last checked: ${formatTime(w.last_checked_at)}`;
    if (lastCheckedEl.textContent !== text) {
      lastCheckedEl.textContent = text;
    }
  }

  const metaStrip = cardEl.querySelector('.watch-meta-strip');
  if (metaStrip) {
    const targetDate = w.window_start_date || w.detected_deadline;
    const countdown = calculateCountdown(targetDate, isTriggered);
    const domain = extractDomain(w.target_url);
    const catLabel = getCategoryLabel(w.category);
    const phaseBadge = getTemporalPhaseBadge(w);
    let countdownHtml = '';
    if (countdown) {
      if (countdown.expired) {
        const badgeClass = countdown.isTriggered ? 'countdown-clock live' : 'countdown-clock approaching';
        countdownHtml = `<span class="${badgeClass}">${escapeHtml(countdown.text)}</span>`;
      } else {
        const isUrgent = countdown.days <= 3;
        countdownHtml = `<span class="countdown-clock ${isUrgent ? 'urgent' : ''}" data-target-date="${escapeHtml(targetDate)}">${escapeHtml(countdown.text)}</span>`;
      }
    }
    const commerceBadgesHtml = buildCommerceBadgesHtml(w);
    const expectedMetaHtml = `${phaseBadge}<span class="category-tag">${escapeHtml(catLabel)}</span>${domain ? `<span class="domain-tag">${escapeHtml(domain)}</span>` : ''}${commerceBadgesHtml}${countdownHtml}`.replace(/\s+/g, ' ');
    const currentMetaHtml = metaStrip.innerHTML.replace(/\s+/g, ' ');
    if (currentMetaHtml !== expectedMetaHtml) {
      metaStrip.innerHTML = expectedMetaHtml;
    }
  }

  const meta = w.resolution_config?.provider_metadata || {};
  const completedList = Array.isArray(meta.checklist_completed) ? meta.checklist_completed : [];
  cardEl.querySelectorAll('input[type="checkbox"][data-item]').forEach((chk) => {
    const item = chk.getAttribute('data-item');
    const isDone = completedList.includes(item);
    if (chk.checked !== isDone) {
      chk.checked = isDone;
      const label = chk.closest('.checklist-label');
      if (label) {
        if (isDone) label.classList.add('is-done');
        else label.classList.remove('is-done');
      }
    }
  });

  const drawerEl = cardEl.querySelector('.inspection-drawer');
  const drawerBtn = cardEl.querySelector('.btn-toggle-drawer');
  if (drawerEl) {
    if (isDrawerOpen) {
      drawerEl.classList.remove('hidden');
      if (drawerBtn) drawerBtn.textContent = 'Hide Details ▴';
    } else {
      drawerEl.classList.add('hidden');
      if (drawerBtn) drawerBtn.textContent = 'Details ▾';
    }
  }
}

function renderWatches() {
  const container = document.getElementById('watchesListContainer');
  const countBadge = document.getElementById('watchesCountBadge');
  if (!container) return;

  const allWatches = latestState.watches || [];
  if (countBadge && countBadge.textContent !== String(allWatches.length)) {
    countBadge.textContent = String(allWatches.length);
  }

  if (allWatches.length === 0) {
    if (!container.querySelector('.zero-state-view')) {
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
    }
    return;
  }

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
    const emptyMsg = `<p class="empty-state">No watches matching filter "${currentFilter}".</p>`;
    if (container.innerHTML !== emptyMsg) {
      container.innerHTML = emptyMsg;
    }
    return;
  }

  if (container.querySelector('.zero-state-view') || container.querySelector('.empty-state')) {
    container.innerHTML = '';
  }

  const openDrawers = new Set(
    Array.from(container.querySelectorAll('.inspection-drawer:not(.hidden)')).map((d) =>
      d.id.replace('drawer-', '')
    )
  );

  const existingMap = new Map();
  container.querySelectorAll('.watch-row[data-watch-id]').forEach((el) => {
    existingMap.set(el.getAttribute('data-watch-id'), el);
  });

  const nextNodes = [];
  for (const w of filtered) {
    const isDrawerOpen = openDrawers.has(w.id);
    const existing = existingMap.get(w.id);
    if (existing) {
      existingMap.delete(w.id);
      updateWatchCardDom(existing, w, isDrawerOpen);
      nextNodes.push(existing);
    } else {
      const temp = document.createElement('div');
      temp.innerHTML = renderWatchCardHtml(w, isDrawerOpen);
      nextNodes.push(temp.firstElementChild);
    }
  }

  for (const [_, stale] of existingMap) {
    stale.remove();
  }

  for (let i = 0; i < nextNodes.length; i++) {
    const node = nextNodes[i];
    if (container.children[i] !== node) {
      container.insertBefore(node, container.children[i] || null);
    }
  }
}

function renderNotifications() {
  const container = document.getElementById('notificationsContainer');
  const badge = document.getElementById('unreadBadge');
  if (!container) return;

  const list = latestState.notifications || [];
  const unread = list.filter((n) => !n.is_read).length;

  if (badge) {
    if (unread > 0) {
      if (badge.textContent !== String(unread)) badge.textContent = `${unread}`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  if (list.length === 0) {
    if (!container.querySelector('.empty-state')) {
      container.innerHTML = '<p class="empty-state">No alerts or checks dispatched yet.</p>';
    }
    return;
  }

  const existingMap = new Map();
  container.querySelectorAll('.activity-item[data-notif-id]').forEach((el) => {
    existingMap.set(el.getAttribute('data-notif-id'), el);
  });

  const nextItems = list.slice(0, 15);
  const nextNodes = [];

  for (const n of nextItems) {
    const existing = existingMap.get(n.id);
    if (existing) {
      existingMap.delete(n.id);
      const isUnread = !n.is_read;
      if (isUnread && !existing.classList.contains('unread')) {
        existing.classList.add('unread');
      } else if (!isUnread && existing.classList.contains('unread')) {
        existing.classList.remove('unread');
      }
      nextNodes.push(existing);
    } else {
      const temp = document.createElement('div');
      temp.innerHTML = `
        <div class="activity-item ${n.is_read ? '' : 'unread'}" data-notif-id="${n.id}">
          <div class="activity-header">
            <span class="activity-channel">${escapeHtml(n.channel)}</span>
            <span class="activity-time">${formatTime(n.created_at)}</span>
          </div>
          <div class="activity-subject">${escapeHtml(n.subject)}</div>
          <div class="activity-body">${escapeHtml(n.message)}</div>
        </div>
      `;
      nextNodes.push(temp.firstElementChild);
    }
  }

  for (const [_, stale] of existingMap) {
    stale.remove();
  }

  const emptyEl = container.querySelector('.empty-state');
  if (emptyEl) emptyEl.remove();

  for (let i = 0; i < nextNodes.length; i++) {
    const node = nextNodes[i];
    if (container.children[i] !== node) {
      container.insertBefore(node, container.children[i] || null);
    }
  }
}

function renderChannels() {
  const container = document.getElementById('channelsConfigContainer');
  if (!container) return;

  const channels = latestState.channels || [];
  if (channels.length === 0) {
    if (!container.querySelector('.empty-state')) {
      container.innerHTML = '<p class="empty-state">Loading channels...</p>';
    }
    return;
  }

  const existingCards = new Map();
  container.querySelectorAll('.channel-card[data-channel]').forEach((el) => {
    existingCards.set(el.getAttribute('data-channel'), el);
  });

  const nextNodes = [];
  for (const ch of channels) {
    const isEnabled = Boolean(ch.enabled);
    let desc = '';
    if (ch.channel === 'email') {
      desc = ch.config?.default_recipient ? escapeHtml(ch.config.default_recipient) : 'Unbound — set via chat or session';
    } else if (ch.channel === 'in_app') {
      desc = 'In-browser feed & live state';
    } else if (ch.channel === 'web_push') {
      desc = ch.config?.endpoint ? 'Browser & Mobile System Alerts (Active)' : 'Standard W3C Web Push';
    } else {
      desc = ch.config?.webhook_url ? 'Webhook connected' : 'Not configured';
    }

    const existing = existingCards.get(ch.channel);
    if (existing) {
      existingCards.delete(ch.channel);
      const descEl = existing.querySelector('.channel-info span');
      if (descEl && descEl.textContent !== desc) descEl.textContent = desc;
      const chk = existing.querySelector('input[type="checkbox"]');
      if (chk && chk.checked !== isEnabled) chk.checked = isEnabled;
      nextNodes.push(existing);
    } else {
      const temp = document.createElement('div');
      temp.innerHTML = `
        <div class="channel-card" data-channel="${ch.channel}">
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
      nextNodes.push(temp.firstElementChild);
    }
  }

  for (const [_, stale] of existingCards) {
    stale.remove();
  }

  const emptyEl = container.querySelector('.empty-state');
  if (emptyEl) emptyEl.remove();

  for (let i = 0; i < nextNodes.length; i++) {
    const node = nextNodes[i];
    if (container.children[i] !== node) {
      container.insertBefore(node, container.children[i] || null);
    }
  }

  const webPushConfig = channels.find((c) => c.channel === 'web_push');
  const pushBtn = document.getElementById('browserPushQuickBtn');
  if (pushBtn) {
    if (webPushConfig?.enabled) {
      pushBtn.textContent = 'Push Active ✓';
      pushBtn.style.color = '#10b981';
    } else {
      pushBtn.textContent = 'Enable Push';
      pushBtn.style.color = '';
    }
  }
}

// Living countdown clock updater (driftless second-aligned scheduling, zero redundant mutations)
let timerRunning = false;

function tickLivingTimers() {
  const clocks = document.querySelectorAll('.countdown-clock[data-target-date]');
  if (clocks.length === 0) return;
  for (let i = 0; i < clocks.length; i++) {
    const el = clocks[i];
    const dateIso = el.getAttribute('data-target-date');
    const cd = calculateCountdown(dateIso, false);
    if (!cd) continue;
    if (cd.expired) {
      const targetClass = 'countdown-clock approaching';
      if (el.className !== targetClass) el.className = targetClass;
      if (el.textContent !== 'Monitoring Window Active') el.textContent = 'Monitoring Window Active';
      el.removeAttribute('data-target-date');
    } else {
      if (el.textContent !== cd.text) {
        el.textContent = cd.text;
      }
      const targetClass = cd.days <= 3 ? 'countdown-clock urgent' : 'countdown-clock';
      if (el.className !== targetClass) {
        el.className = targetClass;
      }
    }
  }
}

function startLivingTimers() {
  if (timerRunning) return;
  timerRunning = true;

  function scheduleNextTick() {
    const now = Date.now();
    const delay = Math.max(50, 1000 - (now % 1000));
    setTimeout(() => {
      tickLivingTimers();
      scheduleNextTick();
    }, delay);
  }
  scheduleNextTick();
}

function setupEventDelegation() {
  const watchContainer = document.getElementById('watchesListContainer');
  if (watchContainer) {
    watchContainer.addEventListener('change', async (e) => {
      const chk = e.target.closest('input[type="checkbox"][data-watch-id]');
      if (!chk) return;
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

    watchContainer.addEventListener('click', async (e) => {
      const drawerBtn = e.target.closest('.btn-toggle-drawer');
      if (drawerBtn) {
        const id = drawerBtn.getAttribute('data-watch-id');
        const drawer = document.getElementById(`drawer-${id}`);
        if (drawer) {
          const isHidden = drawer.classList.toggle('hidden');
          drawerBtn.textContent = isHidden ? 'Details ▾' : 'Hide Details ▴';
        }
        return;
      }

      const checkBtn = e.target.closest('.btn-check-now');
      if (checkBtn) {
        const id = checkBtn.getAttribute('data-watch-id');
        const origText = checkBtn.textContent;
        checkBtn.textContent = 'Checking...';
        try {
          await fetch(`/api/watches/${encodeURIComponent(id)}/check`, { method: 'POST' });
          await fetchOverview();
        } catch {
          checkBtn.textContent = origText;
        }
        return;
      }

      const deleteBtn = e.target.closest('.btn-delete-watch');
      if (deleteBtn) {
        const id = deleteBtn.getAttribute('data-watch-id');
        if (confirm('Delete this monitored watch?')) {
          await fetch(`/api/watches/${encodeURIComponent(id)}`, { method: 'DELETE' });
          await fetchOverview();
        }
        return;
      }
    });
  }

  const notifContainer = document.getElementById('notificationsContainer');
  if (notifContainer) {
    notifContainer.addEventListener('click', async (e) => {
      const item = e.target.closest('.activity-item.unread');
      if (!item) return;
      const id = item.getAttribute('data-notif-id');
      await fetch(`/api/notifications/${encodeURIComponent(id)}/open`, { method: 'POST' });
      item.classList.remove('unread');
    });
  }

  const channelsContainer = document.getElementById('channelsConfigContainer');
  if (channelsContainer) {
    channelsContainer.addEventListener('change', async (e) => {
      const chk = e.target.closest('input[data-channel]');
      if (!chk) return;
      const channel = chk.getAttribute('data-channel');
      const enabled = chk.checked;
      await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, enabled })
      });
      await fetchOverview();
    });
  }
}

function initEventStream() {
  if (!('EventSource' in window)) return;
  const es = new EventSource('/api/events');
  const engineDot = document.getElementById('enginePulseDot');

  es.addEventListener('connected', () => {
    if (engineDot) {
      engineDot.style.background = '#10b981';
      engineDot.title = 'Real-time event stream connected';
    }
  });

  const reloadOverview = () => {
    fetchOverview();
  };

  es.addEventListener('watch:created', reloadOverview);
  es.addEventListener('watch:updated', reloadOverview);
  es.addEventListener('watch:deleted', reloadOverview);
  es.addEventListener('watch:checked', reloadOverview);
  es.addEventListener('resolution:completed', reloadOverview);
  es.addEventListener('notification:created', reloadOverview);
  es.addEventListener('notification:updated', reloadOverview);
  es.addEventListener('channel:updated', reloadOverview);

  es.onerror = () => {
    if (engineDot) {
      engineDot.style.background = '#eab308';
      engineDot.title = 'Reconnecting event stream...';
    }
  };
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
      rrule: form.rrule.value || undefined,
      target_price: form.target_price?.value || undefined,
      min_rating_confidence: form.min_rating_confidence?.value || undefined,
      required_promo_code: form.required_promo_code?.value || undefined
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

  // Full-Stack W3C Web Push Activation
  const pushBtn = document.getElementById('browserPushQuickBtn');
  pushBtn?.addEventListener('click', async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert('W3C Web Push is not supported in this browser environment.');
      return;
    }
    const originalText = pushBtn.textContent;
    try {
      pushBtn.textContent = 'Enabling...';
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        alert('Notification permission was not granted. Please allow notifications in your browser settings.');
        pushBtn.textContent = originalText;
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const res = await fetch('/api/push/vapid-public-key');
      if (!res.ok) throw new Error('Failed to fetch VAPID key from server');
      const { publicKey } = await res.json();
      const appServerKey = urlBase64ToUint8Array(publicKey);

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey
        });
      }

      const subJson = sub.toJSON();
      const saveRes = await fetch('/api/channels/web_push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: {
            endpoint: subJson.endpoint,
            keys: {
              p256dh: subJson.keys?.p256dh,
              auth: subJson.keys?.auth
            }
          }
        })
      });

      if (saveRes.ok) {
        pushBtn.textContent = 'Push Active ✓';
        pushBtn.style.color = '#10b981';
        await fetchOverview();
      } else {
        throw new Error('Failed to register subscription on server');
      }
    } catch (err) {
      console.error('Web Push registration error:', err);
      alert('Could not enable Web Push: ' + (err.message || err));
      pushBtn.textContent = originalText;
    }
  });

  // Canary Multi-Channel Delivery Test Trigger
  const testBtn = document.getElementById('testChannelsBtn');
  testBtn?.addEventListener('click', async () => {
    const originalText = testBtn.textContent;
    testBtn.textContent = 'Sending...';
    try {
      const res = await fetch('/api/channels/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (res.ok) {
        testBtn.textContent = 'Sent ✓';
        setTimeout(() => { testBtn.textContent = originalText; }, 3000);
        await fetchOverview();
      } else {
        alert('Canary dispatch failed: ' + (data.error || 'Server error'));
        testBtn.textContent = originalText;
      }
    } catch (err) {
      console.error('Test dispatch error:', err);
      alert('Failed to trigger canary alert: ' + (err.message || err));
      testBtn.textContent = originalText;
    }
  });

  document.getElementById('markReadBtn')?.addEventListener('click', async () => {
    await fetch('/api/notifications/read-all', { method: 'POST' });
    await fetchOverview();
  });

  // Multi-Platform Deal Discovery Modal
  const dealDialog = document.getElementById('dealSearchDialog');
  document.getElementById('openDealSearchBtn')?.addEventListener('click', () => dealDialog?.showModal());
  document.getElementById('closeDealSearchBtn')?.addEventListener('click', () => dealDialog?.close());

  document.getElementById('dealSearchForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const submitBtn = document.getElementById('dealSearchSubmitBtn');
    const resultsBox = document.getElementById('dealSearchResults');
    if (submitBtn) submitBtn.textContent = 'Scanning Stores...';
    try {
      const res = await fetch('/api/deals/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: form.query.value,
          target_price: form.target_price.value || undefined,
          min_rating_confidence: form.min_rating_confidence.value || undefined,
          auto_watch_if_above_target: true
        })
      });
      const data = await res.json();
      if (resultsBox) {
        const modeBanner =
          data.resolution_mode === 'immediate_winner'
            ? `<div class="status-pill active" style="margin-bottom:8px;">Immediate Verified Winner Found (${data.rejected_count} accessories/shills filtered)</div>`
            : data.resolution_mode === 'cluster_watch_armed'
              ? `<div class="status-pill approaching" style="margin-bottom:8px;">Armed ${data.created_cluster_watches?.length || 0}-Store Competitive Cluster Watch (${escapeHtml(data.cluster_group_id)})</div>`
              : `<div class="status-pill hibernating">No verified listings matched (${data.rejected_count} filtered)</div>`;

        const cards = (data.leaderboard || [])
          .slice(0, 4)
          .map(
            (d) => `
            <div class="watch-row ${d.meetsTargetPredicate ? 'is-triggered' : ''}">
              <div class="watch-meta-strip">
                <span class="status-pill ${d.meetsTargetPredicate ? 'active' : 'approaching'}">Landed: $${Number(d.landedPrice).toFixed(2)}</span>
                <span class="category-tag">${escapeHtml(d.listing.seller)}</span>
                <span class="category-tag">Wilson: ${(d.wilsonConfidence * 100).toFixed(1)}%</span>
                ${d.listing.promoCode ? `<span class="category-tag">Promo: ${escapeHtml(d.listing.promoCode)} (-$${Number(d.promoSavings).toFixed(2)})</span>` : ''}
              </div>
              <div class="watch-title">${escapeHtml(d.listing.title)}</div>
              <div style="margin-top:6px;">
                <a class="link-btn primary-link" href="${escapeHtml(d.listing.url)}" target="_blank" rel="noopener">Open Verified Store ↗</a>
              </div>
            </div>
          `
          )
          .join('');
        resultsBox.innerHTML = modeBanner + cards;
      }
      await fetchOverview();
    } finally {
      if (submitBtn) submitBtn.textContent = 'Search & Compare Stores';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration error:', err);
    });
  }
  setupEventDelegation();
  setupFilterTabs();
  setupModals();
  startLivingTimers();
  initEventStream();
  fetchOverview();
});
