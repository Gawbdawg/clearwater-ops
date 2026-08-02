const express = require('express');
const store = require('../lib/store');
const { requireOwnerAuth } = require('../lib/auth');
const { syncCustomerCalendar } = require('../lib/icalSync');
const { maybeCreateCheckoutAppointment } = require('../lib/turnoverSchedule');
const { geocodeAddress } = require('../lib/geocode');
const { previewFrequencyPricing } = require('../lib/autoInvoice');
const { generateRecurringSeries } = require('../lib/scheduleFromFrequency');
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

// Lets an owner add their own property from the portal (e.g. on first login, or
// adding a second hot tub later) instead of waiting on the admin to create it —
// always attached to their own account; there's no way to pass a different ownerId
// here. Best-effort geocodes the address right away, same as the admin's customer
// form, so it's routable as soon as a tech is assigned. A blank/unrecognized address
// just leaves it unlocated rather than blocking the save.
router.post('/properties', async (req, res) => {
  const { name, address, type } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'A property name is required' });

  const geo = { lat: null, lng: null, geocodedAddress: '', addressVerified: false };
  if (address && address.trim()) {
    try {
      const { lat, lng, displayName } = await geocodeAddress(address);
      Object.assign(geo, { lat, lng, geocodedAddress: displayName, addressVerified: true });
    } catch (err) {
      // leave geo as the "not located" defaults — a typo or too-new/rural address
      // shouldn't block the owner from saving their property
    }
  }

  const property = store.create('customers', {
    name: name.trim(),
    address: address ? address.trim() : '',
    type: type === 'vacation' ? 'vacation' : 'residential',
    ownerId: req.session.ownerId,
    email: '',
    phone: '',
    notes: '',
    icalUrl: '',
    equipment: null,
    serviceFrequency: null,
    customFrequencyDays: null,
    ...geo,
  });
  res.status(201).json(property);
});

// Pricing preview + current frequency for the "set up my regular service" flow —
// lets an owner see what weekly/biweekly/every-4-weeks actually costs before picking
// one, without needing to call and ask. Only meaningful for residential properties;
// vacation rentals get cleaned around guest bookings instead (see /bookings above and
// lib/turnoverSchedule.js), not on a fixed calendar frequency.
router.get('/properties/:id/service-setup', (req, res) => {
  const property = myProperty(req, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  if (property.type === 'vacation') {
    return res.json({ available: false, reason: 'vacation' });
  }
  const service = store.getAll('services').find((s) => s.pricingMode === 'frequency');
  if (!service) {
    return res.json({ available: false, reason: 'no-service' });
  }
  const pricing = previewFrequencyPricing(service, req.session.ownerId);
  const today = new Date().toISOString().slice(0, 10);
  const hasUpcoming = store.getAll('appointments')
    .some((a) => a.customerId === property.id && a.status === 'scheduled' && a.date >= today);
  res.json({
    available: true,
    serviceName: service.name,
    currentFrequency: property.serviceFrequency || null,
    hasUpcomingVisits: hasUpcoming,
    ...pricing,
  });
});

// Owner self-service version of the admin's "Schedule recurring visits" action: pick
// a frequency, see the price (via the endpoint above), pick a start date, and the
// actual recurring series gets created on the calendar right away — no back-and-forth
// needed to get set up. Blocks re-running this if the property already has upcoming
// scheduled visits, so an owner can't accidentally double-book their own calendar by
// submitting this more than once; changing an already-running schedule goes through
// the admin instead, since it may need to account for visits already in progress.
router.post('/properties/:id/schedule-service', (req, res) => {
  const property = myProperty(req, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  if (property.type === 'vacation') {
    return res.status(400).json({ error: 'Vacation properties are scheduled automatically around your guest bookings instead.' });
  }
  const { frequency, startDate } = req.body;
  if (!['weekly', 'biweekly', 'every4weeks'].includes(frequency)) {
    return res.status(400).json({ error: 'Choose a valid frequency.' });
  }
  if (!startDate) {
    return res.status(400).json({ error: 'Pick a start date.' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const hasUpcoming = store.getAll('appointments')
    .some((a) => a.customerId === property.id && a.status === 'scheduled' && a.date >= today);
  if (hasUpcoming) {
    return res.status(400).json({ error: 'This property already has upcoming visits scheduled — contact us if you need to change your schedule.' });
  }
  const service = store.getAll('services').find((s) => s.pricingMode === 'frequency');
  store.update('customers', property.id, { serviceFrequency: frequency });
  const updated = store.getById('customers', property.id);
  const result = generateRecurringSeries(updated, {
    startDate,
    startTime: '09:00',
    technicianId: null,
    serviceId: service ? service.id : null,
  });
  res.status(201).json(result);
});

// Read-only view of scheduled/completed service visits across all of this owner's
// properties — the actual jobs the admin/tech has on the calendar, not the booking
// dates or requests the owner enters themselves. Defaults to upcoming + recent (last
// 30 days) so the list doesn't grow forever; ?all=1 returns full history.
router.get('/appointments', (req, res) => {
  const myPropertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === req.session.ownerId)
    .map((c) => c.id);
  let appts = store.getAll('appointments').filter((a) => myPropertyIds.includes(a.customerId) && a.status !== 'cancelled');
  if (!req.query.all) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    appts = appts.filter((a) => a.date >= cutoffStr);
  }
  const enriched = appts
    .map((a) => {
      const property = store.getById('customers', a.customerId);
      return {
        id: a.id,
        date: a.date,
        startTime: a.startTime,
        status: a.status,
        serviceType: a.serviceType,
        propertyName: property ? property.name : 'Unknown property',
        addons: a.addons || [],
        photos: (a.photos || []).map((p) => ({ id: p.id, type: p.type, url: p.url })),
      };
    })
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  res.json(enriched);
});

// Only appointments on one of this owner's own properties, and only while the visit
// is still upcoming (not yet completed), can have extras added or removed.
function myUpcomingAppointment(req, apptId) {
  const appt = store.getById('appointments', apptId);
  if (!appt || !myProperty(req, appt.customerId)) return null;
  if (appt.status !== 'scheduled') return null;
  return appt;
}

router.post('/appointments/:id/addons', (req, res) => {
  const appt = myUpcomingAppointment(req, req.params.id);
  if (!appt) return res.status(404).json({ error: 'Upcoming visit not found' });
  const addon = store.getById('addons', req.body.addonId);
  if (!addon) return res.status(404).json({ error: 'Upcharge not found' });
  const existing = appt.addons || [];
  if (existing.some((a) => a.id === addon.id)) return res.json({ addons: existing });
  const addons = [...existing, { id: addon.id, name: addon.name, price: addon.price }];
  const updated = store.update('appointments', req.params.id, { addons });
  res.json({ addons: updated.addons });
});

router.delete('/appointments/:id/addons/:addonId', (req, res) => {
  const appt = myUpcomingAppointment(req, req.params.id);
  if (!appt) return res.status(404).json({ error: 'Upcoming visit not found' });
  const addons = (appt.addons || []).filter((a) => String(a.id) !== req.params.addonId);
  const updated = store.update('appointments', req.params.id, { addons });
  res.json({ addons: updated.addons });
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
