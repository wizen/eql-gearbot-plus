// Central place for suite-wide branding config. Nothing else in this repo
// should hardcode a specific guild's name - every embed, reply, and page
// title pulls it from here (which itself just reads GUILD_NAME from .env),
// so pointing this whole suite at a different guild is a one-line .env
// change instead of hunting through every command and the website.
//
// The fallback is deliberately loud rather than a real-looking guild name -
// if this ever shows up in a live embed, it means GUILD_NAME was never set
// in .env, and it should be obvious at a glance rather than quietly wrong.
const GUILD_NAME = process.env.GUILD_NAME || 'ENV_FILE_OR_VAR_MISSING';

module.exports = { GUILD_NAME };
