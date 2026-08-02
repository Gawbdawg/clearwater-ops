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
// Set right before a checkSession()/showDash() refresh triggered by adding or editing a
// property, so the dashboard re-selects THAT property afterward instead of always
// falling back to properties[0] — see showDash below. Without this, adding a second
// property (or editing an existing one to type:'vacation') silently left whichever
// property was already selected in place, so the Booking calendar tab (and the iCal
// field on it) never appeared for the property the owner actually just changed.
let pendingSelectPropertyId = null;

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

  if (pendingSelectPropertyId && properties.some((p) => p.id === pendingSelectPropertyId)) {
    selectedPropertyId = pendingSelectPropertyId;
  } else if (!properties.some((p) => p.id === selectedPropertyId)) {
    selectedPropertyId = properties[0].id;
  }
  pendingSelectPropertyId = null;
  const switcherSelect = document.getElementById('propertySelect');
  if (switcherSelect) switcherSelect.value = String(selectedPropertyId);
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
    const now = new Date();
    bookingCalMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    loadBookings();
  }
  renderPropertyDetails(p);
  const reqSelect = document.getElementById('requestPropertySelect');
  if (reqSelect) reqSelect.value = String(selectedPropertyId);
  loadServiceSetup();
  loadOwnerCalendar();
}

// ---- Edit property (name/address/type) ----
// The type field matters beyond labeling: the Booking calendar tab (and the iCal link
// field on it — see saveIcalBtn below) only shows up for type:'vacation' properties, so
// this is also how an owner switches a property to vacation after the fact if they added
// it as residential (or the reverse).
function renderPropertyDetails(p) {
  document.getElementById('propertyDetailsName').textContent = p.name;
  document.getElementById('propertyDetailsMeta').textContent =
    `${p.type === 'vacation' ? 'Vacation rental' : 'Residential'}${p.address ? ' · ' + p.address : ''}`;
  document.getElementById('editPropertyForm').classList.add('hidden');
  document.getElementById('propertyDetailsView').classList.remove('hidden');
  document.getElementById('editPropertyError').classList.add('hidden');
}

document.getElementById('editPropertyBtn').addEventListener('click', () => {
  const p = selectedProperty();
  document.getElementById('epName').value = p.name || '';
  document.getElementById('epAddress').value = p.address || '';
  document.getElementById('epType').value = p.type === 'vacation' ? 'vacation' : 'residential';
  document.getElementById('editPropertyError').classList.add('hidden');
  document.getElementById('propertyDetailsView').classList.add('hidden');
  document.getElementById('editPropertyForm').classList.remove('hidden');
});

document.getElementById('cancelEditPropertyBtn').addEventListener('click', () => {
  renderPropertyDetails(selectedProperty());
});

