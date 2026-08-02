const express = require('express');
const store = require('../lib/store');
const { checkPassword, sanitizeOwner, requireAdminAuth } = require('../lib/auth');
const { requestLoginCode, verifyLoginCode } = require('../lib/emailLogin');
const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const owner = store.getAll('owners').find(
    (o) => (o.username || '').toLowerCase() === String(username).toLowerCase()
  );
  if (!owner || !checkPassword(password, owner.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  req.session.ownerId = owner.id;
  res.json(sanitizeOwner(owner));
});

// ---- Email + code login (no password needed — most owner accounts are bulk-created
// from a contact list and never had one set) ----

router.post('/request-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });
  try {
    await requestLoginCode('owners', email, { subjectPrefix: 'Clear Water Spa Service', greetingName: 'there' });
  } catch (err) {
    // Swallow send failures into the same generic response — see note below — but log
    // server-side so a broken email config (e.g. GMAIL_APP_PASSWORD not set) is visible.
    console.error('Failed to send owner login code:', err.message);
  }
  // Always the same response whether or not the email matched an account, and whether
  // or not sending actually succeeded — never reveals which emails are registered.
  res.json({ sent: true, message: "If that email is on file, we've sent a login code to it." });
});

router.post('/verify-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
  const owner = verifyLoginCode('owners', email, code);
  if (!owner) return res.status(401).json({ error: 'That code is incorrect or has expired — request a new one.' });
  req.session.ownerId = owner.id;
  res.json(sanitizeOwner(owner));
});

// Lets a logged-in admin jump straight into an owner's portal view without
// needing that owner's password.
router.post('/admin-view/:id', requireAdminAuth, (req, res) => {
  const owner = store.getById('owners', req.params.id);
  if (!owner) return res.status(404).json({ error: 'Owner not found' });
  req.session.ownerId = owner.id;
  res.json(sanitizeOwner(owner));
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.status(204).end();
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.ownerId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const owner = store.getById('owners', req.session.ownerId);
  if (!owner) {
    req.session = null;
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json(sanitizeOwner(owner));
});

module.exports = router;
