const express = require('express');
const store = require('../lib/store');
const { requireTechAuth } = require('../lib/auth');
const { orderStopsByRoute } = require('../lib/routeOptimizer');
const { savePhoto, deletePhoto } = require('../lib/uploads');
const { syncInvoiceForCompletedAppointment } = require('../lib/autoInvoice');
const { sendSms } = require('../lib/sms');
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

// Only this technician's appointments — today and upcoming by default, a specific date
// via ?date=, or every job regardless of date via ?all=1 (used by the Calendar tab,
// which needs to show past and future months, not just what's upcoming).
// Each day's stops are ordered into an efficient route from the shop when we have
// coordinates for them; days are still shown in date order.
router.get('/appointments', (req, res) => {
  const technicianId = req.session.technicianId;
  let appts = store.getAll('appointments').filter((a) => a.technicianId === technicianId);

  if (req.query.date) {
    appts = appts.filter((a) => a.date === req.query.date);
  } else if (req.query.all === '1') {
    // no date filter — the calendar paginates by month client-side
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

// Texts the technician's own phone their route-ordered stops for one day (defaults to
// today) — same nearest-neighbor ordering from the shop used everywhere else in the
// app, just triggered by the tech themselves instead of the admin copying/pasting a
// message from the Daily Schedule tab. Uses lib/sms's same Twilio integration (and its
// dry-run console fallback if Twilio isn't configured yet).
router.post('/text-my-route', async (req, res) => {
  const technicianId = req.session.technicianId;
  const tech = store.getById('technicians', technicianId);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });
  if (!tech.phone) {
    return res.status(400).json({ error: 'No phone number is on file for your account yet — ask the admin to add one under Technicians.' });
  }

  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const appts = store.getAll('appointments')
    .filter((a) => a.technicianId === technicianId && a.date === date && a.status !== 'cancelled')
    .map((a) => {
      const customer = store.getById('customers', a.customerId);
      return { ...a, customer, lat: customer ? customer.lat : undefined, lng: customer ? customer.lng : undefined };
    });

  const settings = store.getSettings();
  const depot = (typeof settings.depotLat === 'number' && typeof settings.depotLng === 'number')
    ? { lat: settings.depotLat, lng: settings.depotLng }
    : null;

  let ordered = appts.slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
  let routed = false;
  let missingCount = 0;
  if (depot && appts.length > 0) {
    const { ordered: routedStops, unroutable } = orderStopsByRoute(depot, appts);
    ordered = [...routedStops, ...unroutable];
    routed = true;
    missingCount = unroutable.length;
  }

  let text = `Hi ${tech.name}, here's your Clear Water schedule for ${date}`;
  text += routed ? ' (in efficient route order from the shop):\n\n' : ':\n\n';
  if (ordered.length === 0) {
    text += 'No appointments scheduled that day.';
  } else {
    ordered.forEach((a, i) => {
      text += `${i + 1}. ${a.startTime}${a.endTime ? '-' + a.endTime : ''} — ${a.customer ? a.customer.name : 'Unknown'} (${a.serviceType || 'Service'})\n`;
      if (a.customer && a.customer.address) text += `   ${a.customer.address}\n`;
      if (a.customer && a.customer.phone) text += `   ${a.customer.phone}\n`;
      if (a.notes) text += `   Note: ${a.notes}\n`;
    });
    if (routed && missingCount > 0) {
      text += `\n(${missingCount} stop${missingCount === 1 ? '' : 's'} listed last — no map location on file yet.)`;
    }
  }

  try {
    const result = await sendSms({ to: tech.phone, body: text });
    res.json({ sent: true, dryRun: !!result.dryRun, date });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Time off (self-service day blocking) ----
// A tech can block off any number of days themselves — takes effect immediately, no
// approval step. The admin sees every technician's time off in the Technicians tab and
// can delete an entry if a conflict comes up, but nothing here prevents a job from
// being scheduled on a blocked day; it's informational, the same way an owner's booking
// calendar just shows what's occupied rather than hard-locking the admin out.
router.get('/time-off', (req, res) => {
  const technicianId = req.session.technicianId;
  const entries = store.getAll('techTimeOff')
    .filter((t) => t.technicianId === technicianId)
    .sort((a, b) => a.date.localeCompare(b.date));
  res.json(entries);
});

router.post('/time-off', (req, res) => {
  const technicianId = req.session.technicianId;
  const { startDate, endDate, note } = req.body;
  if (!startDate) return res.status(400).json({ error: 'startDate is required' });
  const end = endDate || startDate;
  if (end < startDate) return res.status(400).json({ error: 'End date is before start date' });

  const existingDates = new Set(
    store.getAll('techTimeOff').filter((t) => t.technicianId === technicianId).map((t) => t.date)
  );

  const created = [];
  let cursor = new Date(startDate + 'T00:00:00');
  const last = new Date(end + 'T00:00:00');
  // A generous cap, not a real-world limit — just stops a typo'd date range (e.g. the
  // wrong year) from silently creating thousands of rows.
  let guard = 0;
  while (cursor <= last && guard < 366) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;
    if (!existingDates.has(dateStr)) {
      created.push(store.create('techTimeOff', { technicianId, date: dateStr, note: note || '' }));
      existingDates.add(dateStr);
    }
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  res.status(201).json(created);
});

router.delete('/time-off/:id', (req, res) => {
  const entry = store.getById('techTimeOff', req.params.id);
  if (!entry || entry.technicianId !== req.session.technicianId) {
    return res.status(404).json({ error: 'Time off entry not found' });
  }
  store.remove('techTimeOff', req.params.id);
  res.status(204).end();
});

module.exports = router;