document.getElementById('saveEditPropertyBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('editPropertyError');
  errEl.classList.add('hidden');
  const name = document.getElementById('epName').value.trim();
  if (!name) {
    errEl.textContent = 'Please enter a property name.';
    errEl.classList.remove('hidden');
    return;
  }
  const address = document.getElementById('epAddress').value.trim();
  const type = document.getElementById('epType').value;
  const btn = document.getElementById('saveEditPropertyBtn');
  btn.disabled = true;
  try {
    await api(`/api/owner/properties/${selectedPropertyId}`, { method: 'PUT', body: JSON.stringify({ name, address, type }) });
    pendingSelectPropertyId = selectedPropertyId;
    await checkSession();
  } catch (e) {
    errEl.textContent = e.message || 'Could not save that property.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// ---- Set up regular service (frequency + price + start date) ----
let serviceSetupData = null;

const FREQUENCY_LABELS = { weekly: 'Weekly', biweekly: 'Every 2 weeks', every4weeks: 'Every 4 weeks' };

async function loadServiceSetup() {
  const card = document.getElementById('serviceSetupCard');
  editingServiceFrequency = false;
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

let editingServiceFrequency = false;

function renderServiceSetup() {
  const d = serviceSetupData;
  const content = document.getElementById('serviceSetupContent');
  const priceFor = (freq) => (d.isCustom ? Number(d.customPrice) : Number(d[freq]));

  if (d.currentFrequency && !editingServiceFrequency) {
    const priceLine = d.isCustom
      ? `$${Number(d.customPrice).toFixed(2)} per service`
      : `$${Number(d[d.currentFrequency]).toFixed(2)} per service`;
    content.innerHTML = `
      <h2 style="margin:0 0 4px; font-size:16px;">Your regular service</h2>
      <p class="portal-sub" style="margin:0;">${FREQUENCY_LABELS[d.currentFrequency] || d.currentFrequency} — ${priceLine}</p>
      <button class="btn small" id="ssEditBtn" style="margin-top:8px;">Change frequency</button>
    `;
    document.getElementById('ssEditBtn').addEventListener('click', () => {
      editingServiceFrequency = true;
      renderServiceSetup();
    });
    return;
  }

  const isEdit = !!d.currentFrequency;
  content.innerHTML = `
    <h2 style="margin:0 0 4px; font-size:16px;">${isEdit ? 'Change your regular service' : 'Set up your regular service'}</h2>
    <p class="portal-sub" style="margin:0 0 12px;">${isEdit
      ? "Picking a new frequency and start date replaces any upcoming visits that haven't happened yet with the new schedule. Anything already completed stays on your history untouched."
      : "Pick how often you'd like service and when to start — we'll put the services right on the calendar."}</p>
    <div id="ssError" class="portal-error hidden"></div>
    <label>Frequency
      <select id="ssFrequency">
        <option value="weekly" ${d.currentFrequency === 'weekly' ? 'selected' : ''}>Weekly — $${priceFor('weekly').toFixed(2)}/service</option>
        <option value="biweekly" ${d.currentFrequency === 'biweekly' ? 'selected' : ''}>Every 2 weeks — $${priceFor('biweekly').toFixed(2)}/service</option>
        <option value="every4weeks" ${d.currentFrequency === 'every4weeks' ? 'selected' : ''}>Every 4 weeks — $${priceFor('every4weeks').toFixed(2)}/service</option>
      </select>
    </label>
    <label>Start date<input type="date" id="ssStartDate" value="${todayStr()}" /></label>
    <div style="display:flex; gap:8px;">
      <button class="btn primary" id="ssSubmitBtn">${isEdit ? 'Save new schedule' : 'Set up service'}</button>
      ${isEdit ? '<button class="btn small" id="ssCancelEditBtn">Never mind</button>' : ''}
    </div>
  `;
  document.getElementById('ssSubmitBtn').addEventListener('click', saveServiceSetup);
  if (isEdit) {
    document.getElementById('ssCancelEditBtn').addEventListener('click', () => {
      editingServiceFrequency = false;
      renderServiceSetup();
    });
  }
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
  const isEdit = editingServiceFrequency;
  const btn = document.getElementById('ssSubmitBtn');
  btn.disabled = true;
  try {
    if (isEdit) {
      await api(`/api/owner/properties/${selectedPropertyId}/service-frequency`, {
        method: 'PUT',
        body: JSON.stringify({ frequency, startDate }),
      });
    } else {
      await api(`/api/owner/properties/${selectedPropertyId}/schedule-service`, {
        method: 'POST',
        body: JSON.stringify({ frequency, startDate }),
      });
    }
    editingServiceFrequency = false;
    await loadServiceSetup();
    loadVisits();
    loadOverview();
    loadOwnerCalendar();
  } catch (e) {
    errEl.textContent = e.message || 'Could not save your schedule.';
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
  currentBookings = bookings;
  renderBookingGanttGrid();
  const el = document.getElementById('bookingsList');
  if (bookings.length === 0) {
    el.innerHTML = '<div class="empty-state">No guest dates added yet.</div>';
    return;
  }
  el.innerHTML = bookings.map((b) => `
    <div class="owner-list-item" id="booking-row-${b.id}">
      <div>
        <strong>${niceDate(b.startDate)} – ${niceDate(b.endDate)}</strong>
        ${b.source === 'ical' ? '<span class="badge sent">Auto-synced</span>' : '<span class="badge completed">Manual</span>'}
        ${b.notes ? `<div class="job-meta">${b.notes}</div>` : ''}
      </div>
      <button class="btn small danger" onclick="deleteBooking(${b.id})">Remove</button>
    </div>
  `).join('');
}

// ---- Booking calendar (Gantt-style month grid — continuous bars from check-in to
// check-out, so occupancy/turnover reads at a glance instead of as a flat date list) ----
let bookingCalMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let currentBookings = [];

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr + 'T00:00:00') - new Date(fromStr + 'T00:00:00')) / 86400000);
}

