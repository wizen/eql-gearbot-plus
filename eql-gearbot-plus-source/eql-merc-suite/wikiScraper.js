const axios = require('axios');

/**
 * Strips +1 through +10 upgrade suffixes OR xN quantity suffixes (e.g. x2, x10, x100).
 * Items do not have both an upgrade level and a quantity.
 * When quantity is present, it takes the place of the upgrade level.
 */
function parseItemInput(input) {
  if (!input) return { baseItemName: '', upgradeLevel: '+0' };
  const trimmed = input.trim();

  // 1. Check for quantity suffix indicated by xN (e.g., "x2", "x10", "x 5", "X3")
  const qtyMatch = trimmed.match(/^(.*?)\s+[xX]\s*(\d+)$/);
  if (qtyMatch && qtyMatch[1].trim().length > 0) {
    return {
      baseItemName: qtyMatch[1].trim(),
      upgradeLevel: `x${qtyMatch[2]}`
    };
  }

  // 2. Check for upgrade suffix +1 through +10
  const plusMatch = trimmed.match(/^(.*?)\s*(\+[1-9]|\+10)$/i);
  if (plusMatch && plusMatch[1].trim().length > 0) {
    return {
      baseItemName: plusMatch[1].trim(),
      upgradeLevel: plusMatch[2].toUpperCase()
    };
  }

  return { baseItemName: trimmed, upgradeLevel: '+0' };
}

/**
 * Queries eqlwiki.com API for case-insensitive autocomplete suggestions.
 * Queries title-cased, lower-cased, upper-cased, and full-text search in parallel
 * to guarantee case-insensitive matching regardless of user input.
 */
async function searchWikiAutocomplete(query) {
  if (!query || query.trim().length < 2) return [];

  // Strip trailing partial or complete quantity / upgrade suffixes so search finds the base item
  let cleanQuery = query.trim()
    .replace(/\s+[xX]\s*\d*$/, '')
    .replace(/\s*\+(\d*)$/, '');

  const { baseItemName } = parseItemInput(cleanQuery);
  const rawTerm = (baseItemName || cleanQuery).trim();
  if (!rawTerm || rawTerm.length < 2) return [];

  const lowerTerm = rawTerm.toLowerCase();
  const words = rawTerm.split(/\s+/);
  const titleCased = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  const upperTerm = rawTerm.toUpperCase();

  // Distinct case variants to cover MediaWiki opensearch title-case indexing
  const caseVariants = Array.from(new Set([rawTerm, titleCased, lowerTerm, upperTerm]));

  const headers = {
    'User-Agent': 'EQGearBot/1.0 (Discord Gear Manager; https://eqlwiki.com)'
  };

  try {
    const fetchPromises = [
      // 1. Parallel opensearch for each case permutation
      ...caseVariants.map(variant =>
        axios.get('https://eqlwiki.com/api.php', {
          params: {
            action: 'opensearch',
            search: variant,
            limit: 15,
            format: 'json'
          },
          headers,
          timeout: 2500
        }).then(res => res.data[1] || []).catch(() => [])
      ),
      // 2. Full-text search to find mid-string or irregular-cased article titles
      axios.get('https://eqlwiki.com/api.php', {
        params: {
          action: 'query',
          list: 'search',
          srsearch: rawTerm,
          srlimit: 15,
          format: 'json'
        },
        headers,
        timeout: 2500
      }).then(res => (res.data?.query?.search || []).map(item => item.title)).catch(() => [])
    ];

    const resultsLists = await Promise.all(fetchPromises);
    const seen = new Map();

    for (const list of resultsLists) {
      for (const title of list) {
        if (!title || typeof title !== 'string') continue;
        // Exclude MediaWiki namespaces (e.g., Template:, Category:, File:, User:)
        if (title.includes(':') && !title.startsWith('10 Dose') && !title.startsWith('5 Dose')) continue;

        const lowerTitle = title.toLowerCase();
        if (!seen.has(lowerTitle)) {
          seen.set(lowerTitle, title);
        }
      }
    }

    const uniqueTitles = Array.from(seen.values());

    // Rank results: exact match > starts-with > contains, then alphabetical
    uniqueTitles.sort((a, b) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();

      const aExact = aLower === lowerTerm;
      const bExact = bLower === lowerTerm;
      if (aExact && !bExact) return -1;
      if (bExact && !aExact) return 1;

      const aStarts = aLower.startsWith(lowerTerm);
      const bStarts = bLower.startsWith(lowerTerm);
      if (aStarts && !bStarts) return -1;
      if (bStarts && !aStarts) return 1;

      return a.localeCompare(b);
    });

    return uniqueTitles.slice(0, 25);
  } catch (error) {
    console.error('Autocomplete search error:', error.message);
    return [];
  }
}

const cheerio = require('cheerio');

/**
 * Validates whether an item exists on eqlwiki.com with case-insensitive input
 * and returns the official, case-sensitive canonical item name (.canonicalName)
 * scraped from the wiki page.
 */
