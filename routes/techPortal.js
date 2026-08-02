const express = require('express');
const store = require('../lib/store');
const { requireTechAuth } = require('../lib/auth');
const { orderStopsByRoute } = require('../lib/routeOptimizer');
const { savePhoto, deletePhoto } = require('../lib/uploads');
const { syncInvoiceForCompletedAppointment } = require('../lib/autoInvoice');
const router = express.Router();

router.use(requireTechAuth);

// Techs tap an upcharge on/off by name only — the price is a back-office detail set
// in Settings and stays hidden from the tech app everywhere (catalog, job list,
// add/remove responses). Only the admin dashboard and owner portal show prices.
function hideAddonPrices(addons) {
  return (addons || []).map((a) => ({ id: a.id, name: a.name }));
}
function hideApptAddonPrices(appt) {
  if (!appt) return appt;
  return { ...appt, addons: hideAddonPrices(appt.addons) };
}

// Read-only catalog of upcharges a tech can attach to a job (e.g. grill cleaning,
// window spray) — managed by the admin in Settings, see routes/addons.js.
router.get('/addons', (req, res) => {
  const catalog = store.getAll('addons').sort((a, b) => a.name.localeCompare(b.name));
  res.json(hideAddonPrices(catalog));
});

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
      addons: hideAddonPrices(a.addons),
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
  syncInvoiceForCompletedAppointment(updated);
  res.json(hideApptAddonPrices(updated));
});

// Attach one upcharge/add-on to one of this technician's own jobs (e.g. tapping
// "+ Grill cleaning $10" while on site). Stores a price snapshot at add time so a later
// catalog price change never retroactively changes an already-billed job. A no-op if
// that add-on is already attached — tapping it twice doesn't double-charge.
router.post('/appointments/:id/addons', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const addon = store.getById('addons', req.body.addonId);
  if (!addon) return res.status(404).json({ error: 'Add-on not found' });
  const existing = appt.addons || [];
  if (existing.some((a) => a.id === addon.id)) return res.json(hideApptAddonPrices(appt));
  const addons = [...existing, { id: addon.id, name: addon.name, price: addon.price }];
  const updated = store.update('appointments', req.params.id, { addons });
  syncInvoiceForCompletedAppointment(updated);
  res.json(hideApptAddonPrices(updated));
});

// Attach a one-off upcharge that isn't in the catalog (e.g. "Replaced a filter, $15")
// — for whatever comes up on site that the admin hasn't pre-added to Settings. Gets a
// unique string id (rather than a catalog addon's numeric id) so it can still be
// removed individually and never collides with a real catalog entry.
router.post('/appointments/:id/addons/custom', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const name = (req.body.name || '').trim();
  const price = Number(req.body.price);
  if (!name) return res.status(400).json({ error: 'A name is required' });
  if (!price || price <= 0) return res.status(400).json({ error: 'A price greater than $0 is required' });
  const entry = { id: `custom-${Date.now()}`, name, price };
  const addons = [...(appt.addons || []), entry];
  const updated = store.update('appointments', req.params.id, { addons });
  syncInvoiceForCompletedAppointment(updated);
  res.json(hideApptAddonPrices(updated));
});

// Remove an upcharge that was added by mistake.
router.delete('/appointments/:id/addons/:addonId', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt || appt.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Appointment not found' });
  }
  const addons = (appt.addons || []).filter((a) => String(a.id) !== req.params.addonId);
  const updated = store.update('appointments', req.params.id, { addons });
  syncInvoiceForCompletedAppointment(updated);
  res.json(hideApptAddonPrices(updated));
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
