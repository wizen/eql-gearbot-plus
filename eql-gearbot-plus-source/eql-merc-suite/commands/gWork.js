const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  EmbedBuilder,
  PermissionsBitField,
  MessageFlags
} = require('discord.js');
const db = require('../db');
const { GUILD_NAME } = require('../config');

const STATUS_LABEL = {
  unclaimed: '🟢 Unclaimed',
  claimed: '🟡 Claimed',
  complete: '✅ Complete',
  delivered: '📬 Delivered',
  cancelled: '🚫 Cancelled'
};

function skillLine(order) {
  return order.skill_level_required
    ? `${order.skill_required} (Trivial: ${order.skill_level_required})`
    : order.skill_required;
}

function formatOrderLine(order, index) {
  const crafterText = order.claimed_by_discord_name ? ` | Crafter: ${order.claimed_by_discord_name}` : '';
  const notesText = order.notes ? `\n   ↳ *${order.notes}*` : '';
  return `${index + 1}. **${order.item_name}** (x${order.quantity}) — \`${skillLine(order)}\` [${STATUS_LABEL[order.status] || order.status}]${crafterText}\n   Requested by: **${order.requester_character}**${notesText}`;
}

/**
 * Mirrors gList.js's buildListResponse two-dropdown pattern (select an item,
 * then select an action for it) rather than the one-dropdown-then-ephemeral-
 * buttons flow this used to be — same UX shape as the gear bank so both
 * feel like one interface, and it's what lets a "Mark Delivered" option
 * show up as just another dropdown entry instead of a separate button type.
 *
 * The whole response is ephemeral (see execute()) specifically so two
 * people running /g-work at the same time each get their own independent
 * dropdown state, rather than one shared public message whose selection menus
 * would get stepped on by whoever clicks next — the gear list avoids that
 * the same way.
 */
