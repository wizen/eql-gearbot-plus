const { SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags } = require('discord.js');
const { parseItemInput, searchWikiAutocomplete, validateWikiItem } = require('../wikiScraper');
const { generateCardPng } = require('../cardRenderer');

function buildSliderControls(itemName, currentLevel) {
  const levels = ['+0', '+1', '+2', '+3', '+4', '+5', '+6', '+7', '+8', '+9', '+10'];
  const safeCurrentLevel = levels.includes(currentLevel) ? currentLevel : '+0';

  const selectOptions = levels.map(lvl => 
    new StringSelectMenuOptionBuilder()
      .setLabel(lvl === '+0' ? '+0 (Base / Unenchanted)' : lvl)
      .setValue(lvl)
      .setDescription(`View item card scaled to ${lvl}`)
      .setDefault(lvl === safeCurrentLevel)
  );

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`card_select_level_${encodeURIComponent(itemName)}`)
    .setPlaceholder(`Current Level: ${safeCurrentLevel}`)
    .addOptions(selectOptions);

  return new ActionRowBuilder().addComponents(selectMenu);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g-card')
    .setDescription('Render an item card PNG image from eqlwiki.com.')
    .addStringOption(option =>
      option.setName('item_name')
        .setDescription('Item name to look up')
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rawInput = interaction.options.getString('item_name');
    const { baseItemName, upgradeLevel } = parseItemInput(rawInput);

    const { isValid, wikiUrl } = await validateWikiItem(baseItemName);
    if (!isValid) {
      return interaction.editReply(`❌ Could not find item **${baseItemName}** on eqlwiki.com.`);
    }

    try {
      const isQuantity = /^[xX]\d+$/i.test(upgradeLevel);
      const imageBuffer = await generateCardPng(wikiUrl, upgradeLevel);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'card.png' });
      
      const levelSuffix = (upgradeLevel && upgradeLevel !== '+0') ? ` ${upgradeLevel}` : '';
      const replyOptions = { 
        content: `🔍 **${baseItemName}${levelSuffix}**`,
        files: [attachment] 
      };

      // Only add upgrade controls if the item is not a quantity stack
      if (!isQuantity) {
        const row = buildSliderControls(baseItemName, upgradeLevel);
        replyOptions.components = [row];
      }

      await interaction.editReply(replyOptions);
    } catch (err) {
      console.error('Error rendering card:', err);
      await interaction.editReply(`❌ Failed to render card for **${baseItemName}**: ${err.message}`);
    }
  },

  buildSliderControls
};