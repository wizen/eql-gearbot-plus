const axios = require('axios');
const cheerio = require('cheerio');

// On Linux, use @sparticuz/chromium — a Chromium build with its shared
// library dependencies bundled into the npm package itself, so it launches
// on a bare host with no apt-get/system-package step. On Windows (local
// dev), that build doesn't exist, so fall back to a regular full-fat
// puppeteer install, which downloads a Windows-compatible Chromium.
let puppeteer = null;
let sparticuzChromium = null;

if (process.platform === 'linux') {
  try {
    sparticuzChromium = require('@sparticuz/chromium');
    puppeteer = require('puppeteer-core');
  } catch (e) {
    sparticuzChromium = null;
  }
}

if (!puppeteer) {
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    try {
      puppeteer = require('puppeteer-core');
    } catch (e2) {}
  }
}

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-extensions'
  ];

  const options = {
    headless: 'new',
    args: launchArgs
  };

  if (sparticuzChromium) {
    options.args = [...sparticuzChromium.args, ...launchArgs];
    options.executablePath = await sparticuzChromium.executablePath();
  } else if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    // Manual override — e.g. a system Chromium installed some other way.
    options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  browserInstance = await puppeteer.launch(options);
  return browserInstance;
}

/**
 * Scales item stats according to eqlwiki's upgrade formulas (+0 through +10).
 */
function scaleCardHtml(rawItemDataHtml, level = '+0') {
  const levelNum = parseInt(String(level).replace('+', ''), 10) || 0;
  if (levelNum === 0) return rawItemDataHtml;

  const scalableStats = [
    'AC', 'HP', 'MANA', 'MP', 'ENDUR', 'END', 'STR', 'STA', 'AGI', 'DEX', 'WIS', 'INT', 'CHA',
    'MAGIC', 'FIRE', 'COLD', 'POISON', 'DISEASE',
    'SV FIRE', 'SV COLD', 'SV MAGIC', 'SV POISON', 'SV DISEASE', 'SV VOID',
    'MANA REGEN', 'HP REGEN', 'END REGEN', 'DMG', 'DAMAGE', 'WT', 'WEIGHT'
  ];

  const regex = new RegExp('(\\b(?:' + scalableStats.join('|') + ')\\b)(:\\s*)([+\\-]?)(\\d+(?:\\.\\d+)?)', 'gi');

  // Scale Haste (+1 percentile point per upgrade tier)
  let scaledHtml = rawItemDataHtml.replace(/(\bHaste\b)(:\s*)([+]?)(\d+)%/gi, (match, statName, colon, sign, numStr) => {
    const baseVal = parseInt(numStr, 10);
    const newVal = baseVal + levelNum;
    const formattedVal = `${sign || '+'}${newVal}%`;
    return `${statName}${colon}<span style="color: #6ee7b7; font-weight: bold;">${formattedVal}</span>`;
  });

  return scaledHtml.replace(regex, (match, statName, colon, sign, numStr) => {
    const statKey = statName.toUpperCase().replace(/^SV\s+/, '');
    const baseVal = parseFloat(numStr);
    const signedBase = sign === '-' ? -baseVal : baseVal;

    let newVal = signedBase;
    if (statKey === 'WT' || statKey === 'WEIGHT') {
      const totalProgression = 1 + levelNum;
      const rawWeight = baseVal * (1 + (-0.09 * (Math.log(totalProgression) / Math.LN2)));
      newVal = Math.max(0.1, Math.ceil(rawWeight * 10) / 10).toFixed(1);
      return `${statName}${colon}<span style="color: #6ee7b7; font-weight: bold;">${newVal}</span>`;
    } else if (statKey === 'DMG' || statKey === 'DAMAGE') {
      newVal = Math.floor(signedBase + (signedBase * levelNum / 10));
    } else {
      if (signedBase > 0 && signedBase <= 10) {
        newVal = signedBase + levelNum;
      } else if (signedBase > 10) {
        newVal = Math.floor(signedBase + Math.round(signedBase * levelNum / 10));
      }
    }

    const formattedVal = (sign === '+' && newVal > 0) ? `+${newVal}` : String(newVal);
    return `${statName}${colon}<span style="color: #6ee7b7; font-weight: bold;">${formattedVal}</span>`;
  });
}

/**
 * Scrapes div.ils-item-wrapper (or .itemdata) and renders it as a PNG image buffer.
 */
