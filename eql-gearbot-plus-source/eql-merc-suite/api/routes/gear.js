const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const db = require('../../db');
const { parseItemInput, searchWikiAutocomplete, validateWikiItem } = require('../../wikiScraper');
const { parseEqInventoryText, groupInventoryItems } = require('../../inventoryParser');
const { requireAuth, requireOfficer } = require('../auth');

function isOfficerOrOwner(item, user) {
  return user.isOfficer || item.added_by_user_id === user.id;
}

function buildRouter() {
  const router = express.Router();

  // All gear routes require a verified, logged-in guild member. Identity for
  // every write comes from req.user (the server-verified session), never
  // from the request body — this is the fix for the previous attempt's
  // "anyone can claim/remove as anyone" hole.
  router.use(requireAuth);

  router.get('/gear', (req, res) => {
    try {
      res.json({ items: db.getAllGear() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/gear/add', async (req, res) => {
    try {
      const { itemName } = req.body;
      if (!itemName) {
        return res.status(400).json({ error: 'Item name is required' });
      }

      const { baseItemName, upgradeLevel } = parseItemInput(itemName);
      const { isValid, wikiUrl, canonicalName } = await validateWikiItem(baseItemName);

      if (!isValid) {
        return res.status(404).json({
          error: `Could not validate "${baseItemName}" on eqlwiki.com. Please check spelling.`
        });
      }

      const finalName = canonicalName || baseItemName;
      db.addGear(finalName, upgradeLevel || '+0', wikiUrl, req.user.id, req.user.displayName);

      const items = db.getAllGear();
      res.json({
        success: true,
        message: `Added ${finalName} ${upgradeLevel || '+0'} to inventory`,
        item: items[items.length - 1],
        items
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/gear/stock', async (req, res) => {
    try {
      const { itemName, quantity } = req.body;
      if (!itemName) {
        return res.status(400).json({ error: 'Item name is required' });
      }
      const qty = parseInt(quantity, 10);
      if (!qty || qty < 1) {
        return res.status(400).json({ error: 'Valid positive quantity is required' });
      }

      const { baseItemName } = parseItemInput(itemName);
      const { isValid, wikiUrl, canonicalName } = await validateWikiItem(baseItemName);

      if (!isValid) {
        return res.status(404).json({
          error: `Could not validate "${baseItemName}" on eqlwiki.com. Please check spelling.`
        });
      }

      const finalName = canonicalName || baseItemName;
      const quantityLevel = `x${qty}`;
      db.addGear(finalName, quantityLevel, wikiUrl, req.user.id, req.user.displayName);

      res.json({
        success: true,
        message: `Added stock ${finalName} ${quantityLevel} to inventory`,
        items: db.getAllGear()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/gear/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const item = db.getGearById(id);
      if (!item) {
        return res.status(404).json({ error: 'Item not found' });
      }
      if (!isOfficerOrOwner(item, req.user)) {
        return res.status(403).json({ error: 'Only the donor or a Guild Officer can remove this item' });
      }

      db.removeGearById(id);
      res.json({
        success: true,
        message: `Removed ${item.base_item_name} ${item.upgrade_level}. IDs compacted.`,
        items: db.getAllGear()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/gear/:id/claim', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const item = db.getGearById(id);
      if (!item) {
        return res.status(404).json({ error: 'Item not found' });
      }
      if (item.requested_by_user_id) {
        return res.status(400).json({ error: `Already claimed by ${item.requested_by_username}` });
      }
      if (item.added_by_user_id === req.user.id) {
        return res.status(400).json({ error: 'You are the donor of this item and cannot claim it' });
      }

      db.claimGear(id, req.user.id, req.user.displayName);
      res.json({
        success: true,
        message: `Claimed ${item.base_item_name} ${item.upgrade_level}`,
        items: db.getAllGear()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/gear/:id/withdraw', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const item = db.getGearById(id);
      if (!item) {
        return res.status(404).json({ error: 'Item not found' });
      }
      if (!item.requested_by_user_id) {
        return res.status(400).json({ error: 'Item is not currently claimed' });
      }
      if (item.requested_by_user_id !== req.user.id && !req.user.isOfficer) {
        return res.status(403).json({ error: 'Only the claimant or an officer can withdraw this claim' });
      }

      db.withdrawGear(id, item.requested_by_user_id);
      res.json({
        success: true,
        message: `Withdrew claim for ${item.base_item_name}`,
        items: db.getAllGear()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Wiki lookups (read-only proxies to eqlwiki.com) ----

  router.get('/wiki/autocomplete', async (req, res) => {
    try {
      const query = String(req.query.q || '');
      if (!query || query.length < 2) {
        return res.json({ suggestions: [] });
      }
      res.json({ suggestions: await searchWikiAutocomplete(query) });
    } catch (err) {
      res.status(500).json({ error: err.message, suggestions: [] });
    }
  });

  router.get('/wiki/validate', async (req, res) => {
    try {
      res.json(await validateWikiItem(String(req.query.name || '')));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/wiki/card', async (req, res) => {
    try {
      const itemName = String(req.query.name || '');
      const level = String(req.query.level || '+0');
      if (!itemName) {
        return res.status(400).json({ error: 'Item name is required' });
      }

      const { isValid, wikiUrl, canonicalName } = await validateWikiItem(itemName);
      if (!isValid || !wikiUrl) {
        return res.status(404).json({ error: `Could not find "${itemName}" on eqlwiki.com` });
      }

      const response = await axios.get(wikiUrl, {
        headers: { 'User-Agent': 'EQGearBot/2.0 (Web Companion; https://eqlwiki.com)' },
        timeout: 7000
      });

      const $ = cheerio.load(response.data);
      const wrapper = $('.ils-item-wrapper, .itemdata').first();
      if (!wrapper.length) {
        return res.status(404).json({ error: 'No item card element found on wiki page' });
      }

      wrapper.find('img').each((_, el) => {
        const src = $(el).attr('src');
        if (src && src.startsWith('/')) {
          $(el).attr('src', `https://eqlwiki.com${src}`);
        }
      });

      const itemTitle = $('.itemtitle').first().text().trim() || canonicalName || itemName;
      res.json({ success: true, canonicalName: itemTitle, wikiUrl, level, rawHtml: wrapper.html() || '' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Inventory file import (parity with /g-import) ----

  router.post('/import/parse', (req, res) => {
    try {
      const { fileContent } = req.body;
      if (!fileContent || typeof fileContent !== 'string') {
        return res.status(400).json({ error: 'File content is required' });
      }
      const parsed = parseEqInventoryText(fileContent);
      const grouped = groupInventoryItems(parsed);
      res.json({ totalLinesParsed: parsed.length, uniqueItemCount: grouped.length, items: grouped });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/import/confirm', async (req, res) => {
    try {
      const { selectedItems } = req.body;
      if (!Array.isArray(selectedItems) || selectedItems.length === 0) {
        return res.status(400).json({ error: 'No items provided for import' });
      }

      const results = { imported: [], failed: [] };

      for (const item of selectedItems) {
        try {
          const { isValid, wikiUrl, canonicalName } = await validateWikiItem(item.cleanItemName);
          if (isValid) {
            const official = canonicalName || item.cleanItemName;
            const upgrade = item.upgradeLevel || '+0';
            const exaltsJson = item.exalts && item.hasExalts ? JSON.stringify(item.exalts) : null;
            db.addGear(official, upgrade, wikiUrl, req.user.id, req.user.displayName, exaltsJson);
            const exaltBadge = item.exaltsSummary ? ` [${item.exaltsSummary}]` : '';
            results.imported.push(`${official} ${upgrade}${exaltBadge}`);
          } else {
            results.failed.push(`${item.cleanItemName} (Wiki validation failed)`);
          }
        } catch (e) {
          results.failed.push(`${item.cleanItemName} (${e.message})`);
        }
      }

      res.json({
        success: true,
        importedCount: results.imported.length,
        failedCount: results.failed.length,
        details: results,
        items: db.getAllGear()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = buildRouter;
