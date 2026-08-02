const express = require('express');
const store = require('../lib/store');
const { hashPassword, sanitizeCustomer } = require('../lib/auth');
const { geocodeAddress } = require('../lib/geocode');
const { makeCustomerMatcher } = require('../lib/customerMatch');
const router = express.Router();

// Creates a brand-new owner account and returns its id — used when an admin links
// a property to an owner that doesn't exist yet, all in one save.
function createOwnerAccount({ name, email, phone, username, password }) {
  if (username) {
    const existing = store.getAll('owners').find((o) => (o.username || '').toLowerCase() === username.toLowerCase());
    if (existing) throw new Error('That username is already taken');
  }
  const owner = store.create('owners', {
    name: name || '',
    email: email || '',
    phone: phone || '',
    username: username || '',
    passwordHash: password ? hashPassword(password) : '',
  });
  return owner.id;
}

function withOwnerName(customer) {
  const owner = customer.ownerId ? store.getById('owners', customer.ownerId) : null;
  return { ...sanitizeCustomer(customer), ownerName: owner ? owner.name : null };
}

router.get('/', (req, res) => {
  res.json(store.getAll('customers').map(withOwnerName));
});

// One-click recovery if the live customer list ever comes back empty (e.g. a hosting
// disk got reset) — restores the built-in backup roster. No-ops if customers already exist.
router.post('/restore-seed-backup', (req, res) => {
  const result = store.restoreSeedCustomersIfEmpty();
  res.json(result);
});

// Bulk-fills in phone/email for existing customers from pasted text — one line per
// customer in the form "Name: value, value" where each value is either a phone number
// or an email (detected automatically, order doesn't matter — "555-1234, a@b.com" and
// "a@b.com, 555-1234" both work). Only fills in blank fields; never overwrites a phone
// or email that's already on file, so it's safe to paste an updated/partial list later
// without clobbering anything entered by hand since. Names are matched the same
// conservative way as the bulk appointment import — anything ambiguous is skipped and
// reported back instead of guessed at.
router.post('/bulk-update-contact', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });

  const customers = store.getAll('customers');
  const findCustomer = makeCustomerMatcher(customers);
  const EMAIL_RE = /.+@.+\..+/;

  const updated = [];
  const unmatched = [];
  const skippedLines = [];

  text.split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { skippedLines.push(line); return; }
    const name = line.slice(0, colonIdx).trim();
    const values = line.slice(colonIdx + 1).split(',').map((v) => v.trim()).filter(Boolean);
    if (!name || values.length === 0) { skippedLines.push(line); return; }

    const customer = findCustomer(name);
    if (!customer) { unmatched.push({ name }); return; }

    let phone = '';
    let email = '';
    values.forEach((v) => {
      if (EMAIL_RE.test(v)) email = v;
      else if (!phone) phone = v;
    });

    const changes = {};
    if (phone && !customer.phone) changes.phone = phone;
    if (email && !customer.email) changes.email = email;

    if (Object.keys(changes).length === 0) {
      updated.push({ name, customerName: customer.name, changed: false });
      return;
    }
    store.update('customers', customer.id, changes);
    updated.push({ name, customerName: customer.name, changed: true, ...changes });
  });

  res.json({
    updatedCount: updated.filter((u) => u.changed).length,
    unchangedCount: updated.filter((u) => !u.changed).length,
    unmatchedCount: unmatched.length,
    updated,
    unmatched,
    skippedLines,
  });
});

router.get('/:id', (req, res) => {
  const customer = store.getById('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const technicians = store.getAll('technicians');
  const appointments = store.getAll('appointments')
    .filter((a) => a.customerId === customer.id)
    .map((a) => {
      const tech = a.technicianId ? technicians.find((t) => t.id === a.technicianId) : null;
      return { ...a, technicianName: tech ? tech.name : 'Unassigned' };
    })
    .sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime));
  const invoices = store.getAll('invoices')
    .filter((i) => i.customerId === customer.id)
    .sort((a, b) => (b.issuedDate || '').localeCompare(a.issuedDate || ''));
  res.json({ ...withOwnerName(customer), appointments, invoices });
});

