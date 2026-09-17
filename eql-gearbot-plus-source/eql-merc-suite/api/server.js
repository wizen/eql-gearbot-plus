const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const session = require('express-session');

const { version: SUITE_VERSION } = require('../package.json');
const { createAuthRouter } = require('./auth');
const { SqliteSessionStore } = require('./sessionStore');
const buildGearRouter = require('./routes/gear');
const buildWorkOrdersRouter = require('./routes/workOrders');
// The old Apprentice inventory-sync router (full character bag/bank sync)
// was removed for being overly invasive - see api/routes/apprentice.js for
// why - and is no longer required or mounted here. Apprentice's real
// integration point is buildWorkOrdersRouter above.

/**
 * Builds and starts the HTTP API in the SAME process as the Discord bot
 * (see index.js), sharing one require('./db') connection rather than two
 * processes independently opening the same SQLite file. This was one of
 * the two architecture calls made up front: bolt the API onto Gearbot
 * rather than standing up a second independent service.
 *
 * Also optionally serves the built gearbot-website (its `dist/` folder) as
 * static files from this same process/port. On a host that gives you one
 * process and one exposed port per app (Wispbyte, and most Pterodactyl-panel
 * free bot hosts, work this way), that means the bot, the API, and the
 * website are all one deployable thing on one port — no second hosting slot
 * needed, and no cross-origin cookie configuration required since the
 * website and the API end up on the exact same origin. See
 * gearbot-website/README.md for the local-dev (two-origin) alternative.
 *
 * @param {import('discord.js').Client} discordClient - already-constructed
 *   bot client (does not need to be logged in yet) — used by the OAuth
 *   callback to look up guild membership/roles via the bot token.
 */
function startApiServer(discordClient) {
  const app = express();

  // Most Pterodactyl-panel-based hosts (Wispbyte included) assign a port via
  // an env var and expect your process to bind to it — some call it PORT,
  // some SERVER_PORT. We fall back through the common names, then our own
  // API_PORT for local dev, then a hardcoded default.
  const PORT = process.env.PORT || process.env.SERVER_PORT || process.env.API_PORT || 3001;
  const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:5173';

  // Sits behind Wispbyte's (or any) reverse proxy — needed so Express sees
  // the original request as HTTPS (req.secure) when deciding whether to
  // honor the session cookie's `secure` flag, not the proxy's internal
  // plain-HTTP hop. Harmless if there's no proxy in front of it.
  app.set('trust proxy', 1);

  if (!process.env.SESSION_SECRET) {
    console.warn(
      '⚠️  SESSION_SECRET is not set in .env — using an insecure generated one for this run. ' +
      'Set SESSION_SECRET in eq-gear-bot/.env before deploying, or every restart invalidates all website logins.'
    );
  }

  app.use(cors({ origin: WEBSITE_URL, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // COOKIE_SECURE defaults to "on in production" but can be forced either
  // way — useful if your host proxies HTTPS without the request looking
  // secure to Express, or if you're deploying without HTTPS at all yet.
  const cookieSecure = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production';

  app.use(session({
    name: 'gearbot.sid',
    // Sessions persist in gear_inventory.db (see api/sessionStore.js) instead
    // of express-session's default in-memory store, which the library's own
    // docs warn will leak memory over time - not viable on a long-running,
    // low-RAM host like Wispbyte.
    store: new SqliteSessionStore(),
    secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
    }
  }));

  // The single source of truth for "what's actually running right now" —
  // the website's header fetches this on load to show a live version badge,
  // so you can check what's deployed just by looking at the page, without
  // needing console/SSH access to Wispbyte at all.
  app.get('/api/health', (req, res) => res.json({ status: 'ok', version: SUITE_VERSION }));

  app.use('/auth', createAuthRouter({ discordClient }));
  app.use('/api', buildGearRouter());
  app.use('/api', buildWorkOrdersRouter());

  // ---- Optional: serve the built website from this same process/port ----
  // WEBSITE_DIST_PATH defaults to eq-gear-bot/website-dist — a folder
  // INSIDE this app's own directory, not a sibling one level up. That's
  // deliberate: most one-app-per-instance hosts (Wispbyte included) only
  // upload/deploy the single folder you point them at, so anything this
  // process needs to serve has to live inside that folder. See "Deploying
  // to Wispbyte" in README.md for the copy-dist-in-before-upload step. If
  // it's not there, the API just runs on its own — nothing breaks.
  const websiteDist = process.env.WEBSITE_DIST_PATH
    ? path.resolve(process.env.WEBSITE_DIST_PATH)
    : path.join(__dirname, '..', 'website-dist');

  if (fs.existsSync(path.join(websiteDist, 'index.html'))) {
    console.log(`🌐 Serving gearbot-website static build from ${websiteDist}`);
    app.use(express.static(websiteDist));
    // SPA fallback: any GET that isn't /api or /auth returns index.html so
    // client-side routing (if added later) and hard refreshes both work.
    app.get(/^(?!\/api(\/|$)|\/auth(\/|$)).*/, (req, res) => {
      res.sendFile(path.join(websiteDist, 'index.html'));
    });
  } else {
    console.log(
      `ℹ️  No website build found at ${websiteDist} — API-only mode. ` +
      `Run "npm run build" in gearbot-website/ to serve it from here too.`
    );
  }

  // Fallback error handler so a thrown error doesn't crash the bot process.
  app.use((err, req, res, next) => {
    console.error('API error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🛡️  Gearbot API listening on http://0.0.0.0:${PORT}`);
  });

  return app;
}

module.exports = { startApiServer };
