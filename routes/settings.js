const express = require('express');
const store = require('../lib/store');
const { geocodeAddress } = require('../lib/geocode');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(store.getSettings());
});

router.put('/', (req, res) => {
  const { depotAddress } = req.body;
  const updates = { depotAddress };
  // Address changed — clear cached coordinates so it gets re-geocoded
  updates.depotLat = null;
  updates.depotLng = null;
  res.json(store.updateSettings(updates));
});

router.post('/geocode-depot', async (req, res) => {
  const settings = store.getSettings();
  try {
    const { lat, lng } = await geocodeAddress(settings.depotAddress);
    res.json(store.updateSettings({ depotLat: lat, depotLng: lng }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
