// Simple file-based JSON data store — no native dependencies, works anywhere Node runs.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SEED_CUSTOMERS_FILE = path.join(DATA_DIR, 'seed-customers.json');

const COLLECTIONS = ['customers', 'owners', 'technicians', 'appointments', 'invoices', 'bookings', 'serviceRequests', 'admins'];

function buildDefaultData() {
  const data = {
    customers: [],
    owners: [],
    technicians: [],
    appointments: [],
    invoices: [],
    bookings: [],
    serviceRequests: [],
    admins: [],
    settings: {
      depotAddress: '1027 SW 62nd Street, Lincoln City, OR',
      depotLat: null,
      depotLng: null,
    },
    nextId: { customers: 1, owners: 1, technicians: 1, appointments: 1, invoices: 1, bookings: 1, serviceRequests: 1, admins: 1 },
  };

  // On a brand-new data file, pre-load the customer roster from data/seed-customers.json
  // if one exists. This also means that on hosts without persistent disk (e.g. Render's
  // free tier), the customer list will always come back after a restart even though
  // appointments/invoices added since won't — see README for upgrading to a paid plan
  // with a disk for full persistence.
  if (fs.existsSync(SEED_CUSTOMERS_FILE)) {
    try {
      const seed = JSON.parse(fs.readFileSync(SEED_CUSTOMERS_FILE, 'utf-8'));
      let id = 1;
      data.customers = seed.map((c) => ({
        id: id++,
        name: c.name || '',
        email: c.email || '',
        phone: c.phone || '',
        address: c.address || '',
        type: c.type || 'residential',
        notes: c.notes || '',
        createdAt: new Date().toISOString(),
      }));
      data.nextId.customers = id;
    } catch (e) {
      // ignore malformed seed file, fall back to empty customer list
    }
  }

  return data;
}

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(buildDefaultData(), null, 2));
  }
}

// Fill in any collections/nextId counters missing from an older data.json
// (e.g. one written before bookings/serviceRequests existed) so reads/writes never crash.
function migrate(data) {
  if (!data.nextId) data.nextId = {};
  COLLECTIONS.forEach((c) => {
    if (!Array.isArray(data[c])) data[c] = [];
    if (typeof data.nextId[c] !== 'number') {
      data.nextId[c] = data[c].reduce((max, item) => Math.max(max, item.id || 0), 0) + 1;
    }
  });
  if (!data.settings || typeof data.settings !== 'object') {
    data.settings = { depotAddress: '1027 SW 62nd Street, Lincoln City, OR', depotLat: null, depotLng: null };
  }
  return data;
}

function getSettings() {
  return readData().settings;
}

function updateSettings(updates) {
  const data = readData();
  data.settings = { ...data.settings, ...updates };
  writeData(data);
  return data.settings;
}

function readData() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  try {
    return migrate(JSON.parse(raw));
  } catch (e) {
    return buildDefaultData();
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function nextId(collection) {
  const data = readData();
  const id = data.nextId[collection] || 1;
  data.nextId[collection] = id + 1;
  writeData(data);
  return id;
}

// Generic CRUD helpers
function getAll(collection) {
  return readData()[collection] || [];
}

function getById(collection, id) {
  return getAll(collection).find((item) => item.id === Number(id));
}

function create(collection, item) {
  const data = readData();
  const id = data.nextId[collection] || 1;
  data.nextId[collection] = id + 1;
  const newItem = { id, ...item, createdAt: new Date().toISOString() };
  data[collection].push(newItem);
  writeData(data);
  return newItem;
}

function update(collection, id, updates) {
  const data = readData();
  const idx = data[collection].findIndex((item) => item.id === Number(id));
  if (idx === -1) return null;
  data[collection][idx] = {
    ...data[collection][idx],
    ...updates,
    id: Number(id),
    updatedAt: new Date().toISOString(),
  };
  writeData(data);
  return data[collection][idx];
}

function remove(collection, id) {
  const data = readData();
  const before = data[collection].length;
  data[collection] = data[collection].filter((item) => item.id !== Number(id));
  writeData(data);
  return data[collection].length < before;
}

module.exports = { readData, writeData, getAll, getById, create, update, remove, nextId, getSettings, updateSettings };