async function generateCardPng(wikiUrl, level = '+0') {
  const response = await axios.get(wikiUrl, {
    headers: {
      'User-Agent': 'EQGearBot/1.0 (Discord Gear Manager; https://eqlwiki.com)'
    },
    timeout: 7000
  });
  const $ = cheerio.load(response.data);

  // 1. Resolve all relative image URLs (e.g. /images/...) to absolute https://eqlwiki.com URLs
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    if (src && src.startsWith('/')) {
      $(el).attr('src', `https://eqlwiki.com${src}`);
    }
    const srcset = $(el).attr('srcset');
    if (srcset) {
      const fixedSrcset = srcset.split(',').map(part => {
        const trimmed = part.trim();
        if (trimmed.startsWith('/')) {
          return `https://eqlwiki.com${trimmed}`;
        }
        return trimmed;
      }).join(', ');
      $(el).attr('srcset', fixedSrcset);
    }
  });

  // 2. Locate .itemicon wherever it exists on page
  let itemIconHtml = '';
  if ($('.itemicon').length) {
    itemIconHtml = $.html($('.itemicon').first());
  }

  let itemWrapper = $('div.ils-item-wrapper');
  let rawHtml = '';

  if (itemWrapper.length) {
    // If wiki pre-rendered an ils-item-wrapper
    const $itemdata = itemWrapper.find('.itemdata');
    if ($itemdata.length) {
      // Ensure .itemicon is present inside .itemdata if found on page
      if (!$itemdata.find('.itemicon').length && itemIconHtml) {
        $itemdata.prepend(itemIconHtml);
      }
      $itemdata.html(scaleCardHtml($itemdata.html(), level));
    }
    rawHtml = $.html(itemWrapper);
  } else if ($('.itemdata').length) {
    const itemTitle = $('.itemtitle').first().text().trim() || 'Item';
    const $itemDataEl = $('.itemdata').first().clone();

    // Ensure itemicon is present inside .itemdata
    if (!$itemDataEl.find('.itemicon').length && itemIconHtml) {
      $itemDataEl.prepend(itemIconHtml);
    }

    const rawDataHtml = $itemDataEl.html() || '';
    const scaledDataHtml = scaleCardHtml(rawDataHtml, level);
    const isQuantity = /^[xX]\d+$/i.test(level);
    let levelLabel = '';
    if (isQuantity) {
      levelLabel = ` <span style="color: #6ee7b7; font-size: 14px; font-weight: normal;">[${level.toLowerCase()}]</span>`;
    } else if (level !== '+0') {
      levelLabel = ` <span style="color: #5865F2; font-size: 14px;">[${level}]</span>`;
    }

    rawHtml = `
      <div class="ils-item-wrapper" data-slider-level="${level}">
        <div class="itemtopbg" style="background: #1a2035; padding: 10px; border-bottom: 1px solid #2d3748;">
          <div class="itemtitle" style="color: #f4d77c; font-family: Georgia, serif; font-size: 17px; font-weight: bold;">${itemTitle}${levelLabel}</div>
        </div>
        <div class="itembg" style="background: #0d111d; padding: 14px; color: #f0f0f0; line-height: 1.6; font-family: monospace;">
          <div class="itemdata">${scaledDataHtml}</div>
        </div>
      </div>
    `;
  } else {
    throw new Error('Could not find item card container (.itemdata or .ils-item-wrapper) on wiki page.');
  }

  const isQuantity = /^[xX]\d+$/i.test(level);
  const badgeText = isQuantity ? `Quantity: ${level.toLowerCase()}` : `Upgrade Level: ${level}`;

  const template = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <link rel="stylesheet" href="https://eqlwiki.com/load.php?lang=en&modules=site.styles&only=styles&skin=vector">
      <style>
        * {
          box-sizing: border-box;
        }
        body {
          background-color: #232428;
          color: #dcddde;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          padding: 24px;
          margin: 0;
          display: inline-block;
        }
        .ils-item-wrapper {
          border: 1px solid #3f4147;
          background: #1e1f22;
          padding: 14px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          max-width: 480px;
        }
        .itemicon {
          float: right;
          margin-left: 12px;
          margin-bottom: 8px;
          background: #111;
          border: 1px solid #444;
          border-radius: 4px;
          padding: 2px;
          display: inline-block;
        }
        .itemicon img,
        .itemicon figure img,
        .mw-file-element {
          display: block;
          max-width: 40px;
          max-height: 40px;
          width: auto;
          height: auto;
        }
        .itemicon figure {
          margin: 0;
        }
        .ils-item-wrapper table {
          border-collapse: collapse;
          width: 100%;
          color: #dcddde;
        }
        .ils-item-wrapper a {
          color: #00aff4;
          text-decoration: none;
        }
        .card-badge {
          display: inline-block;
          background: ${isQuantity ? '#10b981' : '#5865f2'};
          color: #ffffff;
          padding: 3px 8px;
          border-radius: 4px;
          font-weight: bold;
          font-size: 12px;
          margin-bottom: 8px;
        }
      </style>
    </head>
    <body>
      <div style="margin-bottom: 8px;">
        <span class="card-badge">${badgeText}</span>
      </div>
      <div class="ils-item-wrapper" data-slider-level="${level}">
        ${rawHtml}
      </div>
    </body>
    </html>
  `;

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 600, height: 800, deviceScaleFactor: 2 });
    // Wait until network is idle so external images finish loading
    await page.setContent(template, { waitUntil: ['domcontentloaded', 'networkidle0'], timeout: 12000 });

    // Clip precisely to the item card container
    const element = await page.$('.ils-item-wrapper');
    let imageBuffer;
    if (element) {
      imageBuffer = await element.screenshot({ type: 'png', omitBackground: false });
    } else {
      imageBuffer = await page.screenshot({ type: 'png', fullPage: true });
    }

    return imageBuffer;
  } finally {
    await page.close();
  }
}

module.exports = { generateCardPng, scaleCardHtml };
