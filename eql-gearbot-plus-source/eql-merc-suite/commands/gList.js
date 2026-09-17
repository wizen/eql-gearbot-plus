const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, EmbedBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const db = require('../db');
const { formatExaltsSummary } = require('../inventoryParser');
const { GUILD_NAME } = require('../config');

/**
 * `opts.notice`, when passed, is a one-line confirmation ("✋ You have claimed
 * X!") folded into the top of this same message instead of being sent as a
 * separate followUp — so a claim/withdraw/remove never opens a second
 * ephemeral message alongside the list; the list message itself is just
 * updated in place to show what happened.
 *
 * `opts.frozen`, when true, disables every select menu/button this returns.
 * Used right before opening a genuinely separate new message (the item card
 * image) that the interaction can't also fold into this one — the list gets
 * frozen in place as a read-only snapshot via interaction.update(), and the
 * card itself goes out afterward as an interaction.followUp(). That's what
 * keeps a dismissed step visually inert instead of staying clickable once a
 * new post has opened from it. See index.js's select-menu handlers.
 */
function buildListResponse(viewerUserId = null, isOfficer = false, page = 1, selectedItemId = null, opts = {}) {
  const { notice = null, frozen = false } = opts;
  const items = db.getAllGear();
  const noticePrefix = notice ? `> ${notice}\n\n` : '';

  if (items.length === 0) {
    return {
      content: notice ? `${notice}\n\n📦 The gear list is currently empty. Use \`/g-add\` or \`/g-stock\` to add items.` : '📦 The gear list is currently empty. Use `/g-add` or `/g-stock` to add items.',
      embeds: [],
      components: []
    };
  }

  // Display up to 10 items per page with dropdown navigation
  const PAGE_SIZE = 10;
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const validPage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (validPage - 1) * PAGE_SIZE;
  const pageItems = items.slice(startIndex, startIndex + PAGE_SIZE);

  // Format ordered list: 1. itemname - held by name - (unclaimed/claimed by name)
  const listLines = pageItems.map((item, index) => {
    const listNumber = index + 1; // 1-based index per page
    const itemName = item.upgrade_level && item.upgrade_level !== '+0'
      ? `${item.base_item_name} ${item.upgrade_level}`
      : item.base_item_name;
    const heldBy = item.added_by_username || 'Unknown';
    const status = item.requested_by_username
      ? `claimed by ${item.requested_by_username}`
      : 'unclaimed';

    let exaltsNote = '';
    if (item.exalts_json) {
      try {
        const ex = JSON.parse(item.exalts_json);
        const summary = formatExaltsSummary(ex);
        if (summary) exaltsNote = `\n   ↳ ${summary}`;
      } catch (e) {}
    }

    return `${listNumber}. ${itemName} - held by ${heldBy} - (${status})${exaltsNote}`;
  });

  const listText = listLines.join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`<${GUILD_NAME}> Spare Gear List`)
    .setDescription(`${noticePrefix}${listText}`)
    .setColor(0x3498db)
    .setFooter({ 
      text: `Page ${validPage} of ${totalPages} | Total Items: ${items.length}` 
    });

  const components = [];

  // 1. Select Menu: Item Selection (Dropdown 1)
  const validSelectedItem = pageItems.find(it => String(it.id) === String(selectedItemId)) || pageItems[0];
  const activeItemId = validSelectedItem ? String(validSelectedItem.id) : null;

  const itemSelectOptions = pageItems.map((item, index) => {
    const itemNumber = index + 1;
    const itemName = item.upgrade_level && item.upgrade_level !== '+0'
      ? `${item.base_item_name} ${item.upgrade_level}`
      : item.base_item_name;
    const isAdder = Boolean(viewerUserId && item.added_by_user_id === viewerUserId);
    let exSummary = '';
    if (item.exalts_json) {
      try {
        const ex = JSON.parse(item.exalts_json);
        exSummary = formatExaltsSummary(ex);
      } catch (e) {}
    }

    const baseStatus = item.requested_by_username 
      ? `Claimed by ${item.requested_by_username}` 
      : (isAdder ? 'Held by You (Donor)' : `Held by ${item.added_by_username}`);
    const statusDesc = exSummary ? `${exSummary} | ${baseStatus}` : baseStatus;

    const option = new StringSelectMenuOptionBuilder()
      .setLabel(`#${itemNumber}: ${itemName}`.slice(0, 100))
      .setDescription(statusDesc.slice(0, 100))
      .setValue(String(item.id))
      .setEmoji(item.requested_by_username ? '✋' : (exSummary ? '✨' : '🛡️'));

    if (String(item.id) === activeItemId) {
      option.setDefault(true);
    }
    return option;
  });

  const itemSelectMenu = new StringSelectMenuBuilder()
    .setCustomId(`glist_select_item_${validPage}`)
    .setPlaceholder('Select an item from the list...')
    .setDisabled(frozen)
    .addOptions(itemSelectOptions);

  components.push(new ActionRowBuilder().addComponents(itemSelectMenu));

  // 2. Select Menu: Action Selection (Dropdown 2)
  // Dynamically populated based on viewer's status as donor vs requester vs officer
  if (validSelectedItem) {
    const isAdder = Boolean(viewerUserId && validSelectedItem.added_by_user_id === viewerUserId);
    const isClaimant = Boolean(viewerUserId && validSelectedItem.requested_by_user_id === viewerUserId);
    const isClaimed = Boolean(validSelectedItem.requested_by_user_id);
    const canRemove = isAdder || isOfficer;

    const actionOptions = [];

    // Always allow viewing the item card
    actionOptions.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('View Wiki Item Card')
        .setDescription('Generate and display the eqlwiki card PNG')
        .setValue(`view_${validSelectedItem.id}`)
        .setEmoji('👁️')
    );

    // If viewer is NOT the donor: allow claim or withdraw
    if (!isAdder) {
      if (!isClaimed) {
        actionOptions.push(
          new StringSelectMenuOptionBuilder()
            .setLabel('Claim Item')
            .setDescription('Request this item from the holder')
            .setValue(`claim_${validSelectedItem.id}`)
            .setEmoji('✋')
        );
      } else if (isClaimant) {
        actionOptions.push(
          new StringSelectMenuOptionBuilder()
            .setLabel('Withdraw Claim')
            .setDescription('Cancel your request on this item')
            .setValue(`withdraw_${validSelectedItem.id}`)
            .setEmoji('↩️')
        );
      }
    }

    // Remove Item: available to the donor (adder) or anyone with officer/admin permissions
    if (canRemove) {
      actionOptions.push(
        new StringSelectMenuOptionBuilder()
          .setLabel('Remove Item')
          .setDescription(isAdder ? 'Remove your item from inventory' : 'Officer: remove item from inventory')
          .setValue(`remove_${validSelectedItem.id}`)
          .setEmoji('🗑️')
      );
    }

    const actionSelectMenu = new StringSelectMenuBuilder()
      .setCustomId(`glist_select_action_${validPage}_${validSelectedItem.id}`)
      .setPlaceholder(`Select action for: ${validSelectedItem.base_item_name}`)
      .setDisabled(frozen)
      .addOptions(actionOptions);

    components.push(new ActionRowBuilder().addComponents(actionSelectMenu));
  }

  // 3. Navigation Controls Row (if multiple pages exist)
  if (totalPages > 1) {
    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gpage_${validPage - 1}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(frozen || validPage <= 1),
      new ButtonBuilder()
        .setCustomId('gpage_info')
        .setLabel(`Page ${validPage}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`gpage_${validPage + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(frozen || validPage >= totalPages)
    );
    components.push(navRow);
  }

  return { embeds: [embed], components };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g-list')
    .setDescription('Display the community gear list with claim & request controls.'),

  buildListResponse,

  async execute(interaction) {
    // Acknowledge interaction immediately within Discord's 3-second window as ephemeral
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const authorizedRoles = (process.env.AUTHORIZED_ROLE_IDS || '').split(',').map(r => r.trim());
    const hasRole = interaction.member?.roles?.cache?.some(r => authorizedRoles.includes(r.id));
    const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
    const isOfficer = Boolean(hasRole || isAdmin);

    const response = buildListResponse(interaction.user.id, isOfficer);
    await interaction.editReply(response);
  }
};