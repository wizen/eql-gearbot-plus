const express = require('express');
const axios = require('axios');
const db = require('../db');

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Discord OAuth2 login for the companion website.
 *
 * Design note: we only ever ask Discord for the `identify` scope (who is this
 * person). We do NOT ask the user's browser for a `guilds.members.read` token
 * to figure out their roles — instead, once we know their Discord user id, we
 * ask our own bot (already logged in, in this same process) to look up their
 * guild membership and roles via the bot token. That's one fewer OAuth scope
 * for guild members to approve, and it means "is this person an officer" is
 * always answered from the same source of truth the Discord bot commands use.
 *
 * Session cookie is the only thing the website holds — the client never sees
 * or sends a Discord user id / username itself. That's what closes the
 * impersonation hole in the previous attempt (every write endpoint there
 * trusted a client-supplied userId/username with no verification at all).
 */
function createAuthRouter({ discordClient }) {
  const router = express.Router();

  const CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
  const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
  const REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;
  const WEBSITE_URL = process.env.WEBSITE_URL || 'http://localhost:5173';
  const GUILD_ID = process.env.GUILD_ID;

  function authorizedRoleIds() {
    return (process.env.AUTHORIZED_ROLE_IDS || '')
      .split(',')
      .map(r => r.trim())
      .filter(Boolean);
  }

  router.get('/login', (req, res) => {
    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
      return res.status(500).send(
        'Discord OAuth is not configured on the server. Set DISCORD_CLIENT_SECRET and OAUTH_REDIRECT_URI in eq-gear-bot/.env.'
      );
    }
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'identify'
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  router.get('/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
      return res.redirect(`${WEBSITE_URL}/?authError=${encodeURIComponent(String(error))}`);
    }
    if (!code) {
      return res.redirect(`${WEBSITE_URL}/?authError=missing_code`);
    }

    try {
      // 1. Exchange the authorization code for an access token
      const tokenRes = await axios.post(
        `${DISCORD_API}/oauth2/token`,
        new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: REDIRECT_URI
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const accessToken = tokenRes.data.access_token;

      // 2. Who is this person, according to Discord?
      const userRes = await axios.get(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const discordUser = userRes.data; // { id, username, global_name, avatar, ... }

      // 3. Are they actually in the guild, and if so what roles do they have?
      //    Answered via the bot's own connection — never trust the client for this.
      let isMember = false;
      let isOfficer = false;
      let displayName = discordUser.global_name || discordUser.username;

      if (GUILD_ID && discordClient?.isReady?.()) {
        try {
          const guild = await discordClient.guilds.fetch(GUILD_ID);
          const member = await guild.members.fetch(discordUser.id);
          if (member) {
            isMember = true;
            displayName = member.displayName || displayName;
            const roleIds = authorizedRoleIds();
            const hasOfficerRole = member.roles.cache.some(r => roleIds.includes(r.id));
            const isAdmin = member.permissions.has('Administrator');
            isOfficer = Boolean(hasOfficerRole || isAdmin);
          }
        } catch (memberErr) {
          // Not a guild member (fetch throws 404 Unknown Member) — isMember stays false.
          isMember = false;
        }
      }

      if (!isMember) {
        return res.redirect(`${WEBSITE_URL}/?authError=not_guild_member`);
      }

      req.session.user = {
        id: discordUser.id,
        username: discordUser.username,
        displayName,
        avatar: discordUser.avatar
          ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
          : null,
        isOfficer,
        isMember
      };

      req.session.save(err => {
        if (err) {
          console.error('Session save error:', err);
          return res.redirect(`${WEBSITE_URL}/?authError=session_failed`);
        }
        res.redirect(WEBSITE_URL);
      });
    } catch (err) {
      console.error('OAuth callback error:', err.response?.data || err.message);
      res.redirect(`${WEBSITE_URL}/?authError=oauth_failed`);
    }
  });

  router.get('/me', (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    res.json({ user: req.session.user });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('gearbot.sid');
      res.json({ success: true });
    });
  });

  return router;
}

/** Requires a logged-in, verified guild member. Attaches req.user for convenience. */
function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  req.user = req.session.user;
  next();
}

/** Requires a logged-in guild member with an authorized officer role (or Administrator). */
function requireOfficer(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  if (!req.session.user.isOfficer) {
    return res.status(403).json({ error: 'Requires a Guild Officer role' });
  }
  req.user = req.session.user;
  next();
}

/**
 * Accepts either a logged-in website session (cookie) OR an Apprentice
 * personal API token (`Authorization: Bearer <token>`, from /g-apikey).
 * Normalizes both into the same req.user shape so downstream routes don't
 * need to care which client is calling. Token-authenticated requests are
 * not granted officer status, since the token proves "this is player X",
 * not "player X currently holds an officer role" (that's re-checked live
 * for session logins, but would require a Discord API round trip on every
 * request here — not worth it for Apprentice's write-your-own-stuff calls).
 */
function requireAuthOrToken(req, res, next) {
  if (req.session?.user) {
    req.user = req.session.user;
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;

  if (token) {
    const tokenRow = db.getUserByApiToken(token);
    if (tokenRow) {
      req.user = {
        id: tokenRow.discord_user_id,
        username: tokenRow.discord_username,
        displayName: tokenRow.discord_username,
        avatar: null,
        isOfficer: false,
        isMember: true,
        viaApiToken: true
      };
      return next();
    }
  }

  return res.status(401).json({ error: 'Not logged in. Log in on the website, or use your Apprentice API key (/g-apikey).' });
}

module.exports = { createAuthRouter, requireAuth, requireOfficer, requireAuthOrToken };
