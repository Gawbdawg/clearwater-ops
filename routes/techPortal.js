const express = require('express');
const store = require('../lib/store');
const { requireTechAuth } = require('../lib/auth');
const { orderStopsByRoute } = require('../lib/routeOptimizer');
const { savePhoto, deletePhoto } = require('../lib/uploads');
const router = express.Router();

router.use(requireTechAuth);

// Only this technician's appointments — today and upcoming by default, or a specific date via ?date=
// Each day's stops are ordered into an efficient route from the shop when we have
// coordinates for them; days are still shown in date order.
router.get('/appointments', (req, res) => {
  const technicianId = req.session.technicianId;
  let appts = store.getAll('appointments').filter((a) => a.technicianId === technicianId);

  if (req.query.date) {
    appts = appts.filter((a) => a.date === req.query.date);
  } else {
    const today = new Date().toISOString().slice(0, 10);
    appts = appts.filter((a) => a.date >= today && a.status !== 'cancelled');
  }

  const enriched = appts.map((a) => {
    const customer = store.getById('customers', a.customerId);
    return {
      ...a,
      customerName: customer ? customer.name : 'Unknown customer',
      customerPhone: customer ? customer.phone : '',
      customerAddress: customer ? customer.address : '',
      customerNotes: customer ? customer.notes : '',
      customerEquipment: customer ? customer.equipment : null,
      lat: customer ? customer.lat : undefined,
      lng: customer ? customer.lng : undefined,
    };
  });

  const settings = store.getSettings();
  const depot = (typeof settings.depotLat === 'number' && typeof settings.depotLng === 'number')
    ? { lat: settings.depotLat, lng: settings.depotLng }
    : null;

  const byDate = {};
  enriched.forEach((a) => { (byDate[a.date] = byDate[a.date] || []).push(a); });

  let result = [];
  Object.keys(byDate).sort().forEach((date) => {
    const dayAppts = byDate[date];
    if (depot) {
      const { ordered, unroutable } = orderStopsByRoute(depot, dayAppts);
      result = result.concat(ordered, unroutable);
    } else {
      result = result.concat(dayAppts.sort((a, b) => a.startTime.localeCompare(b.startTime)));
    }
  });

  res.json(result);
});

// Let a technician mark their own job completed
router.put('/appointments/:id/status', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const { status } = req.body;
  if (!['scheduled', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const updated = store.update('appointments', req.params.id, { status });
  res.json(updated);
});

// Upload a before/after photo for one of this technician's own jobs.
// Body: { type: 'before'|'after', dataUrl: 'data:image/jpeg;base64,...' } —
// the browser resizes the image before sending, so this stays reasonably small.
router.post('/appointments/:id/photos', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const { type, dataUrl } = req.body;
  if (!['before', 'after'].includes(type)) return res.status(400).json({ error: 'type must be before or after' });
  try {
    const url = savePhoto(dataUrl);
    const photo = { id: Date.now(), type, url, uploadedAt: new Date().toISOString() };
    const photos = [...(appt.photos || []), photo];
    const updated = store.update('appointments', req.params.id, { photos });
    res.status(201).json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/appointments/:id/photos/:photoId', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const photo = (appt.photos || []).find((p) => String(p.id) === req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  deletePhoto(photo.url);
  const photos = (appt.photos || []).filter((p) => String(p.id) !== req.params.photoId);
  const updated = store.update('appointments', req.params.id, { photos });
  res.json(updated);
});

module.exports = router;
