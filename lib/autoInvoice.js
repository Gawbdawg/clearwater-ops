const store = require('./store');

// Maps a customer's saved service frequency to a frequency-priced service's rate card.
// "every4weeks" is what customers call "monthly" service — the label shown throughout
// the UI is "Monthly" even though the field name stuck with the original wording.
const FREQUENCY_TIER_KEY = { weekly: 'weekly', biweekly: 'biweekly', every4weeks: 'every4weeks' };
const FREQUENCY_TIER_LABEL = { weekly: 'weekly rate', biweekly: 'biweekly rate', every4weeks: 'monthly rate' };

// Resolves what a given service should cost for a given customer, checked in order:
//   1. The customer's owner's custom price for that specific service, if one is set.
//   2. If the service is priced "by frequency," the rate for the customer's saved
//      service frequency (weekly/biweekly/monthly), or the flat vacation-rental rate
//      for vacation-type customers — falling back to the service's flat default price
//      if no matching tier rate has been set.
//   3. The service's flat catalog default price.
function resolvePrice(service, customerId) {
  const customer = customerId ? store.getById('customers', customerId) : null;
  const owner = customer && customer.ownerId ? store.getById('owners', customer.ownerId) : null;
  const custom = owner && owner.customPricing ? owner.customPricing[String(service.id)] : undefined;
  if (custom !== undefined) {
    return { price: custom, isCustom: true, tierLabel: null };
  }

  if (service.pricingMode === 'frequency' && customer) {
    const rates = service.frequencyPrices || {};
    if (customer.type === 'vacation') {
      if (rates.vacationFlat !== undefined) {
        return { price: rates.vacationFlat, isCustom: false, tierLabel: 'vacation rental rate' };
      }
    } else {
      const tierKey = FREQUENCY_TIER_KEY[customer.serviceFrequency];
      if (tierKey && rates[tierKey] !== undefined) {
        return { price: rates[tierKey], isCustom: false, tierLabel: FREQUENCY_TIER_LABEL[tierKey] };
      }
    }
  }

  return { price: service.defaultPrice, isCustom: false, tierLabel: null };
}

// Previews what each frequency tier would cost for a given owner, without needing an
// actual customer/serviceFrequency set yet — used by the owner portal's self-service
// "set up my regular service" flow so someone can see the price before picking a
// frequency. If the owner has a custom price set for this service, that single flat
// rate applies no matter which frequency they pick (frequency then just controls how
// often visits happen, not what they cost).
function previewFrequencyPricing(service, ownerId) {
  const owner = ownerId ? store.getById('owners', ownerId) : null;
  const custom = owner && owner.customPricing ? owner.customPricing[String(service.id)] : undefined;
  if (custom !== undefined) {
    return { isCustom: true, customPrice: custom };
  }
  const rates = service.frequencyPrices || {};
  return {
    isCustom: false,
    weekly: rates.weekly !== undefined ? rates.weekly : service.defaultPrice,
    biweekly: rates.biweekly !== undefined ? rates.biweekly : service.defaultPrice,
    every4weeks: rates.every4weeks !== undefined ? rates.every4weeks : service.defaultPrice,
  };
}

// Sums up any technician-added upcharges (e.g. grill cleaning, window spray) attached
// to an appointment. Each entry is a price snapshot taken when the tech added it, so
// later catalog price changes never retroactively change an already-billed job.
function addonsTotal(appt) {
  return (appt.addons || []).reduce((sum, a) => sum + (Number(a.price) || 0), 0);
}

function addonsNote(appt) {
  if (!appt.addons || appt.addons.length === 0) return '';
  return ' + ' + appt.addons.map((a) => `${a.name} ($${Number(a.price).toFixed(2)})`).join(', ');
}

