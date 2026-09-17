// Central place for suite-wide branding on the website side, mirroring
// config.js on the bot - nothing here should hardcode a specific guild's
// name. Falls back to the same loud placeholder as the bot's config.js
// when VITE_GUILD_NAME isn't set - if this ever shows up on the live
// site, it means the env var was never configured.
export const GUILD_NAME = import.meta.env.VITE_GUILD_NAME || 'ENV_FILE_OR_VAR_MISSING';
