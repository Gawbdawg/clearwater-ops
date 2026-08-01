const store = require('./store');

// Resolves what a given service should cost for a given customer: the customer's owner's
// custom price for that service if one is set, otherwise the service's catalog default.
function resolvePrice(service, customerId) {
  const customer = customerId ? store.getById('customers', customerId) : null;
  const owner = customer && customer.ownerId ? store.getById('owners', customer.ownerId) : null;
  const custom = owner && owner.customPricing ? owner.customPricing[String(service.id)] : undefined;
  return { price: custom !== undefined ? custom : service.defaultPrice, isCustom: custom !== undefined };
}

// If a completed appointment is linked to a catalog service with a resolvable price
// (custom owner price or catalog default), and doesn't already have an invoice,
// auto-creates a draft invoice at that price. Safe to call any time an appointment's
// status changes — it only acts when the conditions are met and never creates a
// duplicate (checked by appointmentId).
function maybeCreateInvoiceForCompletedAppointment(appt) {
  if (!appt || appt.status !== 'completed' || !appt.serviceId) return null;
  const service = store.getById('services', appt.serviceId);
  if (!service) return null;
  // Owners on monthly combined billing get bundled into one invoice at month end
  // instead — see lib/monthlyInvoice.js — so skip the usual per-job auto-invoice here.
  const customer = store.getById('customers', appt.customerId);
  const owner = customer && customer.ownerId ? store.getById('owners', customer.ownerId) : null;
  if (owner && owner.billingMode === 'monthly') return null;
  const { price, isCustom } = resolvePrice(service, appt.customerId);
  if (!price) return null;
  const existing = store.getAll('invoices').find((i) => i.appointmentId === appt.id);
  if (existing) return null;
  return store.create('invoices', {
    customerId: appt.customerId,
    appointmentId: appt.id,
    amount: price,
    issuedDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    status: 'draft',
    notes: `Auto-generated from completed appointment (${service.name}${isCustom ? ', owner price' : ''}).`,
  });
}

module.exports = { maybeCreateInvoiceForCompletedAppointment, resolvePrice };