// Each distinct stay gets its own color (picked deterministically from the booking's
// id, so the same stay is always the same color across every week row it spans and
// across re-renders) instead of coloring by sync source — makes back-to-back or
// overlapping stays easy to tell apart at a glance.
const GANTT_COLORS = ['#0b5f7a', '#2f9e44', '#c98a00', '#8e44ad', '#c0392b', '#1f6feb', '#0e7c86', '#b5651d'];
function bookingColor(id) {
  const n = Math.abs(Number(id)) || 0;
  return GANTT_COLORS[n % GANTT_COLORS.length];
}

function renderBookingGanttGrid() {
  const year = bookingCalMonth.getFullYear();
  const month = bookingCalMonth.getMonth();
  document.getElementById('bookingCalMonthLabel').textContent =
    bookingCalMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const gridStart = new Date(year, month, 1 - firstDayOfWeek);
  const numWeeks = Math.ceil((firstDayOfWeek + daysInMonth) / 7);
  const today = todayStr();
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let bodyHtml = '';
  for (let w = 0; w < numWeeks; w++) {
    const weekDates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + w * 7 + i);
      weekDates.push(d);
    }
    const weekStartStr = fmtDate(weekDates[0]);
    const weekEndStr = fmtDate(weekDates[6]);

    // Bookings that touch this week — clipped to the week's date range, so a long
    // stay becomes one bar segment per row instead of one bar that would have to
    // visually cross a line-wrap (which CSS can't do for us here).
    const segs = currentBookings
      .filter((b) => b.startDate <= weekEndStr && b.endDate >= weekStartStr)
      .map((b) => {
        const segStart = b.startDate < weekStartStr ? weekStartStr : b.startDate;
        const segEnd = b.endDate > weekEndStr ? weekEndStr : b.endDate;
        return {
          booking: b,
          startCol: daysBetween(weekStartStr, segStart),
          endCol: daysBetween(weekStartStr, segEnd),
          isActualStart: segStart === b.startDate,
          isActualEnd: segEnd === b.endDate,
        };
      })
      .sort((a, b2) => a.startCol - b2.startCol || a.endCol - b2.endCol);

    // Greedy interval-graph lane assignment so overlapping bookings (e.g. a
    // same-day turnover) stack instead of colliding.
    const laneEndCol = [];
    segs.forEach((seg) => {
      let lane = laneEndCol.findIndex((endCol) => endCol < seg.startCol);
      if (lane === -1) { lane = laneEndCol.length; laneEndCol.push(seg.endCol); }
      else { laneEndCol[lane] = seg.endCol; }
      seg.lane = lane;
    });

    const barTopBase = 34;
    const laneHeight = 22;
    const rowMinHeight = Math.max(50, barTopBase + laneEndCol.length * laneHeight + 6);

    const dayCellsHtml = weekDates.map((d) => {
      const dateStr = fmtDate(d);
      const inMonth = d.getMonth() === month;
      return `<div class="gantt-daycell ${inMonth ? '' : 'other-month'}" style="min-height:${rowMinHeight}px;">
        <span class="gantt-daynum ${dateStr === today ? 'is-today' : ''}">${d.getDate()}</span>
      </div>`;
    }).join('');

    const barsHtml = segs.map((seg) => {
      const b = seg.booking;
      const label = b.notes ? b.notes : 'Booked';
      const left = (seg.startCol / 7) * 100;
      const width = ((seg.endCol - seg.startCol + 1) / 7) * 100;
      const top = barTopBase + seg.lane * laneHeight;
      const roundClass = `${seg.isActualStart ? 'round-start' : ''} ${seg.isActualEnd ? 'round-end' : ''}`;
      const manualClass = b.source === 'ical' ? '' : 'gantt-bar-manual';
      const bg = bookingColor(b.id);
      const title = `${label} — ${niceDate(b.startDate)} to ${niceDate(b.endDate)}`.replace(/"/g, '&quot;');
      return `<div class="gantt-bar ${manualClass} ${roundClass}" style="left:${left}%; width:${width}%; top:${top}px; background:${bg};" title="${title}" onclick="highlightBookingRow(${b.id})">
        <span class="gantt-bar-label">${label.replace(/</g, '&lt;')}</span>
      </div>`;
    }).join('');

    bodyHtml += `<div class="gantt-week" style="min-height:${rowMinHeight}px;">${dayCellsHtml}${barsHtml}</div>`;
  }

  const labelsHtml = dayLabels.map((d) => `<div class="cal-daylabel">${d}</div>`).join('');
  document.getElementById('bookingGanttCal').innerHTML =
    `<div class="gantt-daylabels">${labelsHtml}</div><div class="gantt-cal-body">${bodyHtml}</div>`;
}

