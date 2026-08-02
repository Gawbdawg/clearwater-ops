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

async function showJobs(tech) {
  loginView.classList.add('hidden');
  jobsView.classList.remove('hidden');
  logoutBtn.style.display = '';
  document.getElementById('welcomeMsg').textContent = `Hi ${tech.name}`;
  try {
    addonsCatalog = await api('/api/tech/addons');
  } catch (e) {
    addonsCatalog = [];
  }
  await loadJobs();
}

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

checkSession();
