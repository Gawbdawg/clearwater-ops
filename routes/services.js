// Admin-managed catalog of standard services with default prices — used to speed up
// picking a service on an appointment, and to auto-generate a draft invoice at the
// right price when a technician marks a job complete (see routes/appointments.js).
const express = require('express');
const store = require('../lib/store');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(store.getAll('services').sort((a, b) => a.name.localeCompare(b.name)));
});

router.post('/', (req, res) => {
  const { name, defaultPrice } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const service = store.create('services', {
    name,
    defaultPrice: defaultPrice ? Number(defaultPrice) : 0,
  });
  res.status(201).json(service);
});

router.put('/:id', (req, res) => {
  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.defaultPrice !== undefined) updates.defaultPrice = Number(req.body.defaultPrice) || 0;
  const updated = store.update('services', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Service not found' });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('services', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Service not found' });
  res.status(204).end();
});

module.exports = router;
