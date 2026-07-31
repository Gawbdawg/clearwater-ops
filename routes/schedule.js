const express = require('express');
const store = require('../lib/store');
const { sanitizeCustomer, sanitizeTechnician } = require('../lib/auth');
const { orderStopsByRoute } = require('../lib/routeOptimizer');
const router = express.Router();

function dayAppointments(date) {
  return store.getAll('appointments')
    .filter((a) => a.date === date)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((a) => {
      const customer = store.getById('customers', a.customerId);
      const technician = a.technicianId ? store.getById('technicians', a.technicianId) : null;
      return { ...a, customer: sanitizeCustomer(customer), technician: sanitizeTechnician(technician) };
    });
}

// JSON view of a day's schedule, grouped by technician
router.get('/:date', (req, res) => {
  const appts = dayAppointments(req.params.date);
  const byTech = {};
  appts.forEach((a) => {
    const key = a.technician ? a.technician.name : 'Unassigned';
    if (!byTech[key]) byTech[key] = [];
    byTech[key].push(a);
  });
  res.json({ date: req.params.date, count: appts.length, byTechnician: byTech });
});

// Orders a day's appointments into an efficient driving route from the depot,
// falling back to time order for any stop we don't have coordinates for yet.
function routeOrder(appts) {
  const settings = store.getSettings();
  const depot = (typeof settings.depotLat === 'number' && typeof settings.depotLng === 'number')
    ? { lat: settings.depotLat, lng: settings.depotLng }
    : null;

  const stops = appts.map((a) => ({
    appt: a,
    lat: a.customer ? a.customer.lat : undefined,
    lng: a.customer ? a.customer.lng : undefined,
  }));

  if (!depot) {
    return { ordered: appts, routed: false, missingCount: appts.length };
  }

  const { ordered, unroutable } = orderStopsByRoute(depot, stops);
  return {
    ordered: [...ordered, ...unroutable].map((s) => s.appt),
    routed: true,
    missingCount: unroutable.length,
  };
}

// Plain-text message ready to copy/paste or send via email/SMS to a technician
router.get('/:date/technician/:technicianId/text', (req, res) => {
  const appts = dayAppointments(req.params.date).filter(
    (a) => a.technician && a.technician.id === Number(req.params.technicianId)
  );
  const tech = store.getById('technicians', req.params.technicianId);
  if (!tech) return res.status(404).json({ error: 'Technician not found' });

  const { ordered, routed, missingCount } = routeOrder(appts);

  let text = `Hi ${tech.name}, here's your Clear Water schedule for ${req.params.date}`;
  text += routed ? ' (in efficient route order from the shop):\n\n' : ':\n\n';
  if (ordered.length === 0) {
    text += 'No appointments scheduled today.';
  } else {
    ordered.forEach((a, i) => {
      text += `${i + 1}. ${a.startTime}${a.endTime ? '-' + a.endTime : ''} — ${a.customer ? a.customer.name : 'Unknown'} (${a.serviceType})\n`;
      if (a.customer && a.customer.address) text += `   ${a.customer.address}\n`;
      if (a.customer && a.customer.phone) text += `   ${a.customer.phone}\n`;
      if (a.notes) text += `   Note: ${a.notes}\n`;
    });
    if (routed && missingCount > 0) {
      text += `\n(${missingCount} stop${missingCount === 1 ? '' : 's'} listed last — no map location on file yet; use "Geocode all addresses" in the admin Customers tab.)`;
    }
    if (!routed) {
      text += `\n(Listed by appointment time — set a shop address and geocode customer addresses in Settings to get route-ordered stops.)`;
    }
  }
  res.json({ technician: sanitizeTechnician(tech), text });
});

// Plain-text confirmation message ready to send to a customer for a specific appointment
router.get('/appointment/:appointmentId/customer-text', (req, res) => {
  const appt = store.getById('appointments', req.params.appointmentId);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  const customer = store.getById('customers', appt.customerId);
  const technician = appt.technicianId ? store.getById('technicians', appt.technicianId) : null;
  const text = `Hi ${customer ? customer.name : ''}, this is Clear Water Spa Service confirming your ${appt.serviceType} appointment on ${appt.date} at ${appt.startTime}${technician ? ' with ' + technician.name : ''}. Reply if you need to reschedule. Thank you!`;
  res.json({ customer: sanitizeCustomer(customer), appointment: appt, text });
});

module.exports = router;
