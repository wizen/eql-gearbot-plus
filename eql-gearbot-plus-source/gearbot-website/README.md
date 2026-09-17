# Gearbot Website

The browser companion to `eq-gear-bot`: gear bank, work orders, and
inventory-file import, all backed by the same API and database the Discord
bot uses. React 19 + Vite 6 + TypeScript + Tailwind 4 — the same stack as
Apprentice, chosen deliberately so types and, eventually, logic can be
shared between the two rather than diverging.

This is a deliberately lean app: it is *not* a fork of Apprentice with extra
screens grafted on (that was the earlier attempt's approach, and it left two
different copies of Apprentice's source sitting in the same repo). It only
contains what a browser-based gear-bank UI needs, and it talks to
`eq-gear-bot`'s API for everything else.

## How auth works here

There's no login form and no password. Clicking "Log in with Discord" sends
you to `eq-gear-bot`'s `/auth/login`, which redirects to Discord, which redirects
back to the bot's `/auth/callback`. The bot verifies you're actually in the
guild (and checks your officer roles) using its own Discord connection, sets
a session cookie, and sends you back here. The frontend never sees or
transmits a Discord user id or username — every API call is just "whoever
this cookie says you are," verified server-side. That's what closes the
impersonation hole the previous attempt had (every write endpoint there
trusted a client-supplied `userId`).

## Setup (local dev — two processes)

```bash
npm install
cp .env.example .env   # point VITE_API_URL at your eq-gear-bot instance
npm run dev
```

Requires `eq-gear-bot` to be running separately (`npm start` in that folder)
with its `.env` fully configured — see `eq-gear-bot/README.md`, especially
the Discord OAuth redirect URL setup.

## Production — served by eq-gear-bot itself (recommended, esp. on Wispbyte)

```bash
npm run build   # type-checks then builds static files into dist/
```

Rather than deploying this as its own site, copy `dist/`'s contents into
`eq-gear-bot/website-dist/` (or run `eq-gear-bot/scripts/build-website.ps1`,
which does this for you) and let `eq-gear-bot`'s own Express process serve
them. That turns two deployable things into one — one host, one process, one
port, and one origin, which also sidesteps cross-site cookie configuration
entirely (see below). This is the path documented in
`eq-gear-bot/README.md`'s "Deploying to Wispbyte" section.

With `VITE_API_URL` left unset, a production build already calls the API
with relative URLs (same origin) automatically — see `src/api/client.ts`.

## Same-site cookie note (only relevant if you DON'T serve it from eq-gear-bot)

If you deploy this as a genuinely separate site instead — its own host, own
domain — the session cookie eq-gear-bot sets has no explicit `Domain`,
`SameSite=Lax`, and (outside production) is not `Secure`. That still works if
the website and API share a parent domain (e.g. `gearbot.yourguild.net` and
`api.gearbot.yourguild.net` — different subdomains, same registrable domain,
so browsers treat them as "same site"). On genuinely unrelated domains,
you'll need `sameSite: 'none'` and `secure: true` on the session cookie in
`eq-gear-bot/api/server.js`, HTTPS on both, and to set `VITE_API_URL` to the
API's full URL for this build.
