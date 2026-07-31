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
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');

let properties = [];
let selectedPropertyId = null;

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
    await showDash(owner);
  } catch (e) {
    loginView.classList.remove('hidden');
    dashView.classList.add('hidden');
    logoutBtn.style.display = 'none';
  }
}

async function showDash(owner) {
  loginView.classList.add('hidden');
  dashView.classList.remove('hidden');
  logoutBtn.style.display = '';
  document.getElementById('welcomeMsg').textContent = `Hi ${owner.name}`;

  properties = await api('/api/owner/properties');

  if (properties.length === 0) {
    document.getElementById('introText').textContent =
      "No properties are linked to your account yet — contact Clear Water Spa Service to get set up.";
    document.getElementById('propertySwitcherRow').classList.add('hidden');
    document.getElementById('bookingSection').style.display = 'none';
    document.getElementById('requestPropertyRow').classList.add('hidden');
    document.getElementById('requestsList').innerHTML = '';
    return;
  }

  document.getElementById('introText').textContent = 'Request a hot tub service date any time, or manage your guest booking dates below.';

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
  await loadRequests();
}

function onPropertyChange() {
  const p = selectedProperty();
  const isVacation = p.type === 'vacation';
  document.getElementById('bookingSection').style.display = isVacation ? '' : 'none';
  document.getElementById('bookingSectionPropertyName').textContent = properties.length > 1 ? `— ${p.name}` : '';
  if (isVacation) {
    document.getElementById('icalUrlInput').value = p.icalUrl || '';
    updateSyncStatus(p);
    loadBookings();
  }
  const reqSelect = document.getElementById('requestPropertySelect');
  if (reqSelect) reqSelect.value = String(selectedPropertyId);
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
      </div>
      ${r.status === 'pending' ? `<button class="btn small danger" onclick="deleteRequest(${r.id})">Cancel</button>` : ''}
    </div>
  `).join('');
}

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
  await api('/api/owner/bookings', { method: 'POST', body: JSON.stringify({ propertyId: selectedPropertyId, startDate, endDate, notes }) });
  document.getElementById('bookingStart').value = '';
  document.getElementById('bookingEnd').value = '';
  document.getElementById('bookingNotes').value = '';
  loadBookings();
});

document.getElementById('addRequestBtn').addEventListener('click', async () => {
  const reqSelect = document.getElementById('requestPropertySelect');
  const propertyId = reqSelect && !reqSelect.closest('.hidden') ? Number(reqSelect.value) : selectedPropertyId;
  const requestedDate = document.getElementById('requestDate').value;
  const notes = document.getElementById('requestNotes').value;
  if (!requestedDate) { alert('Please pick a date.'); return; }
  await api('/api/owner/service-requests', { method: 'POST', body: JSON.stringify({ propertyId, requestedDate, notes }) });
  document.getElementById('requestDate').value = '';
  document.getElementById('requestNotes').value = '';
  loadRequests();
});

document.getElementById('loginBtn').addEventListener('click', async () => {
  loginError.classList.add('hidden');
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const owner = await api('/api/owner-auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    await showDash(owner);
  } catch (e) {
    showError(e.message);
  }
});

document.getElementById('loginPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/owner-auth/logout', { method: 'POST' });
  checkSession();
});

checkSession();
