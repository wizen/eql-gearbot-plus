const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { searchWikiAutocomplete, parseItemInput } = require('../wikiScraper');
const { GUILD_NAME } = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g-find')
    .setDescription('Search the guild spare gear pool for an item.')
    .addStringOption(option =>
      option.setName('item_name')
        .setDescription('Item name to locate')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    if (!focusedValue || focusedValue.length < 2) {
      return interaction.respond([]);
    }
    const suggestions = await searchWikiAutocomplete(focusedValue);
    await interaction.respond(
      suggestions.slice(0, 25).map(item => ({ name: item, value: item }))
    );
  },

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const query = interaction.options.getString('item_name').trim();
    const { baseItemName } = parseItemInput(query);
    const searchTarget = baseItemName || query;

    // Check Guild Spare Gear Pool. This bot only ever knows what's actually
    // been deposited into the guild bank - it does not hold or search any
    // copy of a player's personal inventory (see db.js and
    // api/routes/apprentice.js for why that was removed).
    const allGear = db.getAllGear();
    const gearMatches = allGear.filter(g =>
      g.base_item_name.toLowerCase().includes(searchTarget.toLowerCase())
    );

    if (gearMatches.length === 0) {
      return interaction.editReply(`🔍 No records found for **"${searchTarget}"** in the guild gear bank.`);
    }

    let reply = `🔎 **Search Results for: ${searchTarget}**\n\n`;
    reply += `🛡️ **<${GUILD_NAME}> Spare Gear Pool (${gearMatches.length} found):**\n`;
    gearMatches.slice(0, 10).forEach(g => {
      const claimStatus = g.requested_by_username
        ? `*(Claimed by @${g.requested_by_username})*`
        : `*(Available - Use /g-list to claim ID #${g.id})*`;
      const exalts = g.exalts_json ? ` [Augs]` : '';
      reply += `• **#${g.id}** [${g.base_item_name}](${g.wiki_url}) **${g.upgrade_level}**${exalts} — Added by ${g.added_by_username} ${claimStatus}\n`;
    });
    if (gearMatches.length > 10) {
      reply += `*...and ${gearMatches.length - 10} more in guild bank.*\n`;
    }

    await interaction.editReply(reply);
  }
};
