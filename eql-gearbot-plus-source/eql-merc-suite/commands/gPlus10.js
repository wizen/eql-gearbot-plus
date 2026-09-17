const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { parseItemInput, searchWikiAutocomplete, validateWikiItem } = require('../wikiScraper');
const { generateCardPng } = require('../cardRenderer');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g10')
    .setDescription('Display an item card rendered at +10 upgrade level in an ephemeral window.')
    .addStringOption(option =>
      option.setName('item_name')
        .setDescription('Item name to look up at +10')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    const suggestions = await searchWikiAutocomplete(focusedValue);
    await interaction.respond(
      suggestions.slice(0, 25).map(item => ({ name: item, value: item }))
    );
  },

  async execute(interaction) {
    // Ephemeral response visible only to the user
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rawInput = interaction.options.getString('item_name');
    const { baseItemName } = parseItemInput(rawInput);

    const { isValid, wikiUrl } = await validateWikiItem(baseItemName);
    if (!isValid) {
      return interaction.editReply(`❌ Could not find item **${baseItemName}** on eqlwiki.com.`);
    }

    try {
      // Render PNG item card directly at +10 level
      const imageBuffer = await generateCardPng(wikiUrl, '+10');
      const attachment = new AttachmentBuilder(imageBuffer, { name: `${baseItemName.replace(/\s+/g, '_')}_plus10.png` });

      await interaction.editReply({
        content: `⚔️ **${baseItemName} (+10)** — eqlwiki card:`,
        files: [attachment]
      });
    } catch (err) {
      console.error('Error rendering +10 card:', err);
      await interaction.editReply(`❌ Failed to render +10 card for **${baseItemName}**: ${err.message}`);
    }
  }
};