window.highlightBookingRow = (id) => {
  const row = document.getElementById('booking-row-' + id);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('flash-highlight');
  setTimeout(() => row.classList.remove('flash-highlight'), 1200);
};

document.getElementById('bookingCalPrevBtn').addEventListener('click', () => {
  bookingCalMonth = new Date(bookingCalMonth.getFullYear(), bookingCalMonth.getMonth() - 1, 1);
  renderBookingGanttGrid();
});
document.getElementById('bookingCalNextBtn').addEventListener('click', () => {
  bookingCalMonth = new Date(bookingCalMonth.getFullYear(), bookingCalMonth.getMonth() + 1, 1);
  renderBookingGanttGrid();
});
document.getElementById('bookingCalTodayBtn').addEventListener('click', () => {
  const d = new Date();
  bookingCalMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  renderBookingGanttGrid();
});

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

// ---- Service calendar (month grid of scheduled/completed visits and pending
// requests, filterable by property or "All properties" — click an open day to
// request service directly, instead of typing a date into a plain field) ----
let svcCalMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let svcCalAppts = [];
let svcCalRequests = [];
let svcCalPropertyId = 'all';
let svcCalSelectedDate = null;
let svcCalRequestAddonIds = new Set();
let svcCalRequestPropertyId = null;

function svcCalPropertyName(propertyId) {
  const p = properties.find((x) => x.id === propertyId);
  return p ? p.name : '';
}

async function loadOwnerCalendar() {
  const filterRow = document.getElementById('svcCalPropertyFilterRow');
  const filterSelect = document.getElementById('svcCalPropertyFilter');
  filterRow.classList.toggle('hidden', properties.length <= 1);
  if (properties.length > 1) {
    const prevValue = filterSelect.value || 'all';
    filterSelect.innerHTML = '<option value="all">All properties</option>'
      + properties.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    filterSelect.value = [...filterSelect.options].some((o) => o.value === prevValue) ? prevValue : 'all';
    svcCalPropertyId = filterSelect.value === 'all' ? 'all' : Number(filterSelect.value);
  } else {
    svcCalPropertyId = 'all';
  }

  const [appts, requests] = await Promise.all([
    api('/api/owner/appointments?all=1'),
    api('/api/owner/service-requests'),
  ]);
  svcCalAppts = svcCalPropertyId === 'all' ? appts : appts.filter((a) => a.propertyId === svcCalPropertyId);
  svcCalRequests = (svcCalPropertyId === 'all' ? requests : requests.filter((r) => r.customerId === svcCalPropertyId))
    .filter((r) => r.status === 'pending');
  svcCalSelectedDate = null;
  document.getElementById('svcCalDayPanel').classList.add('hidden');
  renderOwnerCalendarGrid();
}

function renderOwnerCalendarGrid() {
  const year = svcCalMonth.getFullYear();
  const month = svcCalMonth.getMonth();
  document.getElementById('svcCalMonthLabel').textContent =
    svcCalMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const gridStart = new Date(year, month, 1 - firstDayOfWeek);

  const showPropertyLabel = svcCalPropertyId === 'all' && properties.length > 1;
  const apptsByDate = {};
  svcCalAppts.forEach((a) => { (apptsByDate[a.date] = apptsByDate[a.date] || []).push(a); });
  const requestsByDate = {};
  svcCalRequests.forEach((r) => { (requestsByDate[r.requestedDate] = requestsByDate[r.requestedDate] || []).push(r); });

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = todayStr();
  let html = dayLabels.map((d) => `<div class="cal-daylabel">${d}</div>`).join('');

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const y = cellDate.getFullYear();
    const m = String(cellDate.getMonth() + 1).padStart(2, '0');
    const d = String(cellDate.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;
    const inMonth = cellDate.getMonth() === month;
    const dayAppts = apptsByDate[dateStr] || [];
    const dayRequests = requestsByDate[dateStr] || [];
    const apptChips = dayAppts.slice(0, 2).map((a) =>
      `<div class="cal-appt-chip ${a.status}">${a.serviceType || 'Service'}${showPropertyLabel ? ' · ' + a.propertyName : ''}</div>`
    ).join('');
    const requestChips = dayAppts.length === 0 ? dayRequests.slice(0, 2).map((r) =>
      `<div class="cal-appt-chip" style="background:#fdf3e0; color:#8a5b00; border-left-color:#c98a00;">Requested${showPropertyLabel ? ' · ' + svcCalPropertyName(r.customerId) : ''}</div>`
    ).join('') : '';
    const isSelected = svcCalSelectedDate === dateStr;
    html += `
      <div class="cal-cell ${inMonth ? '' : 'other-month'} ${dateStr === today ? 'is-today' : ''}" style="${isSelected ? 'background:#e3f1fb; border-color:#0b5f7a;' : ''}" onclick="onSvcCalDayClick('${dateStr}')">
        <div class="cal-daynum">${cellDate.getDate()}</div>
        ${apptChips}${requestChips}
      </div>
    `;
    if (i >= firstDayOfWeek + daysInMonth - 1 && (i + 1) % 7 === 0) break;
  }
  document.getElementById('svcCalGrid').innerHTML = html;
}