// `opts.notice`, when passed, is a one-line confirmation ("✅ Marked order #12
// complete") folded into the top of this same message instead of being sent
// as a separate followUp — so claim/complete/deliver/cancel/delete never
// open a second ephemeral message alongside the list; it's just updated in
// place to show what happened. See index.js's workorder_select_action_
// handler, which passes this instead of calling interaction.followUp.
function buildWorkOrderResponse(viewerUserId = null, isOfficer = false, filter = 'unclaimed', selectedOrderId = null, opts = {}) {
  const { notice = null } = opts;
  const orders = db.getAllWorkOrders(filter === 'all' ? null : filter);
  const noticePrefix = notice ? `> ${notice}\n\n` : '';

  const embed = new EmbedBuilder()
    .setTitle(`📋 <${GUILD_NAME}> Guild Work Orders`)
    .setColor(0xd97706)
    .setFooter({
      text: `Showing: ${filter === 'all' ? 'All' : (STATUS_LABEL[filter] || filter)} | Total: ${orders.length}`
    });

  if (orders.length === 0) {
    embed.setDescription(`${noticePrefix}*No work orders here.* Use \`/g-addwork\` to post one, or Apprentice can submit one for you.`);
    return { embeds: [embed], components: [] };
  }

  // Discord select menus cap at 25 options.
  const pageOrders = orders.slice(0, 25);
  embed.setDescription(
    noticePrefix +
    pageOrders.map((o, i) => formatOrderLine(o, i)).join('\n\n') +
    (orders.length > 25 ? `\n\n*...and ${orders.length - 25} more. Narrow with \`filter\` to see the rest.*` : '')
  );

  const components = [];

  const validSelected = pageOrders.find(o => String(o.id) === String(selectedOrderId)) || pageOrders[0];
  const activeId = validSelected ? String(validSelected.id) : null;

  const orderOptions = pageOrders.map((o, i) => {
    const option = new StringSelectMenuOptionBuilder()
      .setLabel(`#${i + 1}: ${o.item_name}`.slice(0, 100))
      .setDescription(`${STATUS_LABEL[o.status] || o.status} | Req: ${o.requester_character}`.slice(0, 100))
      .setValue(String(o.id))
      .setEmoji('📦');
    if (String(o.id) === activeId) option.setDefault(true);
    return option;
  });

  const orderSelectMenu = new StringSelectMenuBuilder()
    .setCustomId(`workorder_select_item_${filter}`)
    .setPlaceholder('Select a work order...')
    .addOptions(orderOptions);
  components.push(new ActionRowBuilder().addComponents(orderSelectMenu));

  // Action dropdown (dropdown 2) — contextual to the selected order's status
  // and the viewer's relationship to it, same as gear list's action menu.
  if (validSelected) {
    const isRequester = Boolean(viewerUserId && validSelected.requester_discord_id === viewerUserId);
    const isCrafter = Boolean(viewerUserId && validSelected.claimed_by_discord_id === viewerUserId);
    const actionOptions = [];

    if (validSelected.status === 'unclaimed' && !isRequester) {
      actionOptions.push(
        new StringSelectMenuOptionBuilder()
          .setLabel('Claim This Order')
          .setDescription('Take this order on to craft or gather it')
          .setValue(`claim_${validSelected.id}`)
          .setEmoji('🛠️')
      );
    }
    if (validSelected.status === 'claimed' && (isCrafter || isRequester || isOfficer)) {
      actionOptions.push(
        new StringSelectMenuOptionBuilder()
          .setLabel('Mark Complete')
          .setDescription("Crafted/gathered — not yet handed over")
          .setValue(`complete_${validSelected.id}`)
          .setEmoji('✅')
      );
    }
    if (validSelected.status === 'complete' && (isCrafter || isRequester || isOfficer)) {
      actionOptions.push(
        new StringSelectMenuOptionBuilder()
          .setLabel('Mark Delivered')
          .setDescription('Item has actually been handed over — auto-removed in 24h')
          .setValue(`deliver_${validSelected.id}`)
          .setEmoji('📬')
      );
    }
    if ((validSelected.status === 'unclaimed' || validSelected.status === 'claimed') && (isRequester || isOfficer)) {
      actionOptions.push(
        new StringSelectMenuOptionBuilder()
          .setLabel('Cancel Order')
          .setDescription('Withdraw this work order (auto-removed in 24h)')
          .setValue(`cancel_${validSelected.id}`)
          .setEmoji('✖️')
      );
    }
    // Officer-only, any status, immediate and permanent — unlike Cancel,
    // this doesn't wait 24h and isn't limited to unclaimed/claimed orders.
    if (isOfficer) {
      actionOptions.push(
        new StringSelectMenuOptionBuilder()
          .setLabel('Delete Order (Officer)')
          .setDescription('Permanently remove this order right now')
          .setValue(`delete_${validSelected.id}`)
          .setEmoji('🗑️')
      );
    }

    if (actionOptions.length > 0) {
      const actionSelectMenu = new StringSelectMenuBuilder()
        .setCustomId(`workorder_select_action_${filter}`)
        .setPlaceholder(`Select action for: #${validSelected.id} ${validSelected.item_name}`)
        .addOptions(actionOptions);
      components.push(new ActionRowBuilder().addComponents(actionSelectMenu));
    }
  }

  return { embeds: [embed], components };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g-work')
    .setDescription('View, claim, and manage active guild work orders.')
    .addStringOption(option =>
      option.setName('filter')
        .setDescription('Filter orders by status')
        .setRequired(false)
        .addChoices(
          { name: 'All Orders', value: 'all' },
          { name: 'Unclaimed', value: 'unclaimed' },
          { name: 'Claimed', value: 'claimed' },
          { name: 'Complete (awaiting delivery)', value: 'complete' },
          { name: 'Delivered', value: 'delivered' }
        )
    ),

  buildWorkOrderResponse,

  async execute(interaction) {
    // Ephemeral, matching /g-list — see the note on buildWorkOrderResponse
    // for why: two dropdowns sharing one public message would let one
    // person's selection clobber what another person is looking at.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const filter = interaction.options.getString('filter') || 'unclaimed';

    const authorizedRoles = (process.env.AUTHORIZED_ROLE_IDS || '').split(',').map(r => r.trim());
    const hasOfficerRole = interaction.member?.roles?.cache?.some(r => authorizedRoles.includes(r.id));
    const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
    const isOfficer = Boolean(hasOfficerRole || isAdmin);

    const response = buildWorkOrderResponse(interaction.user.id, isOfficer, filter);
    await interaction.editReply(response);
  }
};
