const express = require('express');
const db = require('../../db');
const { getSkillTrivial, parseItemInput, validateWikiItem } = require('../../wikiScraper');
const { requireAuthOrToken, requireOfficer } = require('../auth');

/**
 * Work orders are the connective tissue between Apprentice and the guild.
 * Apprentice gets no special-cased endpoints here: it authenticates with a
 * personal API token instead of a session cookie, but from this point on
 * it's just another caller of the exact same routes the website uses —
 * POST here to flag an item it can't craft/gather itself, then poll GET
 * (with ?mine=true) on its own schedule to see whether that order has
 * moved to 'claimed' yet. There is no separate Apprentice-only work-order
 * API surface, deliberately: identity comes from req.user regardless of
 * which auth method produced it (see requireAuthOrToken in ../auth), so
 * ownership/permission rules are identical no matter who's calling.
 *
 * Lifecycle: unclaimed -> claimed -> complete -> delivered (auto-deleted
 * 24h after delivery, see db.cleanupDeliveredWorkOrders) or -> cancelled
 * (only while still unclaimed/claimed).
 */
function buildRouter() {
  const router = express.Router();
  router.use(requireAuthOrToken);

  router.get('/work-orders', (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      // ?mine=true scopes to orders THIS caller requested — what Apprentice's
      // hourly "did anyone claim it yet" check uses, so it isn't polling
      // every guild member's orders just to find its own.
      const mine = req.query.mine === 'true' || req.query.mine === '1';
      res.json({ orders: db.getAllWorkOrders(status, mine ? req.user.id : null) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/work-orders', async (req, res) => {
    try {
      const { itemName: rawItemName, quantity, sourceType, requesterCharacter, notes } = req.body;
      if (!rawItemName) {
        return res.status(400).json({ error: 'itemName is required' });
      }

      // Validate + canonicalize against eqlwiki.com — same check /api/gear/add
      // already does for the gear bank, now applied here too so a work order
      // can't be posted for a misspelled or nonexistent item. This also
      // normalizes casing (whatever the caller typed gets replaced with the
      // wiki's own title), which is what a client-side autocomplete (the
      // website's item-name field, or /g-addwork's Discord autocomplete)
      // is for — this server-side check is the hard backstop for anyone
      // (Apprentice included) who bypasses that and posts free-text.
      const { baseItemName } = parseItemInput(rawItemName);
      const { isValid, canonicalName } = await validateWikiItem(baseItemName || rawItemName);
      if (!isValid) {
        return res.status(404).json({
          error: `Could not validate "${baseItemName || rawItemName}" on eqlwiki.com. Please check spelling.`
        });
      }
      const itemName = canonicalName || baseItemName || rawItemName;

      // Skill + trivial always come from the item's recorded player-crafted
      // recipe on eqlwiki.com — same as /g-addwork in Discord. No caller
      // (website form, Apprentice, a raw API request) can set these itself
      // any more; there's one source of truth instead of one per client.
      const trivialInfo = await getSkillTrivial(itemName);

      const order = db.createWorkOrder({
        itemName,
        quantity: quantity || 1,
        skillRequired: trivialInfo?.tradeskill || 'Crafting',
        skillLevelRequired: trivialInfo?.trivialLevel ?? null,
        sourceType: sourceType || 'crafted',
        requesterCharacter: requesterCharacter || req.user.displayName,
        requesterDiscordId: req.user.id,
        requesterDiscordName: req.user.displayName,
        notes: notes || null
      });

      res.json({ success: true, order });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/work-orders/:id/claim', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const order = db.getWorkOrderById(id);
      if (!order) {
        return res.status(404).json({ error: 'Work order not found' });
      }
      if (order.status !== 'unclaimed') {
        return res.status(400).json({ error: `Order is already ${order.status}` });
      }
      if (order.requester_discord_id === req.user.id) {
        return res.status(400).json({ error: 'You cannot claim your own work order' });
      }

      db.claimWorkOrder(id, req.user.id, req.user.displayName);
      res.json({ success: true, order: db.getWorkOrderById(id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/work-orders/:id/complete', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const order = db.getWorkOrderById(id);
      if (!order) {
        return res.status(404).json({ error: 'Work order not found' });
      }
      const isCrafter = order.claimed_by_discord_id === req.user.id;
      const isRequester = order.requester_discord_id === req.user.id;
      if (!isCrafter && !isRequester && !req.user.isOfficer) {
        return res.status(403).json({ error: 'Only the crafter, requester, or an officer can mark this complete' });
      }
      if (order.status !== 'claimed') {
        return res.status(400).json({ error: `Order must be claimed first (currently ${order.status})` });
      }

      db.completeWorkOrder(id);
      res.json({ success: true, order: db.getWorkOrderById(id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/work-orders/:id/deliver', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const order = db.getWorkOrderById(id);
      if (!order) {
        return res.status(404).json({ error: 'Work order not found' });
      }
      const isCrafter = order.claimed_by_discord_id === req.user.id;
      const isRequester = order.requester_discord_id === req.user.id;
      if (!isCrafter && !isRequester && !req.user.isOfficer) {
        return res.status(403).json({ error: 'Only the crafter, requester, or an officer can mark this delivered' });
      }
      if (order.status !== 'complete') {
        return res.status(400).json({ error: `Order must be marked complete first (currently ${order.status})` });
      }

      db.deliverWorkOrder(id);
      res.json({ success: true, order: db.getWorkOrderById(id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/work-orders/:id/cancel', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const order = db.getWorkOrderById(id);
      if (!order) {
        return res.status(404).json({ error: 'Work order not found' });
      }
      if (order.requester_discord_id !== req.user.id && !req.user.isOfficer) {
        return res.status(403).json({ error: 'Only the requester or an officer can cancel this order' });
      }
      if (order.status !== 'unclaimed' && order.status !== 'claimed') {
        return res.status(400).json({ error: `Order can no longer be cancelled (currently ${order.status})` });
      }

      db.cancelWorkOrder(id);
      res.json({ success: true, order: db.getWorkOrderById(id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/work-orders/:id', requireOfficer, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      db.deleteWorkOrder(id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = buildRouter;
