const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const axios = require('axios');
const db = require('../db');
const { validateWikiItem } = require('../wikiScraper');
const { parseEqInventoryText, groupInventoryItems } = require('../inventoryParser');

// In-memory active import sessions keyed by userId
// Holds: { items: Array, selectedIndices: Set, page: number, expiresAt: number }
const importSessions = new Map();

// Clean up expired sessions periodically (15 minutes lifespan)
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of importSessions.entries()) {
    if (session.expiresAt && session.expiresAt < now) {
      importSessions.delete(userId);
    }
  }
}, 60000);

const PAGE_SIZE = 15;

function buildImportResponse(userId, page = 1) {
  const session = importSessions.get(userId);
  if (!session || !session.items || session.items.length === 0) {
    return {
      content: '❌ No active inventory import session found. Please run `/g-import` again.',
      components: [],
      embeds: []
    };
  }

  const { items, selectedIndices } = session;
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const validPage = Math.min(Math.max(1, page), totalPages);
  session.page = validPage;

  const startIndex = (validPage - 1) * PAGE_SIZE;
  const pageItems = items.slice(startIndex, startIndex + PAGE_SIZE);

  const selectedCount = selectedIndices.size;

  // Format list preview
  const lines = pageItems.map((item, idx) => {
    const globalIndex = startIndex + idx;
    const isSelected = selectedIndices.has(globalIndex);
    const checkIcon = isSelected ? '✅' : '◻️';
    const upgradeStr = item.upgradeLevel && item.upgradeLevel !== '+0' ? ` [${item.upgradeLevel}]` : '';
    const locStr = item.locations?.length ? ` (${item.locations.slice(0, 2).join(', ')})` : '';
    const exaltsNote = item.exaltsSummary ? `\n   ↳ ${item.exaltsSummary}` : '';
    return `${checkIcon} **#${globalIndex + 1}**: ${item.cleanItemName}${upgradeStr}${locStr} ×${item.totalCount}${exaltsNote}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📥 EverQuest Inventory Import: Select Items to Donate')
    .setDescription(
      `Select the items from your bags/bank to offer to the guild gear pool.\n` +
      `Items maintain attached exalts/ornaments. Use the dropdown or action buttons below.\n\n` +
      lines.join('\n')
    )
    .setColor(0x2ecc71)
    .setFooter({
      text: `Page ${validPage} of ${totalPages} | ${selectedCount} item(s) currently selected for donation`
    });

  const components = [];

  // Dropdown for selecting items on current page
  if (pageItems.length > 0) {
    const selectOptions = pageItems.map((item, idx) => {
      const globalIndex = startIndex + idx;
      const isSelected = selectedIndices.has(globalIndex);
      const upgradeStr = item.upgradeLevel && item.upgradeLevel !== '+0' ? ` ${item.upgradeLevel}` : '';
      const desc = item.exaltsSummary
        ? item.exaltsSummary.slice(0, 100)
        : `Count: ${item.totalCount} | Location: ${item.locations?.[0] || 'Inventory'}`.slice(0, 100);

      return new StringSelectMenuOptionBuilder()
        .setLabel(`#${globalIndex + 1}: ${item.cleanItemName}${upgradeStr}`.slice(0, 100))
        .setDescription(desc)
        .setValue(String(globalIndex))
        .setDefault(isSelected)
        .setEmoji(isSelected ? '✅' : (item.hasExalts ? '✨' : '📦'));
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`gimport_toggle_${validPage}`)
      .setPlaceholder('Choose items from this page to toggle selection...')
      .setMinValues(1)
      .setMaxValues(pageItems.length)
      .addOptions(selectOptions);

    components.push(new ActionRowBuilder().addComponents(selectMenu));
  }

  // Row 2: Action Buttons
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gimport_page_all_${validPage}`)
      .setLabel('Select All on Page')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('☑️'),
    new ButtonBuilder()
      .setCustomId(`gimport_clear_${validPage}`)
      .setLabel('Clear Selection')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄'),
    new ButtonBuilder()
      .setCustomId('gimport_confirm')
      .setLabel(`Confirm Import (${selectedCount})`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(selectedCount === 0)
      .setEmoji('🛡️'),
    new ButtonBuilder()
      .setCustomId('gimport_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('✖')
  );
  components.push(actionRow);

  // Row 3: Navigation row if multiple pages
  if (totalPages > 1) {
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gimport_nav_${validPage - 1}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(validPage <= 1),
      new ButtonBuilder()
        .setCustomId('gimport_page_info')
        .setLabel(`Page ${validPage}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`gimport_nav_${validPage + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(validPage >= totalPages)
    );
    components.push(navRow);
  }

  return { embeds: [embed], components };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g-import')
    .setDescription('Upload the file from /outputfile inventory (in-game) to donate items.')
    .addAttachmentOption(option =>
      option.setName('inventory_file')
        .setDescription('The <CharacterName>-Inventory.txt file produced by /outputfile inventory')
        .setRequired(true)
    ),

  buildImportResponse,
  importSessions,

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const attachment = interaction.options.getAttachment('inventory_file');
    if (!attachment) {
      return interaction.editReply('❌ Please attach your `-Inventory.txt` file.');
    }

    if (!attachment.name.toLowerCase().endsWith('-inventory.txt')) {
      return interaction.editReply(
        '❌ That doesn\'t look like an inventory dump. In game, run `/outputfile inventory` (no filename needed — ' +
        'EQ names it `<CharacterName>-Inventory.txt` for you) and upload that file.'
      );
    }

    // Limit file size to 2MB to prevent memory exhaustion
    if (attachment.size > 2 * 1024 * 1024) {
      return interaction.editReply('❌ File is too large. Please upload an inventory file under 2MB.');
    }

    try {
      const response = await axios.get(attachment.url, {
        responseType: 'text',
        timeout: 10000,
        headers: { 'User-Agent': 'EQGearBot/1.0' }
      });

      const rawText = String(response.data || '');
      const parsedItems = parseEqInventoryText(rawText);

      if (parsedItems.length === 0) {
        return interaction.editReply(
          '❌ No valid items found in the uploaded file.\n' +
          'Ensure the file was generated using the in-game command: `/outputfile inventory`'
        );
      }

      const grouped = groupInventoryItems(parsedItems);

      // Save session
      importSessions.set(interaction.user.id, {
        items: grouped,
        selectedIndices: new Set(),
        page: 1,
        expiresAt: Date.now() + 15 * 60 * 1000 // 15 min
      });

      const replyData = buildImportResponse(interaction.user.id, 1);
      await interaction.editReply(replyData);
    } catch (err) {
      console.error('Failed to download or parse inventory file:', err);
      await interaction.editReply(`❌ Error reading attachment: ${err.message}`);
    }
  }
};
