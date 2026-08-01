const express = require('express');
const store = require('../lib/store');
const { checkPassword, sanitizeOwner, requireAdminAuth } = require('../lib/auth');
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