document.getElementById('svcCalPropertyFilter').addEventListener('change', (e) => {
  svcCalPropertyId = e.target.value === 'all' ? 'all' : Number(e.target.value);
  loadOwnerCalendar();
});

window.onSvcCalDayClick = (dateStr) => {
  svcCalSelectedDate = dateStr;
  renderOwnerCalendarGrid();
  const panel = document.getElementById('svcCalDayPanel');
  panel.classList.remove('hidden');
  if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const showPropertyLabel = svcCalPropertyId === 'all' && properties.length > 1;
  const dayAppts = svcCalAppts.filter((a) => a.date === dateStr);
  const dayRequests = svcCalRequests.filter((r) => r.requestedDate === dateStr);
  const isPast = dateStr < todayStr();

  // Existing visits/requests on this day (if any) are always shown first — but unlike
  // before, having something already on the calendar no longer blocks requesting more.
  // An owner with two properties (or a repeat/extra visit at one property) needs to be
  // able to add a second request on a day that already has a scheduled job.
  let existingHtml = '';
  if (dayAppts.length) {
    existingHtml += dayAppts.map((a) => `
      <div style="margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
          <strong>${niceDate(a.date)}</strong>
          <span class="badge ${a.status}">${a.status}</span>
        </div>
        ${showPropertyLabel ? `<div class="job-meta">${a.propertyName}</div>` : ''}
        ${a.serviceType ? `<div class="job-meta">${a.serviceType}</div>` : ''}
        ${a.addons && a.addons.length ? `<div class="job-meta">Extras: ${a.addons.map((x) => x.name).join(', ')}</div>` : ''}
        ${a.status === 'scheduled' ? `<button class="btn small danger" style="margin-top:6px;" onclick="cancelVisit(${a.id}, '${a.date}', '${a.startTime || ''}')">Cancel service</button>` : ''}
      </div>
    `).join('');
  }
  if (dayRequests.length) {
    existingHtml += dayRequests.map((r) => `
      <div style="margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
          <strong>${niceDate(r.requestedDate)}</strong>
          <span class="badge draft">Requested — pending confirmation</span>
        </div>
        ${showPropertyLabel ? `<div class="job-meta">${svcCalPropertyName(r.customerId)}</div>` : ''}
        ${r.notes ? `<div class="job-meta">${r.notes}</div>` : ''}
        <button class="btn small danger" style="margin-top:6px;" onclick="cancelSvcCalRequest(${r.id})">Cancel request</button>
      </div>
    `).join('');
  }

  if (isPast) {
    panel.innerHTML = existingHtml || `<div class="portal-hint" style="margin:0;">${niceDate(dateStr)} has already passed.</div>`;
    return;
  }

  svcCalRequestAddonIds = new Set();
  svcCalRequestPropertyId = svcCalPropertyId === 'all' ? properties[0].id : svcCalPropertyId;

  if (existingHtml) {
    panel.innerHTML = `
      ${existingHtml}
      <button class="btn small" id="svcCalShowRequestFormBtn" style="margin-top:4px;">+ Request another service this day</button>
    `;
    document.getElementById('svcCalShowRequestFormBtn').addEventListener('click', () => renderSvcCalRequestPanel(dateStr));
    return;
  }

  renderSvcCalRequestPanel(dateStr);
};

window.cancelSvcCalRequest = async (requestId) => {
  await deleteRequest(requestId);
  document.getElementById('svcCalDayPanel').classList.add('hidden');
  svcCalSelectedDate = null;
  loadOwnerCalendar();
};

