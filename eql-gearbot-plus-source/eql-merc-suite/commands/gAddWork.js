const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { searchWikiAutocomplete, parseItemInput, getSkillTrivial, validateWikiItem } = require('../wikiScraper');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g-addwork')
    .setDescription('Create a guild work order for an item you need crafted or gathered.')
    .addStringOption(option =>
      option.setName('item_name')
        .setDescription('Item name needed')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(option =>
      option.setName('quantity')
        .setDescription('Quantity needed (default 1)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(1000)
    )
    .addStringOption(option =>
      option.setName('notes')
        .setDescription('Notes or tip offered (e.g. "Will provide materials + 100pp tip")')
        .setRequired(false)
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    if (!focusedValue || focusedValue.length < 2) return interaction.respond([]);
    const suggestions = await searchWikiAutocomplete(focusedValue);
    await interaction.respond(
      suggestions.slice(0, 25).map(item => ({ name: item, value: item }))
    );
  },

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rawName = interaction.options.getString('item_name');
    const quantity = interaction.options.getInteger('quantity') || 1;
    const notes = interaction.options.getString('notes') || '';
    const { baseItemName } = parseItemInput(rawName);

    if (!baseItemName) {
      return interaction.editReply('❌ Please specify a valid item name.');
    }

    // Validate + canonicalize against eqlwiki.com, same as /g-add and every
    // other item-name command.
    const { isValid, canonicalName } = await validateWikiItem(baseItemName);
    if (!isValid) {
      return interaction.editReply(`❌ Could not validate **${baseItemName}** on eqlwiki.com. Please check spelling or check https://eqlwiki.com.`);
    }
    const itemName = canonicalName || baseItemName;

    // Skill + trivial always come from the item's recorded player-crafted
    // recipe on eqlwiki.com — no manual entry, so there's nothing for a
    // requester to mistype or guess wrong.
    const trivialInfo = await getSkillTrivial(itemName);
    const wikiLookupFailed = !trivialInfo;
    const skill = trivialInfo?.tradeskill || 'Crafting';
    const skillLevel = trivialInfo?.trivialLevel ?? null;

    const order = db.createWorkOrder({
      itemName,
      quantity,
      skillRequired: skill,
      skillLevelRequired: skillLevel,
      sourceType: 'crafted',
      requesterCharacter: interaction.user.username,
      requesterDiscordId: interaction.user.id,
      requesterDiscordName: interaction.user.username,
      notes
    });

    let reply = `✅ **Work Order Created!** (#${order.id})\n`;
    reply += `📦 Item: **${order.itemName}** (Quantity: ${quantity})\n`;
    reply += `🛠️ Skill: **${skill}**${skillLevel ? ` (Trivial: ${skillLevel})` : ''}\n`;
    reply += `👤 Requester: **@${interaction.user.username}**\n`;
    if (notes) reply += `📝 Notes: *${notes}*\n`;
    if (wikiLookupFailed) {
      reply += `\n*Couldn't find a recorded recipe for this item on eqlwiki.com — it's been posted as a generic "Crafting" order. A crafter can still claim and fill it.*`;
    }
    reply += `\n*Crafters can claim this using \`/g-work\`.*`;

    await interaction.editReply(reply);
  }
};
