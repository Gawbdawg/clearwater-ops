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

router.post('/', (req, res) => {
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
  });
  res.status(201).json(withOwnerName(customer));
});

router.put('/:id', (req, res) => {
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

  // Address changed — clear cached coordinates so it gets re-geocoded, not routed using a stale location
  const existing = store.getById('customers', req.params.id);
  if (existing && updates.address !== undefined && updates.address !== existing.address) {
    updates.lat = null;
    updates.lng = null;
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
    const { lat, lng } = await geocodeAddress(customer.address);
    const updated = store.update('customers', req.params.id, { lat, lng });
    res.json(withOwnerName(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
