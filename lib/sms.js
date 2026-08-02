// Sends a text message via Twilio's REST API directly (no SDK dependency needed — it's
// just one HTTP call). Falls back to a console "dry run" preview if TWILIO_ACCOUNT_SID /
// TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER aren't set, the same pattern as lib/mailer.js for
// email, so this works out of the box before a Twilio account exists.

// Converts a loosely-formatted US phone number ("555-123-4567", "(555) 123 4567", etc.)
// into the E.164 format Twilio requires ("+15551234567"). Returns null if it doesn't look
// like a valid 10-digit US number.
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function sendSms({ to, body }) {
  const toNumber = normalizePhone(to);
  if (!toNumber) {
    throw new Error(`"${to}" doesn't look like a valid US phone number`);
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.log(`\n[SMS DRY RUN — Twilio not configured] Would text ${toNumber}:\n${body}\n--- end of text ---\n`);
    return { dryRun: true };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({ To: toNumber, From: TWILIO_FROM_NUMBER, Body: body });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Twilio request failed: ${res.status}`);
  }
  return { sid: data.sid };
}

function isTwilioConfigured() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
}

// Common US carrier email-to-SMS gateways — sending a plain email to
// "<10-digit-number>@<gateway domain>" gets delivered to that phone as a text message.
// Free (rides on whatever email sending is already configured, see lib/mailer.js) and
// needs no third-party SMS account, but it's not as reliable as real SMS (some carriers
// throttle these or occasionally drop them) — a fine free option for texting one known
// phone (e.g. a technician texting their own route to themselves), not a real
// replacement for Twilio at customer-facing volume. Prepaid/MVNO brands are grouped
// under whichever major network they actually run on.
const CARRIER_GATEWAYS = {
  verizon: 'vtext.com',
  att: 'txt.att.net',
  tmobile: 'tmomail.net',
  sprint: 'messaging.sprintpcs.com',
  uscellular: 'email.uscc.net',
  boost: 'sms.myboostmobile.com',
  cricket: 'sms.cricketwireless.net',
  metropcs: 'mymetropcs.com',
  googlefi: 'msg.fi.google.com',
  visible: 'vtext.com', // runs on Verizon's network
  straighttalk: 'vtext.com', // most Straight Talk lines run on Verizon's network
  mint: 'tmomail.net', // runs on T-Mobile's network
};

// Returns "<digits>@<gateway>" for a known carrier, or null if the phone doesn't look
// valid or the carrier isn't one we have a gateway domain for.
function carrierGatewayAddress(phone, carrier) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const domain = CARRIER_GATEWAYS[carrier];
  if (!domain) return null;
  return `${normalized.replace(/^\+1/, '')}@${domain}`;
}

module.exports = { sendSms, normalizePhone, isTwilioConfigured, CARRIER_GATEWAYS, carrierGatewayAddress };
