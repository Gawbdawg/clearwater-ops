const express = require('express');
const store = require('../lib/store');
const { hashPassword, sanitizeOwner } = require('../lib/auth');
const { generateMonthlyInvoiceForOwner } = require('../lib/monthlyInvoice');
const { makeCustomerMatcher } = require('../lib/customerMatch');
const router = express.Router();

function withPropertyCount(owner) {
  const count = store.getAll('customers').filter((c) => c.ownerId === owner.id).length;
  return { ...sanitizeOwner(owner), propertyCount: count };
}

router.get('/', (req, res) => {
  res.json(store.getAll('owners').map(withPropertyCount));
});

router.post('/', (req, res) => {
  const { name, email, phone, username, password, customPricing, billingMode } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (username) {
    const existing = store.getAll('owners').find((o) => (o.username || '').toLowerCase() === username.toLowerCase());
    if (existing) return res.status(400).json({ error: 'That username is already taken' });
  }
  const cleanedPricing = {};
  Object.entries(customPricing || {}).forEach(([serviceId, price]) => {
    if (price !== '' && price !== null && price !== undefined && !Number.isNaN(Number(price))) {
      cleanedPricing[serviceId] = Number(price);
    }
  });
  const owner = store.create('owners', {
    name,
    email: email || '',
    phone: phone || '',
    username: username || '',
    passwordHash: password ? hashPassword(password) : '',
    customPricing: cleanedPricing,
    billingMode: billingMode === 'monthly' ? 'monthly' : 'perJob',
  });
  res.status(201).json(withPropertyCount(owner));
});