async function validateWikiItem(baseItemName) {
  if (!baseItemName || typeof baseItemName !== 'string') {
    return { isValid: false, wikiUrl: '', canonicalName: '' };
  }

  const trimmed = baseItemName.trim();
  const lower = trimmed.toLowerCase();
  const words = trimmed.split(/\s+/);
  const titleCased = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  const upper = trimmed.toUpperCase();

  // Try title-cased first since MediaWiki standardizes on Title Case, then original, then others
  const candidates = Array.from(new Set([titleCased, trimmed, lower, upper]));

  const headers = {
    'User-Agent': 'EQGearBot/1.0 (Discord Gear Manager; https://eqlwiki.com)'
  };

  for (const candidate of candidates) {
    const formattedTitle = candidate.replace(/\s+/g, '_');
    const candidateUrls = [
      `https://eqlwiki.com/${encodeURIComponent(formattedTitle)}`,
      `https://eqlwiki.com/wiki/${encodeURIComponent(formattedTitle)}`,
      `https://eqlwiki.com/index.php?title=${encodeURIComponent(formattedTitle)}`
    ];

    for (const wikiUrl of candidateUrls) {
      try {
        const response = await axios.get(wikiUrl, { headers, timeout: 5000 });
        const html = response.data;

        if (typeof html === 'string') {
          if (html.includes('There is currently no text in this page.') || html.includes('noarticletext')) {
            continue;
          }

          if (html.includes('itemdata') || html.includes('ils-item-wrapper') || response.status === 200) {
            const $ = cheerio.load(html);
            const rawTitle = $('.itemtitle').first().text().trim() || $('#firstHeading').text().trim();
            const canonicalName = rawTitle ? rawTitle.replace(/\s+/g, ' ').trim() : candidate;
            return { isValid: true, wikiUrl, canonicalName };
          }
        }
      } catch {
        // try next candidate url
      }
    }
  }

  // Fallback: search autocomplete to find matching item title if direct page lookup failed
  try {
    const suggestions = await searchWikiAutocomplete(trimmed);
    for (const sug of suggestions) {
      if (sug.toLowerCase() === lower) {
        const formatted = sug.replace(/\s+/g, '_');
        const fallbackUrl = `https://eqlwiki.com/${encodeURIComponent(formatted)}`;
        return { isValid: true, wikiUrl: fallbackUrl, canonicalName: sug };
      }
    }
  } catch (searchErr) {
    console.error('Autocomplete fallback error during validation:', searchErr.message);
  }

  return { 
    isValid: false, 
    wikiUrl: `https://eqlwiki.com/${encodeURIComponent(trimmed.replace(/\s+/g, '_'))}`,
    canonicalName: trimmed
  };
}

/**
 * Looks up an item's player-crafted recipe on eqlwiki.com and returns the
 * tradeskill + trivial (the skill level at which it stops granting skill-ups,
 * i.e. the level a crafter needs to reliably make it) straight from the raw
 * wikitext — the same `|playercrafted=... [[Skill X]] (Trivial: NN)` template
 * field Apprentice's own wiki sync engine (wikiPageParser.ts) parses, fetched
 * via MediaWiki's revisions API rather than scraping rendered HTML.
 *
 * Used to auto-fill a work order's required skill + skill level instead of
 * making whoever creates the order (a Discord user, the website, or
 * Apprentice) know or guess it. Returns null if the item has no recorded
 * player-crafted recipe on its wiki page (drop-only/quest-only items, or a
 * page that doesn't exist) — callers should fall back to whatever the caller
 * specified manually, if anything.
 */
async function getSkillTrivial(baseItemName) {
  if (!baseItemName || typeof baseItemName !== 'string') return null;
  const trimmed = baseItemName.trim();
  if (!trimmed) return null;

  const headers = {
    'User-Agent': 'EQGearBot/1.0 (Discord Gear Manager; https://eqlwiki.com)'
  };

  try {
    const response = await axios.get('https://eqlwiki.com/api.php', {
      params: {
        action: 'query',
        prop: 'revisions',
        titles: trimmed,
        rvslots: '*',
        rvprop: 'content',
        format: 'json'
      },
      headers,
      timeout: 5000
    });

    const pages = response.data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) return null;

    const wikitext = page.revisions?.[0]?.slots?.main?.['*'] || '';
    if (!wikitext) return null;

    const pcMatch = wikitext.match(/\|playercrafted\s*=\s*([\s\S]*?)(?=\n\s*\|[a-z_0-9]+\s*=|\n\s*\}\}|\}\}<\/onlyinclude>)/i);
    if (!pcMatch) return null;

    const pcText = pcMatch[1];
    const tsMatch = pcText.match(/\[\[(?:Skill\s+)?([^\]|]+)(?:\|[^\]]+)?\]\]\s*(?:\(Trivial:\s*(\d+)\))?/i);
    if (!tsMatch) return null;

    const tradeskill = tsMatch[1].replace(/^Skill\s+/i, '').trim();
    const trivialLevel = tsMatch[2] ? parseInt(tsMatch[2], 10) : null;
    if (!tradeskill) return null;

    return { tradeskill, trivialLevel };
  } catch (err) {
    console.error(`getSkillTrivial lookup failed for "${trimmed}":`, err.message);
    return null;
  }
}

module.exports = {
  parseItemInput,
  searchWikiAutocomplete,
  validateWikiItem,
  getSkillTrivial
};