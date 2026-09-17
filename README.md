# EQL Gearbot Plus

A Discord bot and companion website for managing a guild's spare gear bank and crafting/gathering work orders in EverQuest Legends. One process runs the bot, the web API, and (optionally) serves the built website, all sharing one SQLite database.

Nothing in this repo is prebuilt - no `node_modules/`, no compiled website assets, no downloaded binaries. Clone it, fill out one file, run one script, and it fetches and builds everything itself.

## What's included

- **`eql-gearbot-plus-source/eql-merc-suite/`** - the Discord bot + web API. Slash commands for adding/claiming/searching gear (`/g-add`, `/g-list`, `/g-find`, ...) and for posting/claiming work orders (`/g-addwork`, `/g-work`). Required tradeskill and trivial level for a work order are looked up automatically from your item wiki - nobody has to know or guess them.
- **`eql-gearbot-plus-source/gearbot-website/`** - a web UI for the same gear bank and work orders, so members who'd rather click than type slash commands can use it from a browser. Logs in with Discord OAuth2.

Everything - your guild's name, its Discord IDs, its wiki, its domain - is configured in one place: `!fill_me_out_first.ini` at the repo root. Nothing guild-specific is hardcoded, and you never hand-edit a `.env` file directly.

## Requirements

- Node.js 20 or newer
- A Discord application/bot (create one at the [Discord Developer Portal](https://discord.com/developers/applications))
- Somewhere to host it that gives you a long-running Node process (this was built and tested against Wispbyte, a free-tier Pterodactyl-panel host - see `eql-gearbot-plus-source/eql-merc-suite/README.md` for that specific walkthrough)

## Setup

Double-click `setup.bat` (or run `.\setup.ps1` in PowerShell). It will:

1. Read `!fill_me_out_first.ini` (see "Configure before running" below) - stop if it's missing or any required value is still a placeholder.
2. Copy `eql-gearbot-plus-source/eql-merc-suite` and `eql-gearbot-plus-source/gearbot-website` into a disposable `FOR_UPLOAD/` folder (deleted and recreated fresh every run) - `eql-gearbot-plus-source/` is only ever read, never modified.
3. Generate `eql-merc-suite/.env` and `gearbot-website/.env` inside `FOR_UPLOAD` from the ini's values - you never hand-edit either `.env` file directly.
4. Install `FOR_UPLOAD/eql-merc-suite`'s dependencies.
5. Install `FOR_UPLOAD/gearbot-website`'s dependencies and build it (using the `.env` just generated, so the guild name and API URL are baked in correctly).
6. Copy the built website into `FOR_UPLOAD/eql-merc-suite/website-dist`.
7. Zip `FOR_UPLOAD/eql-merc-suite` - including its generated `.env` - into `FOR_UPLOAD/eql-gearbot-plus-deploy.zip`. That's the file you upload to your host; it's already configured, with nothing left to fill in on the server. A popup confirms it's ready and reminds you that your real secrets are inside it - this zip is meant to go straight to your own private host, never anywhere public.

You can delete `FOR_UPLOAD/` any time - it's regenerated from scratch on the next run.

## Configure before running

Open `!fill_me_out_first.ini` at the repo root and fill it in - every environment variable the suite needs has a spot in it (Discord token, client ID/secret, guild ID, your guild's name, your domain, session secret, and a few others with sensible defaults already filled in). If the file doesn't exist yet, running `setup.ps1` creates it with placeholders and stops so you can fill it in - just run the script again once you have. Two fields worth knowing about up front:

- **`GUILD_NAME`** - your guild's name (no `<>` tag brackets needed). Set it once here - `setup.ps1` writes it into both the bot's `GUILD_NAME` and the website's `VITE_GUILD_NAME` automatically, so you never maintain two copies.
- **`SESSION_SECRET`** - a random string signing website login sessions. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

See `eql-gearbot-plus-source/eql-merc-suite/README.md` for the full command/API reference and deployment details.

## License

See `eql-gearbot-plus-source/eql-merc-suite/LICENSE`.
