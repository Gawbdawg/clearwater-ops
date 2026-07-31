const express = require('express');
const store = require('../lib/store');
const { sendSms } = require('../lib/sms');
const router = express.Router();

function enrich(appt) {
  const customer = store.getById('customers', appt.customerId);
  const technician = appt.technicianId ? store.getById('technicians', appt.technicianId) : null;
  return {
    ...appt,
    customerName: customer ? customer.name : 'Unknown customer',
    customerPhone: customer ? customer.phone : '',
    customerAddress: customer ? customer.address : '',
    lat: customer ? customer.lat : undefined,
    lng: customer ? customer.lng : undefined,
    technicianName: technician ? technician.name : 'Unassigned',
  };
}

router.get('/', (req, res) => {
  let appts = store.getAll('appointments');
  if (req.query.date) appts = appts.filter((a) => a.date === req.query.date);
  if (req.query.technicianId) appts = appts.filter((a) => a.technicianId === Number(req.query.technicianId));
  if (req.query.customerId) appts = appts.filter((a) => a.customerId === Number(req.query.customerId));
  appts = appts.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  res.json(appts.map(enrich));
});

router.get('/:id', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  res.json(enrich(appt));
});

// ---- Recurrence helpers ----
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d;
}

// Adds n calendar months, clamping to the last day of the target month
// (e.g. Jan 31 + 1 month -> Feb 28, not a rollover into March).
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  const targetMonth = d.getMonth() + n;
  const candidate = new Date(d.getFullYear(), targetMonth, d.getDate());
  if (candidate.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    // Rolled over — clamp to the last day of the intended month
    return new Date(d.getFullYear(), targetMonth + 1, 0);
  }
  return candidate;
}

function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const MAX_OCCURRENCES = 52;

// Generates the future dates for a recurring series, starting from (and excluding)
// the first occurrence's date, up to recurrenceEndDate or 6 months out (whichever
// comes first), capped at MAX_OCCURRENCES total to avoid runaway generation.
function futureDates(startDate, frequency, recurrenceEndDate) {
  const defaultEnd = fmt(addMonths(startDate, 6));
  const endDate = recurrenceEndDate && recurrenceEndDate < defaultEnd ? recurrenceEndDate : defaultEnd;
  const dates = [];
  let cursor = startDate;
  while (dates.length < MAX_OCCURRENCES - 1) {
    const next = frequency === 'weekly' ? addDays(cursor, 7)
      : frequency === 'biweekly' ? addDays(cursor, 14)
      : addMonths(cursor, 1); // monthly
    const nextStr = fmt(next);
    if (nextStr > endDate) break;
    dates.push(nextStr);
    cursor = nextStr;
  }
  return dates;
}

router.post('/', (req, res) => {
  const {
    customerId, technicianId, date, startTime, endTime, serviceType, status, notes,
    chlorine, ph, alkalinity, recurrence, recurrenceEndDate,
  } = req.body;
  if (!customerId || !date || !startTime) {
    return res.status(400).json({ error: 'customerId, date, and startTime are required' });
  }
  const base = {
    customerId: Number(customerId),
    technicianId: technicianId ? Number(technicianId) : null,
    startTime,
    endTime: endTime || '',
    serviceType: serviceType || 'General service',
    status: status || 'scheduled',
    notes: notes || '',
    chlorine: chlorine || '',
    ph: ph || '',
    alkalinity: alkalinity || '',
  };

  const first = store.create('appointments', { ...base, date, seriesId: null });

  if (recurrence && recurrence !== 'none') {
    store.update('appointments', first.id, { seriesId: first.id });
    futureDates(date, recurrence, recurrenceEndDate).forEach((d) => {
      store.create('appointments', { ...base, date: d, seriesId: first.id, status: 'scheduled' });
    });
  }

  res.status(201).json(enrich(store.getById('appointments', first.id)));
});

router.put('/:id', (req, res) => {
  const updates = { ...req.body };
  delete updates.recurrence;
  delete updates.recurrenceEndDate;
  if (updates.customerId) updates.customerId = Number(updates.customerId);
  if (updates.technicianId) updates.technicianId = Number(updates.technicianId);
  const updated = store.update('appointments', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Appointment not found' });
  res.json(enrich(updated));
});

router.delete('/:id', (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  if (req.query.scope === 'series' && appt.seriesId) {
    const toRemove = store.getAll('appointments')
      .filter((a) => a.seriesId === appt.seriesId && a.date >= appt.date);
    toRemove.forEach((a) => store.remove('appointments', a.id));
    return res.status(204).end();
  }

  store.remove('appointments', req.params.id);
  res.status(204).end();
});

function niceDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

// Manually send (or re-send) a text reminder for one appointment — mainly so this can be
// tested/used before a Twilio account is set up (see lib/sms.js DRY RUN mode) and so an
// admin can nudge one customer without waiting for the daily cron job.
router.post('/:id/send-reminder', async (req, res) => {
  const appt = store.getById('appointments', req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  const customer = store.getById('customers', appt.customerId);
  if (!customer || !customer.phone) {
    return res.status(400).json({ error: 'This customer has no phone number on file' });
  }
  const body = `Hi ${customer.name}, this is Clear Water Spa Service — reminder that we have you scheduled for ` +
    `${appt.serviceType || 'a visit'} on ${niceDate(appt.date)} around ${appt.startTime}. ` +
    `Reply to this number if you need to reschedule.`;
  try {
    const result = await sendSms({ to: customer.phone, body });
    const updated = store.update('appointments', req.params.id, { reminderSentAt: new Date().toISOString() });
    res.json({ ...enrich(updated), smsDryRun: !!result.dryRun });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
