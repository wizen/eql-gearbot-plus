# 🛡️ EQ Legends Gear Bot 2.0 — Discord Bot + Web API

A single Node process that runs both the guild's Discord bot and the HTTP API
behind the companion website and the Apprentice desktop app. One process, one
SQLite connection (`gear_inventory.db`), one set of rules for who can claim,
add, or fulfill what — enforced the same way whether the request came from a
Discord slash command, the website, or Apprentice.

---

## Discord Commands

### Gear bank
- **/g-add `item_name`** — Add a gear item to the guild's spare pool. Validates the name against eqlwiki.com and records who donated it. Supports `+1`–`+10` upgrade suffixes.
- **/g-stock `item_name` `quantity`** — Add a stackable item (reagents, components) in bulk, e.g. `Water Flask x40`.
- **/g-list `[filter]`** — Paginated, 10-per-page browsable inventory with a two-step dropdown: pick an item, then pick an action (view card, claim, withdraw, remove) contextual to your relationship to that item.
- **/g-card `item_name`** — Render a high-res item card scraped from eqlwiki.com, with buttons to step through upgrade levels.
- **/g10 `item_name`** — Shortcut: show an item's card at `+10`.
- **/g-find `item_name`** — Search the guild spare-gear pool for an item.
- **/g-import `inventory_file`** — Upload the `.txt` dump produced by the in-game `/outputfile inventory` command (no filename argument — EQ auto-names it `<CharacterName>-Inventory.txt`); pick which items to donate via a paginated multi-select, matched against eqlwiki.com and imported in a batch. Preserves socketed augments/ornaments.
- **/g-apikey** — Generate (or rotate) your personal API key, DMed to you, for Apprentice to authenticate with when it submits work orders on your behalf.

### Work orders
- **/g-addwork `item_name` `[quantity]` `[skill]` `[notes]`** — Post a work order for something you need crafted or gathered.
- **/g-work `[filter]`** — Browse open/in-progress/completed work orders; select one to claim it, mark it complete, or (if you're the requester or an officer) cancel it.

Guild Officers are anyone with a role ID listed in `AUTHORIZED_ROLE_IDS`, or Discord Administrator. Officers can remove any gear item and delete any work order.

Apprentice never syncs or stores a player's personal inventory here — an earlier build did that (`/g-vault`, plus a full inventory-sync API) and it's been removed as overly invasive. This bot only ever knows what's actually been deposited into the guild's spare-gear pool. Apprentice's real integration is generating a shopping list and submitting/checking work orders, same as a player could do by hand with `/g-addwork` and `/g-work`.

---

## Web API

Started automatically alongside the Discord bot (see `api/server.js`), listening on whatever `PORT`/`SERVER_PORT` your host assigns, falling back to `API_PORT` (default `3001`) for local dev. This is what the companion website and Apprentice talk to — see `gearbot-website/README.md` for the frontend. This same process can also serve the website's built static files directly (see "Deploying to Wispbyte" below) so the whole thing runs as one app on one port.

**Auth** — two methods, normalized to the same `req.user` shape:
- **Website**: Discord OAuth2 login (`GET /auth/login` → Discord → `GET /auth/callback`), session cookie. Guild membership and officer status are looked up live via the bot's own connection, never trusted from the client.
- **Apprentice**: a personal API key from `/g-apikey`, sent as `Authorization: Bearer <token>`.

Every write endpoint uses the authenticated identity for `added_by`/`requester`/`claimed_by` fields — nothing is accepted from the request body. This is the fix for the earlier prototype, where every endpoint trusted a client-supplied `userId`/`username` and could be trivially impersonated.

Key endpoints:
| Method & Path | Purpose |
|---|---|
| `GET /auth/login` → `/auth/callback` | Discord OAuth2 flow |
| `GET /auth/me` | Current session user |
| `POST /auth/logout` | End session |
| `GET /api/gear` | List gear bank |
| `POST /api/gear/add`, `/api/gear/stock` | Add item / stock |
| `POST /api/gear/:id/claim`, `/withdraw` | Claim / release a claim |
| `DELETE /api/gear/:id` | Remove (donor or officer) |
| `GET /api/wiki/autocomplete`, `/validate`, `/card` | eqlwiki.com lookups |
| `POST /api/import/parse`, `/confirm` | Inventory-file import flow |
| `GET /api/work-orders`, `POST /api/work-orders` | List / create work orders |
| `POST /api/work-orders/:id/claim`, `/complete`, `/cancel` | Work order lifecycle |

---

## Setup

### 1. Discord Developer Portal
1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**: copy the token (`DISCORD_TOKEN`), enable **Message Content Intent** if you plan to use content-based features later.
3. Under **OAuth2 → General**: copy the **Client ID** (`CLIENT_ID`/`DISCORD_CLIENT_ID`) and **Client Secret** (`DISCORD_CLIENT_SECRET`).
4. Under **OAuth2 → Redirects**: add a redirect URL matching `OAUTH_REDIRECT_URI` exactly (e.g. `http://localhost:3001/auth/callback` for local dev).
5. Under **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; bot permissions `Send Messages`, `Embed Links`, `Attach Files`, `Use Slash Commands`. Use the generated URL to invite the bot to your guild.

### 2. Configure environment
Copy `.env.example` to `.env` and fill in every value — see the comments in that file for what each one is and how to generate `SESSION_SECRET`.

### 3. Install & run
```bash
npm install
npm start
```
This logs the bot into Discord, registers slash commands, and starts the API on `API_PORT`.

---

## Deploying to Wispbyte

Confirmed from this deployment's actual panel (its Startup tab runs this
verbatim):
```bash
if [[ -d .git ]] && [[ 0 == "1" ]]; then git pull; fi;
if [[ ! -z ${NODE_PACKAGES} ]]; then npm install ${NODE_PACKAGES}; fi;
if [[ ! -z ${UNNODE_PACKAGES} ]]; then npm uninstall ${UNNODE_PACKAGES}; fi;
if [ -f /home/container/package.json ]; then npm install; fi;
node /home/container/index.js
```
That `/home/container/...` path and the `NODE_PACKAGES`/`UNNODE_PACKAGES`
variables are the signature of Pterodactyl's standard "Generic Node.js" egg —
Wispbyte is a Pterodactyl-panel host. Concretely, that script means:

- **`npm install` runs automatically on every start**, whenever
  `package.json` exists at the container root — no manual install step, but
  also no build step. It only ever runs `npm install`, never
  `npm run build`, so Vite's toolchain still has to run somewhere else.
- **The entry point is hardcoded to `/home/container/index.js`** — so what
  you upload has to have `index.js` (and `package.json`, `db.js`, `api/`,
  `commands/`, etc.) directly at the container's root, not nested inside
  another folder.
- This also means **only `eql-merc-suite/`'s contents go to Wispbyte** —
  `gearbot-website/`'s own `package.json` should never land in that
  container; it would just be dead weight `npm install` chews through on
  every restart for no reason (see step 1).

1. **Build the website locally first**, since Wispbyte never runs a build
   step. From the repo root:
   ```powershell
   .\setup.ps1
   ```
   (or manually: `cd gearbot-website && npm install && npm run build`, then
   copy `dist/`'s contents into `eql-merc-suite/website-dist/`). This leaves
   `eql-merc-suite/` self-contained — everything the container needs, in one
   folder, with nothing extra for it to install.

2. **Upload `eql-merc-suite/`'s contents** (not the folder itself — its
   contents, so `index.js` ends up at the container root) through Wispbyte's
   file manager, `website-dist/` included. Skip `node_modules/` — the
   startup script installs it for you.

3. **Startup Command**: already correct as shown above — no change needed,
   it's the egg default.

4. **Variables tab** — fill in your own values from `.env.example` (your
   Discord app credentials, and the domain/port your Wispbyte allocation
   actually gives you) into Wispbyte's Variables tab. Also add
   `<your-domain>/auth/callback` under **OAuth2 → Redirects** in the Discord
   Developer Portal, matching `OAUTH_REDIRECT_URI` exactly.

   One thing to verify first: if Wispbyte gives you a branded subdomain
   (their own `*.wisp.uno`-style domains are normally reverse-proxied with
   TLS already terminated), `WEBSITE_URL`/`OAUTH_REDIRECT_URI` can use
   `https://` and `COOKIE_SECURE=true`. **Open that URL in a browser before
   starting the bot** — if it loads without a certificate warning, you're
   set. If it doesn't, or if login silently does nothing after the Discord
   redirect once you try it, your domain is actually HTTP-only: switch both
   URLs to `http://` (or the raw IP:port your allocation gives you) and flip
   `COOKIE_SECURE` to `false`.

5. **Puppeteer / card rendering — worth testing first.** `/g-card` and `/g10`
   launch headless Chrome via Puppeteer to render item cards. The Dockerfile
   in this repo installs the Linux libraries headless Chrome needs, but a
   generic Pterodactyl Node egg's base image may or may not already have
   them. After your first deploy, try `/g-card` on something and see what
   happens — if it errors, that's almost certainly missing system libraries
   for headless Chrome, not a bug in the code, and the fix is host-side (a
   different egg/image with Chromium support, or Puppeteer's bundled
   Chromium download failing under a low-resource plan's limits).

6. **Persistent storage**: `gear_inventory.db` is written inside the app's
   own folder, so it should live on whatever disk your host allocates this
   container and survive restarts. Policies on reclaiming storage after long
   inactivity vary by host — back up `gear_inventory.db` periodically until
   you've seen it survive a restart yourself.

### Docker / Railway / Fly.io
Use the included `Dockerfile`, which installs Chromium and the Linux graphics libraries `node-html-to-image`/Puppeteer need for card rendering:
```bash
docker build -t eql-merc-suite .
docker run --env-file .env -p 3001:3001 eql-merc-suite
```
In production, set `NODE_ENV=production` so session cookies are marked `secure` (requires serving over HTTPS), and set `WEBSITE_URL`/`OAUTH_REDIRECT_URI` to your real deployed URLs.
