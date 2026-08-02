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
const jobsView = document.getElementById('jobsView');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

async function checkSession() {
  try {
    const tech = await api('/api/tech-auth/me');
    showJobs(tech);
  } catch (e) {
    loginView.classList.remove('hidden');
    jobsView.classList.add('hidden');
    logoutBtn.style.display = 'none';
  }
}

let addonsCatalog = [];
let currentTech = null;

async function showJobs(tech) {
  currentTech = tech;
  loginView.classList.add('hidden');
  jobsView.classList.remove('hidden');
  logoutBtn.style.display = '';
  document.getElementById('welcomeMsg').textContent = `Hi ${tech.name}`;
  document.getElementById('myEmailInput').value = tech.email || '';
  try {
    addonsCatalog = await api('/api/tech/addons');
  } catch (e) {
    addonsCatalog = [];
  }
  await loadJobs();
}

// ---- Tabs ----
let activeTechTab = 'jobs';

function switchTechTab(tab) {
  activeTechTab = tab;
  document.querySelectorAll('#techTabs .owner-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('#jobsView .owner-tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tab}`);
  });
  if (tab === 'calendar') loadTechCalendar();
  if (tab === 'timeoff') loadTimeOff();
}

document.getElementById('techTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.owner-tab-btn');
  if (btn) switchTechTab(btn.dataset.tab);
});

let selectedDate = null; // null = default "upcoming" view; a date string views just that day (past or future)

async function loadJobs() {
  const jobs = await api(selectedDate ? `/api/tech/appointments?date=${selectedDate}` : '/api/tech/appointments');
  document.getElementById('jobsBackToUpcomingBtn').style.display = selectedDate ? '' : 'none';
  const list = document.getElementById('jobsList');
  if (jobs.length === 0) {
    list.innerHTML = selectedDate
      ? '<div class="empty-state">No jobs on that day.</div>'
      : '<div class="empty-state">No upcoming jobs assigned to you.</div>';
    return;
  }
  list.innerHTML = jobs.map((j) => `
    <div class="job-card">
      <div class="job-top">
        <div>
          <div class="job-date">${niceDate(j.date)} · ${j.startTime}${j.endTime ? '–' + j.endTime : ''}</div>
          <div class="job-customer">${j.customerName}</div>
          <div class="job-meta">${j.serviceType}${j.customerAddress ? ' · ' + j.customerAddress : ''}</div>
          ${j.customerPhone ? `<div class="job-meta">${j.customerPhone}</div>` : ''}
          ${j.notes ? `<div class="job-meta">Note: ${j.notes}</div>` : ''}
          ${renderEquipmentMeta(j.customerEquipment)}
        </div>
        <span class="badge ${j.status}">${j.status}</span>
      </div>
      ${renderPhotos(j)}
      ${renderAddons(j)}
      <div class="job-actions">
        <button class="btn small" onclick="choosePhoto(${j.id}, 'after')">Add photo</button>
        ${j.status === 'scheduled' ? `<button class="btn small primary" onclick="markComplete(${j.id})">Mark complete</button>` : ''}
        ${j.status === 'completed' ? `<button class="btn small" onclick="markIncomplete(${j.id})">Undo — mark not complete</button>` : ''}
      </div>
    </div>
  `).join('');
}

function renderAddons(j) {
  const attached = j.addons || [];
  const attachedIds = attached.map((a) => a.id);
  const customAttached = attached.filter((a) => String(a.id).startsWith('custom-'));
  return `
    <div class="job-addons">
      <div class="job-meta" style="margin-bottom:4px;">Upcharges</div>
      <div class="job-addon-chips">
        ${addonsCatalog.map((a) => `
          <button class="addon-chip ${attachedIds.includes(a.id) ? 'added' : ''}" onclick="toggleAddon(${j.id}, ${a.id}, ${attachedIds.includes(a.id)})">
            ${attachedIds.includes(a.id) ? '✓ ' : '+ '}${a.name}
          </button>
        `).join('')}
        ${customAttached.map((a) => `
          <button class="addon-chip added" onclick="removeCustomAddon(${j.id}, '${a.id}')">
            ✓ ${a.name}
          </button>
        `).join('')}
        <button class="addon-chip" onclick="addCustomAddon(${j.id})">+ Other…</button>
      </div>
    </div>
  `;
}

