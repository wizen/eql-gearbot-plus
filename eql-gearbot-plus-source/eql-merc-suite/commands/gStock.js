const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { parseItemInput, searchWikiAutocomplete, validateWikiItem } = require('../wikiScraper');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g-stock')
    .setDescription('Add a trade skill or stackable item with a required quantity.')
    .addStringOption(option =>
      option.setName('item_name')
        .setDescription('Item name to look up on eqlwiki.com')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(option =>
      option.setName('quantity')
        .setDescription('Quantity of the item (e.g. 5, 20, 100)')
        .setRequired(true)
        .setMinValue(1)
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    const suggestions = await searchWikiAutocomplete(focusedValue);

    await interaction.respond(
      suggestions.slice(0, 25).map(item => ({ name: item, value: item }))
    );
  },

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rawInput = interaction.options.getString('item_name');
    const qty = interaction.options.getInteger('quantity');
    const { baseItemName } = parseItemInput(rawInput);

    if (!baseItemName) {
      return interaction.editReply('❌ Please specify a valid item name.');
    }

    if (!qty || qty < 1) {
      return interaction.editReply('❌ Please specify a valid positive quantity.');
    }

    const { isValid, wikiUrl, canonicalName } = await validateWikiItem(baseItemName);

    if (!isValid) {
      return interaction.editReply(`❌ Could not validate **${baseItemName}** on eqlwiki.com. Please check spelling.`);
    }

    const officialItemName = canonicalName || baseItemName;
    const quantityLevel = `x${qty}`;
    const username = interaction.member?.displayName || interaction.user.username;
    db.addGear(officialItemName, quantityLevel, wikiUrl, interaction.user.id, username);

    await interaction.editReply(
      `✅ Added **[${officialItemName} ${quantityLevel}](${wikiUrl})** to the stock inventory! (Held by **${username}**)`
    );
  }
};