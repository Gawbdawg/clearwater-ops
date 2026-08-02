const express = require('express');
const store = require('../lib/store');
const { requireOwnerAuth } = require('../lib/auth');
const { syncCustomerCalendar } = require('../lib/icalSync');
const { maybeCreateCheckoutAppointment } = require('../lib/turnoverSchedule');
const router = express.Router();

router.use(requireOwnerAuth);

// Only properties belonging to the logged-in owner may ever be touched below.
function myProperty(req, propertyId) {
  const property = store.getById('customers', propertyId);
  if (!property || property.ownerId !== req.session.ownerId) return null;
  return property;
}

// Read-only catalog of upcharges an owner can ask to have included with a service
// request (e.g. grill cleaning, window spray) — managed by the admin in Settings, see
// routes/addons.js.
router.get('/addons', (req, res) => {
  res.json(store.getAll('addons').sort((a, b) => a.name.localeCompare(b.name)));
});

// ---- This owner's properties ----
router.get('/properties', (req, res) => {
  const properties = store.getAll('customers')
    .filter((c) => c.ownerId === req.session.ownerId)
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(properties);
});

// ---- Occupied / guest-booking date ranges (scoped to one of this owner's properties) ----
router.get('/bookings', (req, res) => {
  const myPropertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === req.session.ownerId)
    .map((c) => c.id);
  let bookings = store.getAll('bookings').filter((b) => myPropertyIds.includes(b.customerId));
  if (req.query.propertyId) bookings = bookings.filter((b) => b.customerId === Number(req.query.propertyId));
  bookings = bookings.sort((a, b) => a.startDate.localeCompare(b.startDate));
  res.json(bookings);
});

router.post('/bookings', (req, res) => {
  const { propertyId, startDate, endDate, notes } = req.body;
  if (!propertyId || !startDate || !endDate) {
    return res.status(400).json({ error: 'propertyId, startDate and endDate are required' });
  }
  if (!myProperty(req, propertyId)) return res.status(404).json({ error: 'Property not found' });
  const booking = store.create('bookings', {
    customerId: Number(propertyId),
    startDate,
    endDate,
    notes: notes || '',
    source: 'manual',
  });
  maybeCreateCheckoutAppointment(Number(propertyId), endDate);
  res.status(201).json(booking);
});

router.delete('/bookings/:id', (req, res) => {
  const booking = store.getById('bookings', req.params.id);
  if (!booking || !myProperty(req, booking.customerId)) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  store.remove('bookings', req.params.id);
  res.status(204).end();
});

// ---- Requested service dates (scoped to one of this owner's properties) ----
router.get('/service-requests', (req, res) => {
  const myPropertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === req.session.ownerId)
    .map((c) => c.id);
  const requests = store.getAll('serviceRequests')
    .filter((r) => myPropertyIds.includes(r.customerId))
    .map((r) => {
      const property = store.getById('customers', r.customerId);
      return { ...r, propertyName: property ? property.name : 'Unknown property' };
    })
    .sort((a, b) => a.requestedDate.localeCompare(b.requestedDate));
  res.json(requests);
});

router.post('/service-requests', (req, res) => {
  const { propertyId, requestedDate, notes, addonIds } = req.body;
  if (!propertyId || !requestedDate) {
    return res.status(400).json({ error: 'propertyId and requestedDate are required' });
  }
  if (!myProperty(req, propertyId)) return res.status(404).json({ error: 'Property not found' });
  // Snapshot the chosen upcharges' name/price at request time, same as everywhere else
  // addons are attached — so a later catalog price change doesn't change what was asked
  // for. Carried onto the appointment automatically when an admin schedules this request
  // (see routes/appointments.js and public/app.js's scheduleRequest).
  const catalog = store.getAll('addons');
  const addons = (Array.isArray(addonIds) ? addonIds : [])
    .map((id) => catalog.find((a) => a.id === Number(id)))
    .filter(Boolean)
    .map((a) => ({ id: a.id, name: a.name, price: a.price }));
  const request = store.create('serviceRequests', {
    customerId: Number(propertyId),
    requestedDate,
    notes: notes || '',
    status: 'pending',
    addons,
  });
  res.status(201).json(request);
});

router.delete('/service-requests/:id', (req, res) => {
  const request = store.getById('serviceRequests', req.params.id);
  if (!request || !myProperty(req, request.customerId) || request.status !== 'pending') {
    return res.status(404).json({ error: 'Request not found or already handled' });
  }
  store.remove('serviceRequests', req.params.id);
  res.status(204).end();
});

// ---- iCal calendar auto-sync (per property) ----
router.put('/properties/:id/ical-url', (req, res) => {
  if (!myProperty(req, req.params.id)) return res.status(404).json({ error: 'Property not found' });
  const { icalUrl } = req.body;
  const updated = store.update('customers', req.params.id, { icalUrl: icalUrl || '' });
  res.json({ icalUrl: updated.icalUrl });
});

router.post('/properties/:id/sync-calendar', async (req, res) => {
  if (!myProperty(req, req.params.id)) return res.status(404).json({ error: 'Property not found' });
  try {
    const result = await syncCustomerCalendar(Number(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