window.toggleAddon = async (apptId, addonId, currentlyAttached) => {
  try {
    if (currentlyAttached) {
      await api(`/api/tech/appointments/${apptId}/addons/${addonId}`, { method: 'DELETE' });
    } else {
      await api(`/api/tech/appointments/${apptId}/addons`, { method: 'POST', body: JSON.stringify({ addonId }) });
    }
    await loadJobs();
  } catch (e) {
    alert(e.message || 'Could not update upcharge');
  }
};

window.addCustomAddon = async (apptId) => {
  const name = prompt('What was the upcharge for? (e.g. "Replaced filter")');
  if (!name) return;
  const priceStr = prompt(`How much for "${name}"?`, '10');
  if (!priceStr) return;
  const price = Number(priceStr);
  if (!price || price <= 0) { alert('Enter a price greater than $0.'); return; }
  try {
    await api(`/api/tech/appointments/${apptId}/addons/custom`, { method: 'POST', body: JSON.stringify({ name, price }) });
    await loadJobs();
  } catch (e) {
    alert(e.message || 'Could not add upcharge');
  }
};

window.removeCustomAddon = async (apptId, addonId) => {
  try {
    await api(`/api/tech/appointments/${apptId}/addons/${addonId}`, { method: 'DELETE' });
    await loadJobs();
  } catch (e) {
    alert(e.message || 'Could not remove upcharge');
  }
};

function renderEquipmentMeta(eq) {
  if (!eq || (!eq.brand && !eq.model && !eq.filterType)) return '';
  const parts = [];
  if (eq.brand || eq.model) parts.push([eq.brand, eq.model].filter(Boolean).join(' '));
  if (eq.filterType) parts.push('Filter: ' + eq.filterType);
  if (parts.length === 0) return '';
  return `<div class="job-meta">${parts.join(' · ')}</div>`;
}

function renderPhotos(j) {
  const photos = j.photos || [];
  if (photos.length === 0) return '';
  return `<div class="job-photos">
    ${photos.map((p) => `
      <div class="job-photo">
        <img src="${p.url}" alt="${p.type} photo" />
        <div class="job-photo-label">${p.type}</div>
        <button class="btn small" onclick="removePhoto(${j.id}, ${p.id})">Delete</button>
      </div>
    `).join('')}
  </div>`;
}

function niceDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

window.markComplete = async (id) => {
  try {
    await api(`/api/tech/appointments/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'completed' }) });
    loadJobs();
  } catch (e) {
    alert('Could not mark complete: ' + e.message);
  }
};

window.markIncomplete = async (id) => {
  try {
    await api(`/api/tech/appointments/${id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'scheduled' }) });
    loadJobs();
  } catch (e) {
    alert('Could not undo: ' + e.message);
  }
};

document.getElementById('jobsDateGoBtn').addEventListener('click', () => {
  const val = document.getElementById('jobsDatePicker').value;
  if (!val) return;
  selectedDate = val;
  loadJobs();
});

document.getElementById('jobsBackToUpcomingBtn').addEventListener('click', () => {
  selectedDate = null;
  document.getElementById('jobsDatePicker').value = '';
  loadJobs();
});

