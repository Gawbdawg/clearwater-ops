const express = require('express');
const store = require('../lib/store');
const { hashPassword, sanitizeCustomer } = require('../lib/auth');
const { geocodeAddress } = require('../lib/geocode');
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

router.get('/:id', (req, res) => {
  const customer = store.getById('customers', req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const appointments = store.getAll('appointments').filter((a) => a.customerId === customer.id);
  const invoices = store.getAll('invoices').filter((i) => i.customerId === customer.id);
  res.json({ ...withOwnerName(customer), appointments, invoices });
});

router.post('/', (req, res) => {
  const { name, email, phone, address, notes, type, icalUrl, ownerId, newOwner, equipment } = req.body;
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