// Shared by both the initial auto-invoice and the later re-sync below: works out what
// a completed appointment should bill for, or null if it can't be priced/shouldn't be
// auto-invoiced at all (no service, no matching catalog entry, or the owner is on
// monthly combined billing instead — see lib/monthlyInvoice.js).
function computeBillFor(appt) {
  if (!appt || !appt.serviceId) return null;
  const service = store.getById('services', appt.serviceId);
  if (!service) return null;
  const customer = store.getById('customers', appt.customerId);
  const owner = customer && customer.ownerId ? store.getById('owners', customer.ownerId) : null;
  if (owner && owner.billingMode === 'monthly') return null;
  const { price, isCustom, tierLabel } = resolvePrice(service, appt.customerId);
  const extras = addonsTotal(appt);
  const total = (Number(price) || 0) + extras;
  const priceNote = isCustom ? ', owner price' : (tierLabel ? `, ${tierLabel}` : '');
  const notes = `Auto-generated from completed appointment (${service.name}${priceNote})${addonsNote(appt)}.`;
  return { total, notes };
}

// If a completed appointment is linked to a catalog service with a resolvable price
// (custom owner price, frequency rate, or catalog default) — plus any technician-added
// upcharges — and doesn't already have an invoice, auto-creates a draft invoice at that
// total. Safe to call any time an appointment's status changes — it only acts when the
// conditions are met and never creates a duplicate (checked by appointmentId).
function maybeCreateInvoiceForCompletedAppointment(appt) {
  if (!appt || appt.status !== 'completed') return null;
  const bill = computeBillFor(appt);
  if (!bill || !bill.total) return null;
  const existing = store.getAll('invoices').find((i) => i.appointmentId === appt.id);
  if (existing) return null;
  return store.create('invoices', {
    customerId: appt.customerId,
    appointmentId: appt.id,
    amount: bill.total,
    issuedDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    status: 'draft',
    notes: bill.notes,
  });
}

// A tech (or, pre-completion, an owner) can add or remove an upcharge on a job that's
// already been marked complete — e.g. remembering "oh, I also cleaned the grill" right
// after tapping complete. That auto-invoice was already created at the old total, and
// nothing else re-computes it. This brings a still-draft invoice's amount back in sync
// with the job's current addons. Invoices that have already been sent or paid are left
// alone on purpose — once an owner's seen a number, changing it silently would be
// confusing; the admin can adjust it by hand from here if that ever needs to happen.
function syncInvoiceForCompletedAppointment(appt) {
  if (!appt || appt.status !== 'completed') return null;
  const existing = store.getAll('invoices').find((i) => i.appointmentId === appt.id);
  if (!existing) return maybeCreateInvoiceForCompletedAppointment(appt);
  if (existing.status !== 'draft') return null;
  const bill = computeBillFor(appt);
  if (!bill) return null;
  if (bill.total === existing.amount) return null;
  return store.update('invoices', existing.id, { amount: bill.total, notes: bill.notes });
}

// Cancellation policy: cancelling a scheduled visit less than 24 hours out bills half
// of what that visit would have cost — same price resolution as a completed job
// (custom owner price, frequency tier, or catalog default), but not counting any
// upcharges since the tech never actually came out. No-ops if there's no priceable
// service on the appointment, or if an invoice already exists for it (so this is safe
// to call even if something upstream double-fires it).
function maybeCreateCancellationFeeInvoice(appt) {
  if (!appt || !appt.serviceId) return null;
  const service = store.getById('services', appt.serviceId);
  if (!service) return null;
  const { price } = resolvePrice(service, appt.customerId);
  const fee = (Number(price) || 0) / 2;
  if (!fee) return null;
  const existing = store.getAll('invoices').find((i) => i.appointmentId === appt.id);
  if (existing) return null;
  return store.create('invoices', {
    customerId: appt.customerId,
    appointmentId: appt.id,
    amount: fee,
    issuedDate: new Date().toISOString().slice(0, 10),
    dueDate: '',
    status: 'draft',
    notes: `Cancellation fee — visit cancelled within 24 hours of its scheduled time (50% of ${service.name}).`,
  });
}

module.exports = {
  maybeCreateInvoiceForCompletedAppointment,
  maybeCreateCancellationFeeInvoice,
  syncInvoiceForCompletedAppointment,
  resolvePrice,
  previewFrequencyPricing,
  addonsTotal,
  addonsNote,
};
