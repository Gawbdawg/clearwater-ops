async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed');
  }
  if (res.status === 204) return null;
  return res.json();
}

const loginView = document.getElementById('loginView');
const dashView = document.getElementById('dashView');
const termsView = document.getElementById('termsView');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');

let properties = [];
let selectedPropertyId = null;
let addonsCatalog = [];
let selectedAddonIds = new Set();

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

function niceDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function selectedProperty() {
  return properties.find((p) => p.id === selectedPropertyId);
}

async function checkSession() {
  try {
    const owner = await api('/api/owner-auth/me');
    await enterPortal(owner);
  } catch (e) {
    loginView.classList.remove('hidden');
    termsView.classList.add('hidden');
    dashView.classList.add('hidden');
    logoutBtn.style.display = 'none';
  }
}

// Routes a just-logged-in (or session-restored) owner to the Terms of Service gate if
// they haven't clicked through it yet, or straight to the dashboard if they have.
async function enterPortal(owner) {
  logoutBtn.style.display = '';
  if (!owner.agreedToTerms) {
    showTermsGate(owner);
    return;
  }
  await showDash(owner);
}

function showTermsGate(owner) {
  loginView.classList.add('hidden');
  dashView.classList.add('hidden');
  termsView.classList.remove('hidden');
  document.getElementById('agreeTermsCheckbox').checked = false;
  document.getElementById('termsError').classList.add('hidden');
  document.getElementById('continueAfterTermsBtn').onclick = async () => {
    const errEl = document.getElementById('termsError');
    errEl.classList.add('hidden');
    if (!document.getElementById('agreeTermsCheckbox').checked) {
      errEl.textContent = 'Please check the box to confirm you agree before continuing.';
      errEl.classList.remove('hidden');
      return;
    }
    const btn = document.getElementById('continueAfterTermsBtn');
    btn.disabled = true;
    try {
      const result = await api('/api/owner/agree-to-terms', { method: 'POST' });
      // Agreeing also opts them into the newsletter (the agreement is the consent) —
      // reflect that on the local owner object so the toggle on Overview shows correctly
      // without a re-fetch.
      owner.agreedToTerms = result.agreedToTerms;
      owner.newsletterSubscribed = result.newsletterSubscribed;
      termsView.classList.add('hidden');
      await showDash(owner);
    } catch (e) {
      errEl.textContent = e.message || 'Could not save your agreement — please try again.';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  };
}

async function showDash(owner) {
  loginView.classList.add('hidden');
  termsView.classList.add('hidden');
  dashView.classList.remove('hidden');
  logoutBtn.style.display = '';
  document.getElementById('welcomeMsg').textContent = `Hi ${owner.name}`;
  document.getElementById('newsletterToggle').checked = owner.newsletterSubscribed !== false;

  properties = await api('/api/owner/properties');
  try {
    addonsCatalog = await api('/api/owner/addons');
  } catch (e) {
    addonsCatalog = [];
  }
  renderRequestAddonOptions();

  if (properties.length === 0) {
    document.getElementById('introText').textContent = "Let's get your property set up so we can start scheduling service.";
    document.getElementById('propertySwitcherRow').classList.add('hidden');
    document.getElementById('ownerTabs').classList.add('hidden');
    document.getElementById('tab-overview').classList.add('hidden');
    document.getElementById('requestPropertyRow').classList.add('hidden');
    document.getElementById('requestsList').innerHTML = '';
    document.getElementById('addPropertyRow').classList.add('hidden');
    document.getElementById('cancelAddPropertyBtn').classList.add('hidden');
    document.getElementById('addPropertyForm').classList.remove('hidden');
    return;
  }

  document.getElementById('introText').textContent = 'Everything about your service and bookings, in one place.';
  document.getElementById('addPropertyRow').classList.remove('hidden');
  document.getElementById('addPropertyForm').classList.add('hidden');
  document.getElementById('cancelAddPropertyBtn').classList.remove('hidden');
  document.getElementById('ownerTabs').classList.remove('hidden');
  switchTab('overview');

  const hasMultiple = properties.length > 1;
  const switcherRow = document.getElementById('propertySwitcherRow');
  switcherRow.classList.toggle('hidden', !hasMultiple);
  if (hasMultiple) {
    const select = document.getElementById('propertySelect');
    select.innerHTML = properties.map((p) => `<option value="${p.id}">${p.name}${p.address ? ' — ' + p.address : ''}</option>`).join('');
    select.onchange = () => { selectedPropertyId = Number(select.value); onPropertyChange(); };
  }

  const reqPropRow = document.getElementById('requestPropertyRow');
  reqPropRow.classList.toggle('hidden', !hasMultiple);
  const reqSelect = document.getElementById('requestPropertySelect');
  reqSelect.innerHTML = properties.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');

  selectedPropertyId = properties[0].id;
  onPropertyChange();
  loadVisits();
  loadRequests();
  loadOverview();
}

function onPropertyChange() {
  const p = selectedProperty();
  const isVacation = p.type === 'vacation';
  document.getElementById('calendarTabBtn').classList.toggle('hidden', !isVacation);
  if (!isVacation && activeTab === 'calendar') switchTab('overview');
  document.getElementById('bookingSectionPropertyName').textContent = properties.length > 1 ? `— ${p.name}` : '';
  if (isVacation) {
    document.getElementById('icalUrlInput').value = p.icalUrl || '';
    updateSyncStatus(p);
    loadBookings();
  }
  const reqSelect = document.getElementById('requestPropertySelect');
  if (reqSelect) reqSelect.value = String(selectedPropertyId);
  loadServiceSetup();
}

// ---- Set up regular service (frequency + price + start date) ----
let serviceSetupData = null;

const FREQUENCY_LABELS = { weekly: 'Weekly', biweekly: 'Every 2 weeks', every4weeks: 'Every 4 weeks' };

async function loadServiceSetup() {
  const card = document.getElementById('serviceSetupCard');
  try {
    serviceSetupData = await api(`/api/owner/properties/${selectedPropertyId}/service-setup`);
  } catch (e) {
    card.classList.add('hidden');
    return;
  }
  if (!serviceSetupData.available) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  renderServiceSetup();
}

function renderServiceSetup() {
  const d = serviceSetupData;
  const content = document.getElementById('serviceSetupContent');

  if (d.currentFrequency) {
    const priceLine = d.isCustom
      ? `$${Number(d.customPrice).toFixed(2)} per service`
      : `$${Number(d[d.currentFrequency]).toFixed(2)} per service`;
    content.innerHTML = `
      <h2 style="margin:0 0 4px; font-size:16px;">Your regular service</h2>
      <p class="portal-sub" style="margin:0;">${FREQUENCY_LABELS[d.currentFrequency] || d.currentFrequency} — ${priceLine}</p>
      <p class="portal-sub" style="margin:6px 0 0; font-size:12px;">Need to change your schedule? Contact us and we'll take care of it.</p>
    `;
    return;
  }

  const priceFor = (freq) => (d.isCustom ? Number(d.customPrice) : Number(d[freq]));
  content.innerHTML = `
    <h2 style="margin:0 0 4px; font-size:16px;">Set up your regular service</h2>
    <p class="portal-sub" style="margin:0 0 12px;">Pick how often you'd like service and when to start — we'll put the services right on the calendar.</p>
    <div id="ssError" class="portal-error hidden"></div>
    <label>Frequency
      <select id="ssFrequency">
        <option value="weekly">Weekly — $${priceFor('weekly').toFixed(2)}/service</option>
        <option value="biweekly">Every 2 weeks — $${priceFor('biweekly').toFixed(2)}/service</option>
        <option value="every4weeks">Every 4 weeks — $${priceFor('every4weeks').toFixed(2)}/service</option>
      </select>
    </label>
    <label>Start date<input type="date" id="ssStartDate" value="${todayStr()}" /></label>
    <button class="btn primary" id="ssSubmitBtn">Set up service</button>
  `;
  document.getElementById('ssSubmitBtn').addEventListener('click', saveServiceSetup);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function saveServiceSetup() {
  const errEl = document.getElementById('ssError');
  errEl.classList.add('hidden');
  const frequency = document.getElementById('ssFrequency').value;
  const startDate = document.getElementById('ssStartDate').value;
  if (!startDate) {
    errEl.textContent = 'Please pick a start date.';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = document.getElementById('ssSubmitBtn');
  btn.disabled = true;
  try {
    await api(`/api/owner/properties/${selectedPropertyId}/schedule-service`, {
      method: 'POST',
      body: JSON.stringify({ frequency, startDate }),
    });
    await loadServiceSetup();
    loadVisits();
    loadOverview();
  } catch (e) {
    errEl.textContent = e.message || 'Could not set up service.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

// ---- Tabs ----
let activeTab = 'overview';

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.owner-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.owner-tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tab}`);
  });
}

document.getElementById('ownerTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.owner-tab-btn');
  if (btn && !btn.classList.contains('hidden')) switchTab(btn.dataset.tab);
});

// ---- Overview ----
async function loadOverview() {
  const [visits, requests, bookings] = await Promise.all([
    api('/api/owner/appointments'),
    api('/api/owner/service-requests'),
    api('/api/owner/bookings'),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  const nextVisit = visits.find((v) => v.date >= today && v.status === 'scheduled');
  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const hasVacation = properties.some((p) => p.type === 'vacation');
  const upcomingBookings = bookings.filter((b) => b.endDate >= today).length;

  document.getElementById('pendingRequestsBadge').textContent = pendingCount || '';
  document.getElementById('pendingRequestsBadge').classList.toggle('hidden', pendingCount === 0);

  const cards = [
    {
      value: nextVisit ? niceDateShort(nextVisit.date) : '—',
      label: 'Next scheduled service',
      detail: nextVisit ? (properties.length > 1 ? nextVisit.propertyName : (nextVisit.serviceType || '')) : 'Nothing scheduled yet',
    },
    {
      value: String(pendingCount),
      label: pendingCount === 1 ? 'Pending request' : 'Pending requests',
      detail: pendingCount ? 'Awaiting confirmation' : 'All caught up',
    },
    {
      value: String(properties.length),
      label: properties.length === 1 ? 'Property' : 'Properties',
      detail: properties.map((p) => p.name).join(', '),
    },
  ];
  if (hasVacation) {
    cards.push({
      value: String(upcomingBookings),
      label: upcomingBookings === 1 ? 'Upcoming guest booking' : 'Upcoming guest bookings',
      detail: 'Across all vacation properties',
    });
  }

  document.getElementById('overviewSummary').innerHTML = cards.map((c) => `
    <div class="owner-summary-card">
      <div class="value">${c.value}</div>
      <div class="label">${c.label}</div>
      ${c.detail ? `<div class="detail">${c.detail}</div>` : ''}
    </div>
  `).join('');
}

function niceDateShort(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function updateSyncStatus(p) {
  const el = document.getElementById('icalSyncStatus');
  el.textContent = p.icalLastSyncedAt
    ? `Last synced ${new Date(p.icalLastSyncedAt).toLocaleString()}`
    : (p.icalUrl ? 'Not synced yet — click "Save & sync now."' : '');
}

async function loadBookings() {
  const bookings = await api('/api/owner/bookings?propertyId=' + selectedPropertyId);
  const el = document.getElementById('bookingsList');
  if (bookings.length === 0) {
    el.innerHTML = '<div class="empty-state">No guest dates added yet.</div>';
    return;
  }
  el.innerHTML = bookings.map((b) => `
    <div class="owner-list-item">
      <div>
        <strong>${niceDate(b.startDate)} – ${niceDate(b.endDate)}</strong>
        ${b.source === 'ical' ? '<span class="badge sent">Auto-synced</span>' : '<span class="badge completed">Manual</span>'}
        ${b.notes ? `<div class="job-meta">${b.notes}</div>` : ''}
      </div>
      <button class="btn small danger" onclick="deleteBooking(${b.id})">Remove</button>
    </div>
  `).join('');
}

async function loadVisits() {
  const visits = await api('/api/owner/appointments');
  const el = document.getElementById('visitsList');
  if (visits.length === 0) {
    el.innerHTML = '<div class="empty-state">No services on the calendar yet.</div>';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  el.innerHTML = visits.map((v) => `
    <div class="owner-list-item" style="align-items:flex-start; flex-direction:column;">
      <div style="width:100%;">
        <strong>${niceDate(v.date)}${v.startTime ? ' · ' + v.startTime : ''}</strong>
        ${properties.length > 1 ? `<span class="job-meta">${v.propertyName}</span>` : ''}
        <span class="badge ${v.status === 'completed' ? 'completed' : v.date < today ? 'draft' : 'scheduled'}">${v.status}</span>
        ${v.serviceType ? `<div class="job-meta">${v.serviceType}</div>` : ''}
      </div>
      ${v.status === 'scheduled' ? renderVisitAddons(v) : (v.addons && v.addons.length ? `<div class="job-meta">Extras: ${v.addons.map((a) => `${a.name} ($${Number(a.price).toFixed(2)})`).join(', ')}</div>` : '')}
      ${renderVisitPhotos(v)}
      ${v.status === 'scheduled' ? `<button class="btn small danger" style="margin-top:8px;" onclick="cancelVisit(${v.id}, '${v.date}', '${v.startTime || ''}')">Cancel service</button>` : ''}
    </div>
  `).join('');
}

// Pins a date+time string to the shop's own timezone (Pacific) rather than whatever
// timezone this code happens to be running in — matches lib/timezone.js's
// businessTimeToUtc exactly, so the browser's confirm-dialog wording below always
// agrees with the server's actual fee decision instead of drifting apart when the
// owner isn't in the same timezone as the server (or the shop).
const BUSINESS_TIMEZONE = 'America/Los_Angeles';

function businessTimeToUtc(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = (timeStr || '09:00').split(':').map(Number);
  const utcGuess = new Date(Date.UTC(y, m - 1, d, h, min || 0, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(utcGuess).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMinutes = (asIfUtc - utcGuess.getTime()) / 60000;
  return new Date(utcGuess.getTime() - offsetMinutes * 60000);
}

// Cancellation policy: 24+ hours' notice is free; less than 24 hours bills half the
// service price. The actual charge/no-charge decision is made server-side (this is
// just for the confirm-dialog wording) — see routes/ownerPortal.js#/appointments/:id/cancel.
window.cancelVisit = async (apptId, dateStr, startTime) => {
  const visitDateTime = businessTimeToUtc(dateStr, startTime);
  const hoursUntil = (visitDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
  const warning = hoursUntil < 24
    ? "This service is less than 24 hours away. Our cancellation policy charges half the service price as a fee for cancellations this close to the appointment. Cancel anyway?"
    : 'Cancel this service?';
  if (!confirm(warning)) return;
  try {
    const result = await api(`/api/owner/appointments/${apptId}/cancel`, { method: 'POST' });
    if (result.feeCharged) {
      alert(`Service cancelled. A $${Number(result.feeAmount).toFixed(2)} cancellation fee applies since this was within 24 hours.`);
    } else {
      alert('Service cancelled — no fee.');
    }
    loadVisits();
    loadOverview();
  } catch (e) {
    alert(e.message || 'Could not cancel this service.');
  }
};

function renderVisitPhotos(v) {
  const photos = v.photos || [];
  if (photos.length === 0) return '';
  return `
    <div class="job-photos" style="margin-top:8px;">
      ${photos.map((p) => `
        <a class="job-photo" href="${p.url}" target="_blank" rel="noopener">
          <img src="${p.url}" alt="${p.type} photo" />
          <div class="job-photo-label">${p.type}</div>
        </a>
      `).join('')}
    </div>
  `;
}

function renderVisitAddons(v) {
  const attached = v.addons || [];
  const attachedIds = attached.map((a) => a.id);
  const total = attached.reduce((sum, a) => sum + (Number(a.price) || 0), 0);
  if (addonsCatalog.length === 0) return '';
  return `
    <div class="job-addons" style="width:100%; margin-top:8px;">
      <div class="job-meta" style="margin-bottom:4px;">Add extras to this service${total ? ` — +$${total.toFixed(2)} added` : ''}</div>
      <div class="job-addon-chips">
        ${addonsCatalog.map((a) => `
          <button type="button" class="addon-chip ${attachedIds.includes(a.id) ? 'added' : ''}" onclick="toggleVisitAddon(${v.id}, ${a.id}, ${attachedIds.includes(a.id)})">
            ${attachedIds.includes(a.id) ? '✓ ' : '+ '}${a.name} ($${Number(a.price).toFixed(2)})
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

window.toggleVisitAddon = async (apptId, addonId, currentlyAttached) => {
  try {
    if (currentlyAttached) {
      await api(`/api/owner/appointments/${apptId}/addons/${addonId}`, { method: 'DELETE' });
    } else {
      await api(`/api/owner/appointments/${apptId}/addons`, { method: 'POST', body: JSON.stringify({ addonId }) });
    }
    await loadVisits();
  } catch (e) {
    alert(e.message || 'Could not update extras');
  }
};

async function loadRequests() {
  const requests = await api('/api/owner/service-requests');
  const el = document.getElementById('requestsList');
  if (requests.length === 0) {
    el.innerHTML = '<div class="empty-state">No service requests yet.</div>';
    return;
  }
  el.innerHTML = requests.map((r) => `
    <div class="owner-list-item">
      <div>
        <strong>${niceDate(r.requestedDate)}</strong>
        ${properties.length > 1 ? `<span class="job-meta">${r.propertyName}</span>` : ''}
        <span class="badge ${r.status === 'pending' ? 'draft' : r.status === 'scheduled' ? 'completed' : 'cancelled'}">${r.status}</span>
        ${r.notes ? `<div class="job-meta">${r.notes}</div>` : ''}
        ${r.addons && r.addons.length ? `<div class="job-meta">Extras: ${r.addons.map((a) => `${a.name} ($${Number(a.price).toFixed(2)})`).join(', ')}</div>` : ''}
      </div>
      ${r.status === 'pending' ? `<button class="btn small danger" onclick="deleteRequest(${r.id})">Cancel</button>` : ''}
    </div>
  `).join('');
}

function renderRequestAddonOptions() {
  const row = document.getElementById('requestAddonsRow');
  const list = document.getElementById('requestAddonsList');
  if (addonsCatalog.length === 0) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  list.innerHTML = addonsCatalog.map((a) => `
    <button type="button" class="addon-chip ${selectedAddonIds.has(a.id) ? 'added' : ''}" onclick="toggleRequestAddon(${a.id})">
      ${selectedAddonIds.has(a.id) ? '✓ ' : '+ '}${a.name} ($${Number(a.price).toFixed(2)})
    </button>
  `).join('');
}

window.toggleRequestAddon = (addonId) => {
  if (selectedAddonIds.has(addonId)) selectedAddonIds.delete(addonId);
  else selectedAddonIds.add(addonId);
  renderRequestAddonOptions();
};

window.deleteBooking = async (id) => {
  await api('/api/owner/bookings/' + id, { method: 'DELETE' });
  loadBookings();
};

window.deleteRequest = async (id) => {
  await api('/api/owner/service-requests/' + id, { method: 'DELETE' });
  loadRequests();
};

document.getElementById('saveIcalBtn').addEventListener('click', async () => {
  const icalUrl = document.getElementById('icalUrlInput').value.trim();
  const statusEl = document.getElementById('icalSyncStatus');
  const btn = document.getElementById('saveIcalBtn');
  btn.disabled = true;
  statusEl.textContent = 'Saving and syncing…';
  try {
    await api(`/api/owner/properties/${selectedPropertyId}/ical-url`, { method: 'PUT', body: JSON.stringify({ icalUrl }) });
    const p = selectedProperty();
    p.icalUrl = icalUrl;
    if (icalUrl) {
      const result = await api(`/api/owner/properties/${selectedPropertyId}/sync-calendar`, { method: 'POST' });
      statusEl.textContent = `Synced — found ${result.count} booked date range${result.count === 1 ? '' : 's'}.`;
      p.icalLastSyncedAt = new Date().toISOString();
    } else {
      statusEl.textContent = 'Calendar link removed.';
    }
    loadBookings();
  } catch (e) {
    statusEl.textContent = `Couldn't sync: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('addBookingBtn').addEventListener('click', async () => {
  const startDate = document.getElementById('bookingStart').value;
  const endDate = document.getElementById('bookingEnd').value;
  const notes = document.getElementById('bookingNotes').value;
  if (!startDate || !endDate) { alert('Please pick both a check-in and check-out date.'); return; }
  const btn = document.getElementById('addBookingBtn');
  btn.disabled = true;
  try {
    await api('/api/owner/bookings', { method: 'POST', body: JSON.stringify({ propertyId: selectedPropertyId, startDate, endDate, notes }) });
    document.getElementById('bookingStart').value = '';
    document.getElementById('bookingEnd').value = '';
    document.getElementById('bookingNotes').value = '';
    loadBookings();
  } catch (e) {
    alert('Could not add booking: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('addRequestBtn').addEventListener('click', async () => {
  const reqSelect = document.getElementById('requestPropertySelect');
  const propertyId = reqSelect && !reqSelect.closest('.hidden') ? Number(reqSelect.value) : selectedPropertyId;
  const requestedDate = document.getElementById('requestDate').value;
  const notes = document.getElementById('requestNotes').value;
  if (!requestedDate) { alert('Please pick a date.'); return; }
  const btn = document.getElementById('addRequestBtn');
  btn.disabled = true;
  try {
    const addonIds = Array.from(selectedAddonIds);
    await api('/api/owner/service-requests', { method: 'POST', body: JSON.stringify({ propertyId, requestedDate, notes, addonIds }) });
    document.getElementById('requestDate').value = '';
    document.getElementById('requestNotes').value = '';
    selectedAddonIds = new Set();
    renderRequestAddonOptions();
    loadRequests();
  } catch (e) {
    alert('Could not submit request: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('loginBtn').addEventListener('click', async () => {
  loginError.classList.add('hidden');
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const owner = await api('/api/owner-auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    await enterPortal(owner);
  } catch (e) {
    showError(e.message);
  }
});

document.getElementById('loginPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

document.getElementById('togglePasswordLoginBtn').addEventListener('click', () => {
  const fields = document.getElementById('passwordLoginFields');
  const showingPassword = !fields.classList.contains('hidden');
  fields.classList.toggle('hidden', showingPassword);
  document.getElementById('togglePasswordLoginBtn').textContent = showingPassword
    ? 'Use username & password instead'
    : 'Use email code instead';
  document.getElementById('codeLoginStep1').classList.toggle('hidden', !showingPassword);
  document.getElementById('codeLoginStep2').classList.add('hidden');
});

let codeLoginEmail = '';

async function sendLoginCode() {
  loginError.classList.add('hidden');
  const email = document.getElementById('codeEmail').value.trim();
  if (!email) { showError('Please enter your email.'); return; }
  const btn = document.getElementById('sendCodeBtn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await api('/api/owner-auth/request-code', { method: 'POST', body: JSON.stringify({ email }) });
    codeLoginEmail = email;
    document.getElementById('codeSentTo').textContent = `We sent a code to ${email}. Enter it below (check spam if it doesn't show up in a minute).`;
    document.getElementById('codeLoginStep1').classList.add('hidden');
    document.getElementById('codeLoginStep2').classList.remove('hidden');
    document.getElementById('codeInput').focus();
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send me a code';
  }
}

document.getElementById('sendCodeBtn').addEventListener('click', sendLoginCode);
document.getElementById('codeEmail').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendLoginCode();
});

document.getElementById('resendCodeBtn').addEventListener('click', async () => {
  document.getElementById('codeEmail').value = codeLoginEmail;
  document.getElementById('codeLoginStep2').classList.add('hidden');
  document.getElementById('codeLoginStep1').classList.remove('hidden');
});

async function verifyLoginCode() {
  loginError.classList.add('hidden');
  const code = document.getElementById('codeInput').value.trim();
  if (!code) { showError('Please enter the code from your email.'); return; }
  const btn = document.getElementById('verifyCodeBtn');
  btn.disabled = true;
  try {
    const owner = await api('/api/owner-auth/verify-code', { method: 'POST', body: JSON.stringify({ email: codeLoginEmail, code }) });
    await enterPortal(owner);
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('verifyCodeBtn').addEventListener('click', verifyLoginCode);
document.getElementById('codeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') verifyLoginCode();
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/owner-auth/logout', { method: 'POST' });
  checkSession();
});

// ---- Newsletter opt in/out ----
document.getElementById('newsletterToggle').addEventListener('change', async (e) => {
  const statusEl = document.getElementById('newsletterToggleStatus');
  const subscribed = e.target.checked;
  e.target.disabled = true;
  try {
    await api('/api/owner/newsletter-subscription', { method: 'PUT', body: JSON.stringify({ subscribed }) });
    statusEl.textContent = subscribed ? 'Saved — you\'re on the list.' : "Saved — you're unsubscribed.";
  } catch (err) {
    e.target.checked = !subscribed;
    statusEl.textContent = 'Could not save that — please try again.';
  } finally {
    e.target.disabled = false;
  }
});

// ---- Owner self-service: add a property ----
document.getElementById('showAddPropertyBtn').addEventListener('click', () => {
  document.getElementById('addPropertyRow').classList.add('hidden');
  document.getElementById('addPropertyForm').classList.remove('hidden');
});

document.getElementById('cancelAddPropertyBtn').addEventListener('click', () => {
  document.getElementById('addPropertyForm').classList.add('hidden');
  document.getElementById('addPropertyRow').classList.remove('hidden');
  document.getElementById('addPropertyError').classList.add('hidden');
});

document.getElementById('saveNewPropertyBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('addPropertyError');
  errEl.classList.add('hidden');
  const name = document.getElementById('apName').value.trim();
  const address = document.getElementById('apAddress').value.trim();
  const type = document.getElementById('apType').value;
  if (!name) {
    errEl.textContent = 'Please enter a property name.';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = document.getElementById('saveNewPropertyBtn');
  btn.disabled = true;
  try {
    await api('/api/owner/properties', { method: 'POST', body: JSON.stringify({ name, address, type }) });
    document.getElementById('apName').value = '';
    document.getElementById('apAddress').value = '';
    document.getElementById('apType').value = 'residential';
    await checkSession();
  } catch (e) {
    errEl.textContent = e.message || 'Could not save that property.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

checkSession();