// ---- Email me my route ----
// Sends the same route-ordered stop list the admin can copy/paste from the Daily
// Schedule tab, but straight to the tech's own email — defaults to today, or whatever
// day is currently being viewed (via the date picker above). Email-only on purpose —
// the old "free carrier-gateway texting" fallback isn't reliable enough to keep around
// (AT&T shut theirs down in June 2025, T-Mobile's and Verizon's are in the same boat).
document.getElementById('textMyRouteBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('textMyRouteStatus');
  const btn = document.getElementById('textMyRouteBtn');
  const date = selectedDate || todayStr();
  btn.disabled = true;
  statusEl.textContent = 'Sending…';
  try {
    const result = await api('/api/tech/text-my-route', { method: 'POST', body: JSON.stringify({ date }) });
    statusEl.textContent = result.dryRun
      ? `Route for ${niceDate(date)} logged (email isn't set up yet — ask the admin).`
      : `Emailed! Check your inbox for ${niceDate(date)}'s route.`;
  } catch (e) {
    statusEl.textContent = '';
    alert('Could not email the route: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

// ---- Route email settings ----
document.getElementById('textingSettingsToggle').addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('textingSettings').classList.toggle('hidden');
});

document.getElementById('saveTextingSettingsBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('myTextingSettingsStatus');
  const btn = document.getElementById('saveTextingSettingsBtn');
  const email = document.getElementById('myEmailInput').value;
  btn.disabled = true;
  statusEl.textContent = 'Saving…';
  try {
    const updated = await api('/api/tech/me', { method: 'PUT', body: JSON.stringify({ email }) });
    currentTech = updated;
    statusEl.textContent = 'Saved.';
  } catch (e) {
    statusEl.textContent = '';
    alert('Could not save: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

// ---- Photo upload ----
const photoFileInput = document.getElementById('photoFileInput');
let photoTarget = null; // { apptId, type }

window.choosePhoto = (apptId, type) => {
  photoTarget = { apptId, type };
  photoFileInput.value = '';
  photoFileInput.click();
};

// Resizes the chosen image down to a max dimension before base64-encoding it,
// so uploads stay small over a slow connection out in the field.
function resizeImageToDataUrl(file, maxDimension = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected image'));
    reader.onload = () => {
      img.onerror = () => reject(new Error('Could not load the selected image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width >= height) {
            height = Math.round(height * (maxDimension / width));
            width = maxDimension;
          } else {
            width = Math.round(width * (maxDimension / height));
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

photoFileInput.addEventListener('change', async () => {
  const file = photoFileInput.files[0];
  if (!file || !photoTarget) return;
  const { apptId, type } = photoTarget;
  try {
    const dataUrl = await resizeImageToDataUrl(file);
    await api(`/api/tech/appointments/${apptId}/photos`, {
      method: 'POST',
      body: JSON.stringify({ type, dataUrl }),
    });
    await loadJobs();
  } catch (e) {
    alert(e.message || 'Photo upload failed');
  }
});

window.removePhoto = async (apptId, photoId) => {
  if (!confirm('Delete this photo?')) return;
  await api(`/api/tech/appointments/${apptId}/photos/${photoId}`, { method: 'DELETE' });
  loadJobs();
};

document.getElementById('loginBtn').addEventListener('click', async () => {
  loginError.classList.add('hidden');
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const tech = await api('/api/tech-auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    showJobs(tech);
  } catch (e) {
    showError(e.message);
  }
});

document.getElementById('loginPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

logoutBtn.addEventListener('click', async () => {
  await api('/api/tech-auth/logout', { method: 'POST' });
  checkSession();
});

// ---- Calendar (month grid of this tech's own jobs, plus their own blocked days) ----
let techCalMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let techCalAppts = [];
let techCalTimeOff = [];

async function loadTechCalendar() {
  const [appts, timeOff] = await Promise.all([
    api('/api/tech/appointments?all=1'),
    api('/api/tech/time-off'),
  ]);
  techCalAppts = appts;
  techCalTimeOff = timeOff;
  renderTechCalendarGrid();
}

function renderTechCalendarGrid() {
  const year = techCalMonth.getFullYear();
  const month = techCalMonth.getMonth();
  document.getElementById('techCalMonthLabel').textContent =
    techCalMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const gridStart = new Date(year, month, 1 - firstDayOfWeek);

  const apptsByDate = {};
  techCalAppts.forEach((a) => { (apptsByDate[a.date] = apptsByDate[a.date] || []).push(a); });
  const timeOffByDate = {};
  techCalTimeOff.forEach((t) => { timeOffByDate[t.date] = t; });

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = todayStr();
  let html = dayLabels.map((d) => `<div class="cal-daylabel">${d}</div>`).join('');

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const dateStr = fmtDate(cellDate);
    const inMonth = cellDate.getMonth() === month;
    const dayAppts = apptsByDate[dateStr] || [];
    const blocked = timeOffByDate[dateStr];
    const apptChips = dayAppts.slice(0, 3).map((a) =>
      `<div class="cal-appt-chip ${a.status}">${a.startTime} ${a.customerName}</div>`
    ).join('');
    const blockedChip = blocked ? '<div class="cal-appt-chip" style="background:repeating-linear-gradient(45deg,#eceff1,#eceff1 6px,#dde3e6 6px,#dde3e6 12px); color:#5a6b73; border-left-color:#8a99a1;">Blocked off</div>' : '';
    html += `
      <div class="cal-cell ${inMonth ? '' : 'other-month'} ${dateStr === today ? 'is-today' : ''}" onclick="onTechCalDayClick('${dateStr}')">
        <div class="cal-daynum">${cellDate.getDate()}</div>
        ${apptChips}${blockedChip}
      </div>
    `;
    if (i >= firstDayOfWeek + daysInMonth - 1 && (i + 1) % 7 === 0) break;
  }
  document.getElementById('techCalGrid').innerHTML = html;
}

window.onTechCalDayClick = (dateStr) => {
  const dayAppts = techCalAppts.filter((a) => a.date === dateStr);
  const blocked = techCalTimeOff.find((t) => t.date === dateStr);
  const panel = document.getElementById('techCalDayPanel');
  panel.classList.remove('hidden');

  let html = `<h3 style="margin:0 0 8px;">${niceDate(dateStr)}</h3>`;
  if (dayAppts.length === 0) {
    html += '<div class="empty-state">No jobs this day.</div>';
  } else {
    html += '<div class="day-detail-list">' + dayAppts.map((a) => `
      <div class="owner-list-item">
        <div>
          <strong>${a.startTime}${a.endTime ? '–' + a.endTime : ''}</strong> · ${a.customerName}
          <div class="job-meta">${a.serviceType || ''}</div>
        </div>
        <span class="badge ${a.status}">${a.status}</span>
      </div>
    `).join('') + '</div>';
  }
  if (blocked) {
    html += `<div class="portal-sub" style="margin-top:10px;">Blocked off${blocked.note ? ' — ' + blocked.note : ''}. <a href="#" onclick="deleteTimeOff(${blocked.id}); return false;">Remove block</a></div>`;
  }
  panel.innerHTML = html;
};

document.getElementById('techCalPrevBtn').addEventListener('click', () => {
  techCalMonth = new Date(techCalMonth.getFullYear(), techCalMonth.getMonth() - 1, 1);
  renderTechCalendarGrid();
});
document.getElementById('techCalNextBtn').addEventListener('click', () => {
  techCalMonth = new Date(techCalMonth.getFullYear(), techCalMonth.getMonth() + 1, 1);
  renderTechCalendarGrid();
});
document.getElementById('techCalTodayBtn').addEventListener('click', () => {
  const d = new Date();
  techCalMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  renderTechCalendarGrid();
});

// ---- Time off (self-service day blocking — takes effect immediately) ----
async function loadTimeOff() {
  const entries = await api('/api/tech/time-off');
  techCalTimeOff = entries;
  const today = todayStr();
  const upcoming = entries.filter((t) => t.date >= today);
  const past = entries.filter((t) => t.date < today);
  const el = document.getElementById('timeOffList');
  if (entries.length === 0) {
    el.innerHTML = '<div class="empty-state">No days blocked off.</div>';
    return;
  }
  const renderRow = (t) => `
    <div class="owner-list-item">
      <div>
        <strong>${niceDate(t.date)}</strong>
        ${t.note ? `<div class="job-meta">${t.note}</div>` : ''}
      </div>
      <button class="btn small danger" onclick="deleteTimeOff(${t.id})">Remove</button>
    </div>
  `;
  el.innerHTML = (upcoming.length ? upcoming.map(renderRow).join('') : '<div class="empty-state">No upcoming days blocked off.</div>')
    + (past.length ? `<div class="portal-sub" style="margin:14px 0 6px;">Past</div>${past.map(renderRow).join('')}` : '');
}

window.deleteTimeOff = async (id) => {
  await api(`/api/tech/time-off/${id}`, { method: 'DELETE' });
  await loadTimeOff();
  if (activeTechTab === 'calendar') loadTechCalendar();
};

document.getElementById('addTimeOffBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('timeOffError');
  errEl.classList.add('hidden');
  const startDate = document.getElementById('timeOffStart').value;
  const endDate = document.getElementById('timeOffEnd').value;
  const note = document.getElementById('timeOffNote').value;
  if (!startDate) {
    errEl.textContent = 'Pick at least a first day off.';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = document.getElementById('addTimeOffBtn');
  btn.disabled = true;
  try {
    await api('/api/tech/time-off', { method: 'POST', body: JSON.stringify({ startDate, endDate, note }) });
    document.getElementById('timeOffStart').value = '';
    document.getElementById('timeOffEnd').value = '';
    document.getElementById('timeOffNote').value = '';
    await loadTimeOff();
  } catch (e) {
    errEl.textContent = e.message || 'Could not block those days';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

checkSession();