function renderSvcCalRequestPanel(dateStr) {
  const panel = document.getElementById('svcCalDayPanel');
  const propertyPickerHtml = (svcCalPropertyId === 'all' && properties.length > 1) ? `
    <label>Property
      <select id="svcCalRequestPropertySelect">
        ${properties.map((p) => `<option value="${p.id}" ${p.id === svcCalRequestPropertyId ? 'selected' : ''}>${p.name}</option>`).join('')}
      </select>
    </label>
  ` : '';
  const addonsHtml = addonsCatalog.length ? `
    <div class="job-addon-chips" style="margin:6px 0;">
      ${addonsCatalog.map((a) => `
        <button type="button" class="addon-chip ${svcCalRequestAddonIds.has(a.id) ? 'added' : ''}" onclick="toggleSvcCalRequestAddon(${a.id})">
          ${svcCalRequestAddonIds.has(a.id) ? '✓ ' : '+ '}${a.name} ($${Number(a.price).toFixed(2)})
        </button>
      `).join('')}
    </div>
  ` : '';
  panel.innerHTML = `
    <h3 style="margin:0 0 4px; font-size:15px;">Request service for ${niceDate(dateStr)}</h3>
    ${propertyPickerHtml}
    <label>Notes <span style="font-weight:400; color:#7a8f97;">(optional)</span><input type="text" id="svcCalRequestNotes" placeholder="e.g. extra clean, repair" /></label>
    ${addonsHtml}
    <div id="svcCalRequestError" class="portal-error hidden"></div>
    <div style="display:flex; gap:8px; margin-top:6px;">
      <button class="btn primary" id="svcCalSubmitRequestBtn">Request this day</button>
      <button class="btn small" id="svcCalCancelRequestFormBtn">Never mind</button>
    </div>
  `;
  const propSelect = document.getElementById('svcCalRequestPropertySelect');
  if (propSelect) propSelect.addEventListener('change', () => { svcCalRequestPropertyId = Number(propSelect.value); });
  document.getElementById('svcCalCancelRequestFormBtn').addEventListener('click', () => {
    document.getElementById('svcCalDayPanel').classList.add('hidden');
    svcCalSelectedDate = null;
    renderOwnerCalendarGrid();
  });
  document.getElementById('svcCalSubmitRequestBtn').addEventListener('click', async () => {
    const btn = document.getElementById('svcCalSubmitRequestBtn');
    btn.disabled = true;
    try {
      const notes = document.getElementById('svcCalRequestNotes').value;
      await api('/api/owner/service-requests', {
        method: 'POST',
        body: JSON.stringify({ propertyId: svcCalRequestPropertyId, requestedDate: dateStr, notes, addonIds: Array.from(svcCalRequestAddonIds) }),
      });
      document.getElementById('svcCalDayPanel').classList.add('hidden');
      svcCalSelectedDate = null;
      await loadOwnerCalendar();
      loadRequests();
    } catch (e) {
      const errEl = document.getElementById('svcCalRequestError');
      errEl.textContent = e.message || 'Could not submit request.';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
}

window.toggleSvcCalRequestAddon = (addonId) => {
  if (svcCalRequestAddonIds.has(addonId)) svcCalRequestAddonIds.delete(addonId);
  else svcCalRequestAddonIds.add(addonId);
  renderSvcCalRequestPanel(svcCalSelectedDate);
};

document.getElementById('svcCalPrevBtn').addEventListener('click', () => {
  svcCalMonth = new Date(svcCalMonth.getFullYear(), svcCalMonth.getMonth() - 1, 1);
  renderOwnerCalendarGrid();
});
document.getElementById('svcCalNextBtn').addEventListener('click', () => {
  svcCalMonth = new Date(svcCalMonth.getFullYear(), svcCalMonth.getMonth() + 1, 1);
  renderOwnerCalendarGrid();
});
document.getElementById('svcCalTodayBtn').addEventListener('click', () => {
  const d = new Date();
  svcCalMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  renderOwnerCalendarGrid();
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
    const created = await api('/api/owner/properties', { method: 'POST', body: JSON.stringify({ name, address, type }) });
    document.getElementById('apName').value = '';
    document.getElementById('apAddress').value = '';
    document.getElementById('apType').value = 'residential';
    // Select the property just created (rather than always defaulting to properties[0])
    // so a newly-added vacation property's Booking calendar tab — and the iCal field on
    // it — shows up immediately, with no extra manual switch required.
    pendingSelectPropertyId = created.id;
    await checkSession();
  } catch (e) {
    errEl.textContent = e.message || 'Could not save that property.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

checkSession();
