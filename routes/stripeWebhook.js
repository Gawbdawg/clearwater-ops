// Handles Stripe's webhook callbacks — specifically checkout.session.completed, which is
// how we find out a customer actually paid so the invoice can flip to "paid" automatically.
// Mounted in server.js with express.raw() (not the global JSON parser) because signature
// verification needs the exact, untouched request body bytes.
const store = require('../lib/store');
const stripe = require('../lib/stripeClient');

module.exports = function stripeWebhookHandler(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('Received a Stripe webhook but STRIPE_WEBHOOK_SECRET is not set — ignoring it.');
    return res.status(501).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    stripe.verifyWebhookSignature(req.body, req.headers['stripe-signature'], secret);
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const invoiceId = session.client_reference_id || (session.metadata && session.metadata.invoiceId);
    if (invoiceId) {
      const invoice = store.getById('invoices', invoiceId);
      if (invoice && invoice.status !== 'paid') {
        store.update('invoices', invoiceId, {
          status: 'paid',
          stripeSessionId: session.id,
          paidAt: new Date().toISOString(),
        });
        console.log(`Invoice #${invoiceId} marked paid via Stripe (session ${session.id}).`);
      }
    } else {
      console.warn('Stripe checkout.session.completed had no invoice reference — ignoring.');
    }
  }

  res.json({ received: true });
};