router.put('/:id', (req, res) => {
  const { name, email, phone, username, password } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (username !== undefined) {
    if (username) {
      const existing = store.getAll('owners').find(
        (o) => o.id !== Number(req.params.id) && (o.username || '').toLowerCase() === username.toLowerCase()
      );
      if (existing) return res.status(400).json({ error: 'That username is already taken' });
    }
    updates.username = username;
  }
  if (password) updates.passwordHash = hashPassword(password);
  if (req.body.billingMode !== undefined) {
    updates.billingMode = req.body.billingMode === 'monthly' ? 'monthly' : 'perJob';
  }
  // customPricing: { [serviceId]: price } — per-owner price overrides, covering every
  // property linked to this owner. A missing/blank entry falls back to that service's
  // catalog default price (see lib/autoInvoice.js).
  if (req.body.customPricing !== undefined) {
    const cleaned = {};
    Object.entries(req.body.customPricing || {}).forEach(([serviceId, price]) => {
      if (price !== '' && price !== null && price !== undefined && !Number.isNaN(Number(price))) {
        cleaned[serviceId] = Number(price);
      }
    });
    updates.customPricing = cleaned;
  }
  const updated = store.update('owners', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Owner not found' });
  res.json(withPropertyCount(updated));
});

// Bulk-creates owner accounts for every customer that doesn't already have one linked.
// Customers sharing the same email or phone number are grouped onto a single owner
// account (so one person managing several rental properties gets one login, not several).
// Accounts are created with no password set — nobody can log in until a password is added
// later (Owners tab or the owner's own portal), so this is safe to run any time.
router.post('/bulk-create-from-customers', (req, res) => {
  const customers = store.getAll('customers');
  const unlinked = customers.filter((c) => !c.ownerId);

  const normEmail = (v) => (v || '').trim().toLowerCase();
  const normPhone = (v) => (v || '').replace(/\D/g, '');

  // Group unlinked customers by shared email, then by shared phone. A customer with
  // neither gets its own group (key is unique to that customer).
  const groups = new Map();
  unlinked.forEach((c) => {
    const key = (c.email && normEmail(c.email)) ? `email:${normEmail(c.email)}`
      : (c.phone && normPhone(c.phone)) ? `phone:${normPhone(c.phone)}`
      : `solo:${c.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });

  const existingUsernames = new Set(
    store.getAll('owners').map((o) => (o.username || '').toLowerCase()).filter(Boolean)
  );

  function slugify(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
  }

  function uniqueUsername(base) {
    const cleanBase = base || 'owner';
    let candidate = cleanBase;
    let n = 2;
    while (!candidate || existingUsernames.has(candidate)) {
      candidate = `${cleanBase}${n}`;
      n += 1;
    }
    existingUsernames.add(candidate);
    return candidate;
  }

  let ownersCreated = 0;
  let customersLinked = 0;

  groups.forEach((groupCustomers) => {
    const rep = groupCustomers[0]; // representative record for the owner's contact info
    const usernameBase = rep.email ? slugify(rep.email.split('@')[0]) : slugify(rep.name);
    const owner = store.create('owners', {
      name: rep.name,
      email: rep.email || '',
      phone: rep.phone || '',
      username: uniqueUsername(usernameBase),
      passwordHash: '', // intentionally no password — set later if/when this owner needs to log in
    });
    ownersCreated += 1;
    groupCustomers.forEach((c) => {
      store.update('customers', c.id, { ownerId: owner.id });
      customersLinked += 1;
    });
  });

  res.json({
    ownersCreated,
    customersLinked,
    alreadyLinked: customers.length - unlinked.length,
  });
});

// Bulk-links owners to customers/properties from pasted text — one line per pairing in
// the form "CustomerName: OwnerName, Phone". The customer/property side is matched the
// same conservative way as the other bulk-paste tools (bulk appointment import, bulk
// contact-info update) — anything ambiguous is skipped and reported back rather than
// guessed at. The owner side is matched by exact name (case-insensitive) so the same
// owner mentioned on multiple lines (e.g. one person who owns two properties) only gets
// created once and both properties get linked to it. Never overwrites a customer that's
// already linked to a DIFFERENT owner — that's reported back as a conflict instead of
// silently changed.
router.post('/bulk-link-from-text', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });

  const customers = store.getAll('customers');
  const findCustomer = makeCustomerMatcher(customers);
  let owners = store.getAll('owners');
  const findOwnerByName = (name) => owners.find((o) => (o.name || '').trim().toLowerCase() === name.trim().toLowerCase());

  const linked = [];
  const alreadyLinked = [];
  const conflicts = [];
  const unmatchedCustomers = [];
  const skippedLines = [];
  let ownersCreated = 0;

  text.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { skippedLines.push(line); return; }
    const customerName = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    const commaIdx = rest.indexOf(',');
    const ownerName = (commaIdx === -1 ? rest : rest.slice(0, commaIdx)).trim();
    const phone = (commaIdx === -1 ? '' : rest.slice(commaIdx + 1).trim());
    if (!customerName || !ownerName) { skippedLines.push(line); return; }

    const customer = findCustomer(customerName);
    if (!customer) { unmatchedCustomers.push(customerName); return; }

    if (customer.ownerId) {
      const existingOwner = store.getById('owners', customer.ownerId);
      if (existingOwner && existingOwner.name.trim().toLowerCase() === ownerName.trim().toLowerCase()) {
        alreadyLinked.push(`${customer.name} (already linked to ${existingOwner.name})`);
      } else {
        conflicts.push(`${customer.name} is already linked to a different owner (${existingOwner ? existingOwner.name : 'unknown'}) — left unchanged`);
      }
      return;
    }

    let owner = findOwnerByName(ownerName);
    if (!owner) {
      owner = store.create('owners', {
        name: ownerName,
        email: '',
        phone: phone || '',
        username: '',
        passwordHash: '',
      });
      owners = [...owners, owner];
      ownersCreated += 1;
    } else if (phone && !owner.phone) {
      // Fill in a phone number we now have for an owner that didn't have one yet —
      // never overwrites a phone number that's already on file.
      owner = store.update('owners', owner.id, { phone });
      owners = owners.map((o) => (o.id === owner.id ? owner : o));
    }

    store.update('customers', customer.id, { ownerId: owner.id });
    linked.push(`${customer.name} -> ${owner.name}`);
  });

  res.json({
    linked,
    linkedCount: linked.length,
    ownersCreated,
    alreadyLinked,
    conflicts,
    unmatchedCustomers,
    skippedLines,
  });
});

// Bundles this owner's completed, not-yet-billed jobs for the given month (YYYY-MM,
// in req.body) into one combined invoice. Safe to re-run — a job already billed
// (individually or in a prior combined invoice) never gets included twice.
router.post('/:id/generate-monthly-invoice', (req, res) => {
  try {
    const invoice = generateMonthlyInvoiceForOwner(req.params.id, req.body.month);
    if (!invoice) return res.json({ created: false, message: 'Nothing to bill for that month.' });
    res.status(201).json({ created: true, invoice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const linkedProperties = store.getAll('customers').filter((c) => c.ownerId === Number(req.params.id));
  linkedProperties.forEach((p) => store.update('customers', p.id, { ownerId: null }));
  const ok = store.remove('owners', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Owner not found' });
  res.status(204).end();
});

module.exports = router;
