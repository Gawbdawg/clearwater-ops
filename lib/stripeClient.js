// Talks to Stripe's REST API directly over fetch (no SDK dependency needed) to create
// Checkout Sessions for invoice payments, and to verify webhook signatures so we can trust
// "this invoice was actually paid" events. Same "gracefully do nothing if not configured"
// philosophy as lib/mailer.js and lib/sms.js — the app works fine before a Stripe account
// exists, it just won't offer online payment yet.

const crypto = require('crypto');

const STRIPE_API = 'https://api.stripe.com/v1';

function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

async function createCheckoutSession({ invoiceId, amountCents, description, successUrl, cancelUrl }) {
  if (!isConfigured()) {
    throw new Error("Online payments aren't turned on yet.");
  }
  if (!amountCents || amountCents < 50) {
    // Stripe rejects charges below ~$0.50
    throw new Error('Invoice amount is too small to charge online (minimum $0.50).');
  }

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  params.append('client_reference_id', String(invoiceId));
  params.append('metadata[invoiceId]', String(invoiceId));
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', 'usd');
  params.append('line_items[0][price_data][unit_amount]', String(amountCents));
  params.append('line_items[0][price_data][product_data][name]', description);

  const auth = Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString('base64');
  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data.error && data.error.message) || `Stripe request failed: ${res.status}`);
  }
  return data; // { id, url, ... }
}

// Verifies the Stripe-Signature header against the raw request body using the endpoint's
// webhook signing secret — this is Stripe's documented scheme (HMAC-SHA256 over
// "{timestamp}.{rawBody}"), reimplemented here without the Stripe SDK. rawBody must be the
// unparsed request body (a Buffer or string), not the JSON-parsed object.
function verifyWebhookSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header');
  let timestamp = null;
  const signatures = [];
  signatureHeader.split(',').forEach((part) => {
    const [key, value] = part.trim().split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value);
  });
  if (!timestamp || signatures.length === 0) throw new Error('Malformed Stripe-Signature header');

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');

  const matches = signatures.some((sig) => {
    try {
      return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (e) {
      return false;
    }
  });
  if (!matches) throw new Error('Signature verification failed');

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > toleranceSeconds) throw new Error('Webhook timestamp too old (possible replay)');
}

module.exports = { isConfigured, createCheckoutSession, verifyWebhookSignature };
