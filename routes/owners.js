const express = require('express');
const store = require('../lib/store');
const { hashPassword, sanitizeOwner } = require('../lib/auth');
const router = express.Router();

function withPropertyCount(owner) {
  const count = store.getAll('customers').filter((c) => c.ownerId === owner.id).length;
  return { ...sanitizeOwner(owner), propertyCount: count };
}

router.get('/', (req, res) => {
  res.json(store.getAll('owners').map(withPropertyCount));
});

router.post('/', (req, res) => {
  const { name, email, phone, username, password } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (username) {
    const existing = store.getAll('owners').find((o) => (o.username || '').toLowerCase() === username.toLowerCase());
    if (existing) return res.status(400).json({ error: 'That username is already taken' });
  }
  const owner = store.create('owners', {
    name,
    email: email || '',
    phone: phone || '',
    username: username || '',
    passwordHash: password ? hashPassword(password) : '',
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
  const updated = store.update('owners', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Owner not found' });
  res.json(withPropertyCount(updated));
});

router.delete('/:id', (req, res) => {
  const linkedProperties = store.getAll('customers').filter((c) => c.ownerId === Number(req.params.id));
  linkedProperties.forEach((p) => store.update('customers', p.id, { ownerId: null }));
  const ok = store.remove('owners', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Owner not found' });
  res.status(204).end();
});

module.exports = router;
