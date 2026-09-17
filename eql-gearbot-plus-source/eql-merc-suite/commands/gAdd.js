const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { parseItemInput, searchWikiAutocomplete, validateWikiItem } = require('../wikiScraper');

const UPGRADE_CHOICES = [
  { name: '+0 (Base / Unenchanted)', value: '+0' },
  { name: '+1', value: '+1' },
  { name: '+2', value: '+2' },
  { name: '+3', value: '+3' },
  { name: '+4', value: '+4' },
  { name: '+5', value: '+5' },
  { name: '+6', value: '+6' },
  { name: '+7', value: '+7' },
  { name: '+8', value: '+8' },
  { name: '+9', value: '+9' },
  { name: '+10', value: '+10' }
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g-add')
    .setDescription('Add a gear item with an upgrade level to the volunteer list.')
    .addStringOption(option =>
      option.setName('item_name')
        .setDescription('Item name to look up on eqlwiki.com')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName('upgrade_level')
        .setDescription('Upgrade level of the gear (+0 to +10)')
        .setRequired(true)
        .addChoices(...UPGRADE_CHOICES)
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
    const selectedUpgrade = interaction.options.getString('upgrade_level');
    const { baseItemName } = parseItemInput(rawInput);

    if (!baseItemName) {
      return interaction.editReply('❌ Please specify a valid item name.');
    }

    const { isValid, wikiUrl, canonicalName } = await validateWikiItem(baseItemName);

    if (!isValid) {
      return interaction.editReply(`❌ Could not validate **${baseItemName}** on eqlwiki.com. Please check spelling or check https://eqlwiki.com.`);
    }

    const officialItemName = canonicalName || baseItemName;
    const upgradeLevel = selectedUpgrade || '+0';
    const username = interaction.member?.displayName || interaction.user.username;
    db.addGear(officialItemName, upgradeLevel, wikiUrl, interaction.user.id, username);

    const levelSuffix = (upgradeLevel && upgradeLevel !== '+0') ? ` ${upgradeLevel}` : '';
    await interaction.editReply(
      `✅ Added **[${officialItemName}${levelSuffix}](${wikiUrl})** to the list! (Held by **${username}**)`
    );
  }
};