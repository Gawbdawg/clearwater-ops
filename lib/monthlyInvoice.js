const store = require('./store');
const { resolvePrice, addonsTotal, addonsNote } = require('./autoInvoice');

// Every appointmentId already billed anywhere — either as its own invoice, or as a line
// item inside a previous combined invoice — so a job never gets billed twice no matter
// how many times a monthly invoice gets (re-)generated.
function billedAppointmentIds() {
  const ids = new Set();
  store.getAll('invoices').forEach((inv) => {
    if (inv.appointmentId) ids.add(inv.appointmentId);
    (inv.lineItems || []).forEach((li) => ids.add(li.appointmentId));
  });
  return ids;
}

// Bundles every completed, not-yet-billed, service-linked appointment for one owner's
// properties within a given month (YYYY-MM) into a single draft invoice. Returns null
// if there's nothing to bill. Each line item's price is resolved the same way a single
// auto-invoice would be (owner custom price, falling back to the catalog default).
function generateMonthlyInvoiceForOwner(ownerId, monthStr) {
  const owner = store.getById('owners', ownerId);
  if (!owner) throw new Error('Owner not found');
  if (!/^\d{4}-\d{2}$/.test(monthStr || '')) throw new Error('month must be in YYYY-MM format');

  const propertyIds = store.getAll('customers')
    .filter((c) => c.ownerId === Number(ownerId))
    .map((c) => c.id);
  if (propertyIds.length === 0) throw new Error('This owner has no linked properties');

  const already = billedAppointmentIds();
  const services = store.getAll('services');

  const appts = store.getAll('appointments').filter((a) => (
    propertyIds.includes(a.customerId)
    && a.status === 'completed'
    && a.serviceId
    && a.date.startsWith(monthStr)
    && !already.has(a.id)
  ));

  const lineItems = [];
  appts.forEach((a) => {
    const service = services.find((s) => s.id === a.serviceId);
    if (!service) return;
    const { price } = resolvePrice(service, a.customerId);
    const extras = addonsTotal(a);
    const amount = (Number(price) || 0) + extras;
    if (!amount) return;
    const customer = store.getById('customers', a.customerId);
    lineItems.push({
      appointmentId: a.id,
      customerId: a.customerId,
      customerName: customer ? customer.name : 'Unknown property',
      serviceType: `${a.serviceType || service.name}${addonsNote(a)}`,
      date: a.date,
      amount,
    });
  });

  if (lineItems.length === 0) return null;

  const total = lineItems.reduce((sum, li) => sum + Number(li.amount), 0);
  const propertyCount = new Set(lineItems.map((li) => li.customerId)).size;

  return store.create('invoices', {
    customerId: null,
    ownerId: Number(ownerId),
    appointmentId: null,
    amount: total,
    issuedDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    status: 'draft',
    notes: `Combined monthly invoice for ${owner.name} — ${monthStr} (${lineItems.length} job${lineItems.length === 1 ? '' : 's'} across ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}).`,
    lineItems,
  });
}

module.exports = { generateMonthlyInvoiceForOwner };
