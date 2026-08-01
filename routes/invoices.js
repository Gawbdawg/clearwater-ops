const express = require('express');
const store = require('../lib/store');
const router = express.Router();

function enrich(inv) {
  if (inv.ownerId) {
    const owner = store.getById('owners', inv.ownerId);
    const propertyCount = new Set((inv.lineItems || []).map((li) => li.customerId)).size;
    return {
      ...inv,
      customerName: `${owner ? owner.name : 'Unknown owner'} — ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}`,
      isCombined: true,
    };
  }
  const customer = store.getById('customers', inv.customerId);
  return { ...inv, customerName: customer ? customer.name : 'Unknown customer' };
}

router.get('/', (req, res) => {
  let invoices = store.getAll('invoices');
  if (req.query.status) invoices = invoices.filter((i) => i.status === req.query.status);
  if (req.query.customerId) invoices = invoices.filter((i) => i.customerId === Number(req.query.customerId));
  invoices = invoices.sort((a, b) => (b.issuedDate || '').localeCompare(a.issuedDate || ''));
  res.json(invoices.map(enrich));
});

router.post('/', (req, res) => {
  const { customerId, appointmentId, amount, issuedDate, dueDate, notes, status } = req.body;
  if (!customerId || amount === undefined) {
    return res.status(400).json({ error: 'customerId and amount are required' });
  }
  const invoice = store.create('invoices', {
    customerId: Number(customerId),
    appointmentId: appointmentId ? Number(appointmentId) : null,
    amount: Number(amount),
    issuedDate: issuedDate || new Date().toISOString().slice(0, 10),
    dueDate: dueDate || '',
    status: status || 'draft',
    notes: notes || '',
  });
  res.status(201).json(enrich(invoice));
});

router.put('/:id', (req, res) => {
  const updates = { ...req.body };
  if (updates.amount !== undefined) updates.amount = Number(updates.amount);
  const updated = store.update('invoices', req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Invoice not found' });
  res.json(enrich(updated));
});

router.delete('/:id', (req, res) => {
  const ok = store.remove('invoices', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Invoice not found' });
  res.status(204).end();
});

module.exports = router;