// Geocodes an address without needing an existing customer record — used by the
// customer form to verify an address as it's typed, before the customer is even saved.
// Never throws a 500 for "address not found"; that's a normal, expected outcome the
// admin needs to see and act on (fix a typo, or save anyway if the address is real but
// just too new/rural for the geocoder), not a server error.
router.post('/verify-address', async (req, res) => {
  const { address } = req.body;
  if (!address || !address.trim()) return res.status(400).json({ error: 'No address given' });
  try {
    const { lat, lng, displayName } = await geocodeAddress(address);
    res.json({ found: true, lat, lng, displayName });
  } catch (err) {
    res.json({ found: false, error: err.message });
  }
});

// Best-effort geocode used right after a create/update — deliberately swallows failures
// (a typo'd or too-new/rural address shouldn't block saving the customer) and just
// reports back whether it worked, via the fields merged into `updates`.
async function tryGeocode(address, updates) {
  if (!address || !address.trim()) {
    updates.lat = null;
    updates.lng = null;
    updates.geocodedAddress = '';
    updates.addressVerified = false;
    return;
  }
  try {
    const { lat, lng, displayName } = await geocodeAddress(address);
    updates.lat = lat;
    updates.lng = lng;
    updates.geocodedAddress = displayName;
    updates.addressVerified = true;
  } catch (err) {
    updates.lat = null;
    updates.lng = null;
    updates.geocodedAddress = '';
    updates.addressVerified = false;
  }
}

router.post('/', async (req, res) => {
  const {
    name, email, phone, address, notes, type, icalUrl, ownerId, newOwner, equipment,
    serviceFrequency, customFrequencyDays,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  let resolvedOwnerId = ownerId ? Number(ownerId) : null;
  if (newOwner && newOwner.username) {
    try {
      resolvedOwnerId = createOwnerAccount(newOwner);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const geo = {};
  await tryGeocode(address, geo);

  const customer = store.create('customers', {
    name,
    email: email || '',
    phone: phone || '',
    address: address || '',
    type: type || 'residential',
    notes: notes || '',
    icalUrl: icalUrl || '',
    ownerId: resolvedOwnerId,
    equipment: equipment || null,
    serviceFrequency: serviceFrequency || null,
    customFrequencyDays: customFrequencyDays ? Number(customFrequencyDays) : null,
    ...geo,
  });
  res.status(201).json(withOwnerName(customer));
});

router.put('/:id', async (req, res) => {
  const updates = { ...req.body };
  const newOwner = updates.newOwner;
  delete updates.newOwner;

  if (newOwner && newOwner.username) {
    try {
      updates.ownerId = createOwnerAccount(newOwner);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  } else if (updates.ownerId !== undefined) {
    updates.ownerId = updates.ownerId ? Number(updates.ownerId) : null;
  }
  if (updates.customFrequencyDays !== undefined) {
    updates.customFrequencyDays = updates.customFrequencyDays ? Number(updates.customFrequencyDays) : null;
  }

  // Address changed — re-geocode right away instead of just clearing the cached
  // location, so a typo shows up immediately rather than waiting for the next
  // "Geocode all addresses" pass (or worse, a tech getting routed to the wrong place).
  const existing = store.getById('customers', req.params.id);
  if (existing && updates.address !== undefined && updates.address !== existing.address) {
    await tryGeocode(updates.address, updates);
  }

  const updated = store.update('customers', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Customer not found' });
  res.json(withOwnerName(updated));
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('customers', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Customer not found' });
  res.status(204).end();
});

// Geocode one property's address (used both individually and in a client-driven
// loop for "Geocode all addresses", which paces itself to respect Nominatim's
// 1-request/second usage policy rather than firing everything from the server at once).
router.post('/:id/geocode', async (req, res) => {
  const customer = store.getById('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!customer.address) return res.status(400).json({ error: 'No address on file' });
  try {
    const { lat, lng, displayName } = await geocodeAddress(customer.address);
    const updated = store.update('customers', req.params.id, { lat, lng, geocodedAddress: displayName, addressVerified: true });
    res.json(withOwnerName(updated));
  } catch (err) {
    store.update('customers', req.params.id, { addressVerified: false });
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
