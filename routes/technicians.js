const express = require('express');
const store = require('../lib/store');
const { hashPassword, sanitizeTechnician } = require('../lib/auth');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(store.getAll('technicians').map(sanitizeTechnician));
});

router.post('/', (req, res) => {
  const { name, email, phone, username, password } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  if (username) {
    const existing = store.getAll('technicians').find(
      (t) => (t.username || '').toLowerCase() === username.toLowerCase()
    );
    if (existing) return res.status(400).json({ error: 'That username is already taken' });
  }

  const tech = store.create('technicians', {
    name,
    email: email || '',
    phone: phone || '',
    username: username || '',
    passwordHash: password ? hashPassword(password) : '',
  });
  res.status(201).json(sanitizeTechnician(tech));
});

router.put('/:id', (req, res) => {
  const { name, email, phone, username, password } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;

  if (username !== undefined) {
    if (username) {
      const existing = store.getAll('technicians').find(
        (t) => t.id !== Number(req.params.id) && (t.username || '').toLowerCase() === username.toLowerCase()
      );
      if (existing) return res.status(400).json({ error: 'That username is already taken' });
    }
    updates.username = username;
  }
  // Only overwrite the password if a new one was actually typed in
  if (password) updates.passwordHash = hashPassword(password);

  const updated = store.update('technicians', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Technician not found' });
  res.json(sanitizeTechnician(updated));
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('technicians', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Technician not found' });
  res.status(204).end();
});

module.exports = router;
