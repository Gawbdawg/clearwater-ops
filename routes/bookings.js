const express = require('express');
const store = require('../lib/store');
const { syncAllCalendars } = require('../lib/icalSync');
const router = express.Router();

// Admin action: re-fetch every vacation customer's iCal feed and refresh their bookings
router.post('/sync-all', async (req, res) => {
  const results = await syncAllCalendars();
  res.json({ results });
});

// Admin view: all owners' occupied/guest-booking date ranges
router.get('/', (req, res) => {
  let bookings = store.getAll('bookings');
  if (req.query.customerId) bookings = bookings.filter((b) => b.customerId === Number(req.query.customerId));
  bookings = bookings
    .map((b) => {
      const customer = store.getById('customers', b.customerId);
      return { ...b, customerName: customer ? customer.name : 'Unknown' };
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  res.json(bookings);
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('bookings', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Booking not found' });
  res.status(204).end();
});

module.exports = router;
