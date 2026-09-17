require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Builds the companion website from source on every startup, so uploading a
// pre-built website-dist/ (rebuild locally, rezip, re-upload every change)
// is no longer required — just upload website-src/ alongside this folder
// and restart. Runs synchronously, before anything else, so website-dist/
// is ready by the time api/server.js checks for it below.
// Trade-off: this makes every restart slower (npm install + vite build for
// the website's own toolchain) instead of shipping a pre-built dist. npm
// install is skipped on restarts where website-src/package-lock.json
// hasn't changed, so only a dependency bump pays that cost again.
function buildWebsiteIfPresent() {
  const websiteSrc = path.join(__dirname, 'website-src');
  const websiteDist = path.join(__dirname, 'website-dist');

  if (!fs.existsSync(path.join(websiteSrc, 'package.json'))) {
    console.log('ℹ️  No website-src/ found — skipping website build (API-only mode).');
    return;
  }

  try {
    const nodeModulesPath = path.join(websiteSrc, 'node_modules');
    const lockPath = path.join(websiteSrc, 'package-lock.json');
    const stampPath = path.join(websiteSrc, '.install-stamp');
    const lockFingerprint = fs.existsSync(lockPath)
      ? `${fs.statSync(lockPath).size}:${fs.statSync(lockPath).mtimeMs}`
      : 'no-lock';
    const prevFingerprint = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8') : null;

    if (!fs.existsSync(nodeModulesPath) || prevFingerprint !== lockFingerprint) {
      console.log('📦 Installing gearbot-website dependencies (first run or dependencies changed)...');
      execSync('npm install', { cwd: websiteSrc, stdio: 'inherit' });
      fs.writeFileSync(stampPath, lockFingerprint);
    } else {
      console.log('📦 gearbot-website dependencies unchanged — skipping npm install.');
    }

    console.log('🔨 Building gearbot-website...');
    // build:remote skips the tsc --noEmit type-check gate that "build" runs
    // locally — on at least one real host this failed with 300+ spurious
    // type errors (every file, including trivial ones) despite the code
    // being fine, almost certainly a broken/partial @types install in that
    // environment. vite build doesn't need those types to succeed (it just
    // strips TS syntax via esbuild), so skipping the gate here avoids a
    // flaky environment issue blocking an otherwise-working build.
    execSync('npm run build:remote', { cwd: websiteSrc, stdio: 'inherit' });

    if (fs.existsSync(websiteDist)) {
      fs.rmSync(websiteDist, { recursive: true, force: true });
    }
    fs.cpSync(path.join(websiteSrc, 'dist'), websiteDist, { recursive: true });
    console.log('✅ gearbot-website built and copied to website-dist/.');
  } catch (err) {
    console.error('⚠️  Website build failed — continuing in API-only mode:', err.message);
  }
}
buildWebsiteIfPresent();

const { Client, GatewayIntentBits, Collection, REST, Routes, PermissionsBitField, AttachmentBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { version: SUITE_VERSION } = require('./package.json');
const db = require('./db');
const { generateCardPng } = require('./cardRenderer');
const { buildListResponse } = require('./commands/gList');
const { buildSliderControls } = require('./commands/gCard');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

const gAdd = require('./commands/gAdd');
const gStock = require('./commands/gStock');
const gList = require('./commands/gList');
const gCard = require('./commands/gCard');
const gPlus10 = require('./commands/gPlus10');
const gImport = require('./commands/gImport');
const gFind = require('./commands/gFind');
// /g-vault (full character-inventory lookup, synced from Apprentice) was
// removed - it was scope creep for a guild gear bank to hold a standing
// copy of everyone's personal inventory. See commands/gVault.js and db.js.
const gWork = require('./commands/gWork');
const gAddWork = require('./commands/gAddWork');
const gApiKey = require('./commands/gApiKey');

client.commands.set(gAdd.data.name, gAdd);
client.commands.set(gStock.data.name, gStock);
client.commands.set(gList.data.name, gList);
client.commands.set(gCard.data.name, gCard);
client.commands.set(gPlus10.data.name, gPlus10);
client.commands.set(gImport.data.name, gImport);
client.commands.set(gFind.data.name, gFind);
client.commands.set(gWork.data.name, gWork);
client.commands.set(gAddWork.data.name, gAddWork);
client.commands.set(gApiKey.data.name, gApiKey);

// The web API (companion website + Apprentice) runs in this same process so
// it shares this one Discord client and one db.js connection — see api/server.js.
const { startApiServer } = require('./api/server');
startApiServer(client);

// Register Slash Commands
// Using clientReady event (ready is deprecated in discord.js v14 and renamed in v15)
const readyEvent = Client.prototype.hasOwnProperty('clientReady') || 'clientReady' in client ? 'clientReady' : 'ready';
client.once('clientReady', async () => {
  // Printed on every startup so you can always tell, from the Wispbyte
  // console log, exactly which build is actually running — compare this
  // against the version number in the filename of the last deploy zip you
  // uploaded. Also exposed live at GET /api/health (and shown in the
  // website's header) for a check that doesn't require console access.
  console.log(`🛡️ Gearbot v${SUITE_VERSION} — logged in as ${client.user.tag}`);

  if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
    console.warn('⚠️ DISCORD_TOKEN or CLIENT_ID is missing in .env. Skipping slash command registration.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commandData = Array.from(client.commands.values()).map(c => c.data.toJSON());

  try {
    if (process.env.GUILD_ID && process.env.GUILD_ID.trim() !== '') {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commandData }
      );
      console.log(`✅ Registered guild slash commands for guild ${process.env.GUILD_ID}.`);
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commandData }
      );
      console.log('✅ Registered global slash commands.');
    }
  } catch (err) {
    console.error('❌ Command registration error:', err);
  }

  // Delivered AND cancelled work orders are swept away 24h after they hit
  // that terminal state, so the list doesn't accumulate fulfilled or
  // withdrawn orders forever (see db.cleanupExpiredWorkOrders). Runs once
  // at startup, then every 15 minutes — frequent enough that nothing sits
  // around for much longer than the 24h it's owed, cheap enough that it's
  // a non-event for a 0.5GB host.
  const runWorkOrderCleanup = () => {
    try {
      const purged = db.cleanupExpiredWorkOrders();
      if (purged > 0) {
        console.log(`🧹 Purged ${purged} delivered/cancelled work order(s) past their 24h window.`);
      }
    } catch (err) {
      console.error('Work order cleanup error:', err);
    }
  };
  runWorkOrderCleanup();
  setInterval(runWorkOrderCleanup, 15 * 60 * 1000);
});

// Interaction Handling
client.on('interactionCreate', async interaction => {
  try {
    // 1. Slash Commands
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      try {
        await command.execute(interaction);
      } catch (error) {
        console.error('Command execution error:', error);
        // Avoid sending reply if interaction has timed out (DiscordAPIError 10062)
        if (error.code === 10062) return;
        const reply = { content: '❌ There was an error executing this command!', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
        else await interaction.reply(reply).catch(() => {});
      }
    }

    // 2. Autocomplete
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command?.autocomplete) {
        try {
          await command.autocomplete(interaction);
        } catch (autoErr) {
          console.error('Autocomplete error:', autoErr);
        }
      }
    }

    // 3. Button Interactions
    if (interaction.isButton()) {
      const parts = interaction.customId.split('_');
      const action = parts[0];
      const param1 = parts[1];
      const param2 = parts[2];

      // Note: the old per-item "card"/"remove"/"request"/"withdraw" buttons
      // and the "slide" card-slider buttons were an earlier UI, from before
      // /g-list moved to the two-dropdown pattern below. Nothing in this
      // codebase generates those customIds anymore (buildListResponse only
      // ever emits glist_select_item_/glist_select_action_/gpage_), so
      // those handlers were dead code and have been removed rather than
      // fixed for the ephemeral/single-message changes described below.

      // Paging Navigation Button
      if (action === 'gpage') {
        const targetPage = parseInt(param1, 10) || 1;
        const authorizedRoles = (process.env.AUTHORIZED_ROLE_IDS || '').split(',').map(r => r.trim());
        const hasOfficerRole = interaction.member?.roles?.cache?.some(r => authorizedRoles.includes(r.id));
        const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
        const isOfficer = Boolean(hasOfficerRole || isAdmin);

        const updatedList = buildListResponse(interaction.user.id, isOfficer, targetPage);
        await interaction.update(updatedList);
        return;
      }

      // Card Slider Buttons (legacy support)
      if (action === 'slide') {
        await interaction.deferUpdate();
        const baseItemName = decodeURIComponent(param1);
        const targetLevel = param2;
        const formattedTitle = baseItemName.replace(/\s+/g, '_');
        const wikiUrl = `https://eqlwiki.com/${encodeURIComponent(formattedTitle)}`;

        try {
          const imageBuffer = await generateCardPng(wikiUrl, targetLevel);
          const attachment = new AttachmentBuilder(imageBuffer, { name: 'card.png' });
          const row = buildSliderControls(baseItemName, targetLevel);

          await interaction.editReply({ files: [attachment], components: [row] });
        } catch (slideErr) {
          console.error('Slider update error:', slideErr);
        }
      }

      // Inventory Import Controls
      if (action === 'gimport') {
        const subAction = param1;
        const pageArg = parseInt(param2, 10) || 1;

        if (subAction === 'cancel') {
          gImport.importSessions.delete(interaction.user.id);
          return interaction.update({
            content: '❌ Inventory import cancelled.',
            embeds: [],
            components: []
          });
        }

        const session = gImport.importSessions.get(interaction.user.id);
        if (!session) {
          return interaction.reply({
            content: '❌ Your import session has expired. Please run `/g-import` again.',
            flags: MessageFlags.Ephemeral
          });
        }

        // Paging
        if (subAction === 'nav') {
          const updated = gImport.buildImportResponse(interaction.user.id, pageArg);
          return interaction.update(updated);
        }

        // Select All on current page
        if (subAction === 'page' && parts[2] === 'all') {
          const page = parseInt(parts[3], 10) || 1;
          const PAGE_SIZE = 15;
          const startIndex = (page - 1) * PAGE_SIZE;
          const pageItems = session.items.slice(startIndex, startIndex + PAGE_SIZE);
          pageItems.forEach((_, idx) => session.selectedIndices.add(startIndex + idx));
          const updated = gImport.buildImportResponse(interaction.user.id, page);
          return interaction.update(updated);
        }

        // Clear All
        if (subAction === 'clear') {
          session.selectedIndices.clear();
          const page = parseInt(parts[2], 10) || 1;
          const updated = gImport.buildImportResponse(interaction.user.id, page);
          return interaction.update(updated);
        }

        // Confirm & Batch Import into DB
        if (subAction === 'confirm') {
          await interaction.deferUpdate();
          const selectedIndices = Array.from(session.selectedIndices).sort((a, b) => a - b);
          if (selectedIndices.length === 0) {
            return interaction.followUp({
              content: '⚠️ No items were selected to import.',
              flags: MessageFlags.Ephemeral
            });
          }

          const username = interaction.member?.displayName || interaction.user.username;
          const successful = [];
          const failed = [];

          for (const idx of selectedIndices) {
            const item = session.items[idx];
            if (!item) continue;
            try {
              const { validateWikiItem } = require('./wikiScraper');
              const { isValid, wikiUrl, canonicalName } = await validateWikiItem(item.cleanItemName);
              if (isValid) {
                const officialName = canonicalName || item.cleanItemName;
                const exaltsJson = item.exalts && item.hasExalts ? JSON.stringify(item.exalts) : null;
                db.addGear(officialName, item.upgradeLevel || '+0', wikiUrl, interaction.user.id, username, exaltsJson);
                const exaltStr = item.exaltsSummary ? ` [${item.exaltsSummary}]` : '';
                successful.push(`${officialName} (${item.upgradeLevel})${exaltStr}`);
              } else {
                failed.push(`${item.cleanItemName} (Wiki validation failed)`);
              }
            } catch (vErr) {
              failed.push(`${item.cleanItemName} (${vErr.message})`);
            }
          }

          gImport.importSessions.delete(interaction.user.id);

          let summary = `✅ Successfully imported **${successful.length}** item(s) to the guild gear inventory:\n`;
          if (successful.length > 0) {
            summary += successful.slice(0, 15).map(s => `• ${s}`).join('\n');
            if (successful.length > 15) summary += `\n...and ${successful.length - 15} more.`;
          }
          if (failed.length > 0) {
            summary += `\n\n⚠️ **${failed.length}** item(s) could not be verified on eqlwiki:\n` +
              failed.slice(0, 10).map(f => `• ${f}`).join('\n');
          }

          return interaction.editReply({
            content: summary,
            embeds: [],
            components: []
          });
        }
      }

      // Work order actions moved to a second dropdown (workorder_select_action_),
      // matching /g-list's item-then-action pattern — see that select-menu
      // handler below. No work order buttons are generated anymore.
    }

    // 4. Select Menu Interactions
    if (interaction.isStringSelectMenu()) {
      // A. Gear List: Item Selection Dropdown
      if (interaction.customId.startsWith('glist_select_item_')) {
        const page = parseInt(interaction.customId.replace('glist_select_item_', ''), 10) || 1;
        const selectedItemId = interaction.values[0];

        const authorizedRoles = (process.env.AUTHORIZED_ROLE_IDS || '').split(',').map(r => r.trim());
        const hasOfficerRole = interaction.member?.roles?.cache?.some(r => authorizedRoles.includes(r.id));
        const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
        const isOfficer = Boolean(hasOfficerRole || isAdmin);

        const updatedList = buildListResponse(interaction.user.id, isOfficer, page, selectedItemId);
        return interaction.update(updatedList);
      }

      // B. Gear List: Action Selection Dropdown
      if (interaction.customId.startsWith('glist_select_action_')) {
        const rawActionValue = interaction.values[0] || '';
        const [actionType, itemId] = rawActionValue.split('_');
        const page = parseInt(interaction.customId.split('_')[3], 10) || 1;

        const item = db.getGearById(itemId);
        if (!item) {
          return interaction.reply({ content: '❌ This item no longer exists in the inventory.', flags: MessageFlags.Ephemeral });
        }

        const authorizedRoles = (process.env.AUTHORIZED_ROLE_IDS || '').split(',').map(r => r.trim());
        const hasOfficerRole = interaction.member?.roles?.cache?.some(r => authorizedRoles.includes(r.id));
        const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
        const isOfficer = Boolean(hasOfficerRole || isAdmin);
        const isAdder = item.added_by_user_id === interaction.user.id;

        // Action 1: View Wiki Item Card. This opens a genuinely separate
        // message (an image attachment + its own slider), which the list's
        // single interaction response can't also carry — so the interaction
        // is spent freezing the list in place (disabled dropdowns, so it
        // can't be interacted with again once it's no longer the active
        // view) and the card goes out afterward as a followUp.
        if (actionType === 'view') {
          const frozenList = buildListResponse(interaction.user.id, isOfficer, page, itemId, { frozen: true });
          await interaction.update(frozenList);

          try {
            const currentLevel = item.upgrade_level || '+0';
            const isQuantity = /^[xX]\d+$/i.test(currentLevel);
            const imageBuffer = await generateCardPng(item.wiki_url, currentLevel);
            const attachment = new AttachmentBuilder(imageBuffer, { name: `${item.base_item_name.replace(/\s+/g, '_')}_${currentLevel}.png` });

            const levelSuffix = (currentLevel && currentLevel !== '+0') ? ` ${currentLevel}` : '';
            const replyPayload = {
              content: `🔍 **${item.base_item_name}${levelSuffix}** (Held by: ${item.added_by_username})`,
              files: [attachment],
              flags: MessageFlags.Ephemeral
            };

            if (!isQuantity) {
              const row = buildSliderControls(item.base_item_name, currentLevel);
              replyPayload.components = [row];
            }

            return interaction.followUp(replyPayload);
          } catch (cardErr) {
            console.error('Failed to render card for selected item:', cardErr);
            return interaction.followUp({
              content: `❌ Failed to render card for **${item.base_item_name}**: ${cardErr.message}`,
              flags: MessageFlags.Ephemeral
            });
          }
        }

        // Action 2: Claim Item — confirmation is folded into the same
        // updated list message (see buildListResponse's `notice` option)
        // rather than opening a second message.
        if (actionType === 'claim') {
          if (item.requested_by_user_id) {
            return interaction.reply({
              content: `⚠️ This item is already claimed by **${item.requested_by_username}**.`,
              flags: MessageFlags.Ephemeral
            });
          }

          if (isAdder) {
            return interaction.reply({
              content: '⚠️ You are the donor of this item! You cannot claim your own item.',
              flags: MessageFlags.Ephemeral
            });
          }

          const username = interaction.member?.displayName || interaction.user.username;
          db.claimGear(itemId, interaction.user.id, username);

          const notice = `✋ You have claimed **${item.base_item_name} ${item.upgrade_level}**!`;
          const updatedList = buildListResponse(interaction.user.id, isOfficer, page, itemId, { notice });
          return interaction.update(updatedList);
        }

        // Action 3: Withdraw Claim
        if (actionType === 'withdraw') {
          if (item.requested_by_user_id !== interaction.user.id) {
            return interaction.reply({
              content: '❌ You do not have an active claim on this item.',
              flags: MessageFlags.Ephemeral
            });
          }

          db.withdrawGear(itemId, interaction.user.id);

          const notice = `↩ Withdrew your claim on **${item.base_item_name} ${item.upgrade_level}**. It is now available for others.`;
          const updatedList = buildListResponse(interaction.user.id, isOfficer, page, itemId, { notice });
          return interaction.update(updatedList);
        }

        // Action 4: Remove Item (Donor or Officer)
        if (actionType === 'remove') {
          if (!isAdder && !isOfficer) {
            return interaction.reply({
              content: '❌ Only the donor of this item or a Guild Officer can remove it from the gear list.',
              flags: MessageFlags.Ephemeral
            });
          }

          db.removeGearById(itemId);

          const notice = `🗑️ Removed **${item.base_item_name} ${item.upgrade_level}** from the inventory.`;
          const updatedList = buildListResponse(interaction.user.id, isOfficer, page, null, { notice });
          return interaction.update(updatedList);
        }
      }

      // C. Upgrade Level Dropdown (on item card popup)
      if (interaction.customId.startsWith('card_select_level_')) {
        await interaction.deferUpdate();
        const encodedItemName = interaction.customId.replace('card_select_level_', '');
        const baseItemName = decodeURIComponent(encodedItemName);
        const targetLevel = interaction.values[0] || '+0';
        const formattedTitle = baseItemName.replace(/\s+/g, '_');
        const wikiUrl = `https://eqlwiki.com/${encodeURIComponent(formattedTitle)}`;

        try {
          const imageBuffer = await generateCardPng(wikiUrl, targetLevel);
          const attachment = new AttachmentBuilder(imageBuffer, { name: `${baseItemName.replace(/\s+/g, '_')}_${targetLevel}.png` });
          const row = buildSliderControls(baseItemName, targetLevel);

          const levelSuffix = (targetLevel && targetLevel !== '+0') ? ` ${targetLevel}` : '';
          await interaction.editReply({ 
            content: `🔍 **${baseItemName}${levelSuffix}**`,
            files: [attachment], 
            components: [row] 
          });
        } catch (selectErr) {
          console.error('Select menu card update error:', selectErr);
        }
      }

      // D. Inventory Import Item Multi-Select Checkbox
      if (interaction.customId.startsWith('gimport_toggle_')) {
        const page = parseInt(interaction.customId.replace('gimport_toggle_', ''), 10) || 1;
        const session = gImport.importSessions.get(interaction.user.id);
        if (!session) {
          return interaction.reply({
            content: '❌ Your import session has expired. Please run `/g-import` again.',
            flags: MessageFlags.Ephemeral
          });
        }

        const PAGE_SIZE = 15;
        const startIndex = (page - 1) * PAGE_SIZE;
        const pageItems = session.items.slice(startIndex, startIndex + PAGE_SIZE);

        // Remove unselected items on this page from selectedIndices
        pageItems.forEach((_, idx) => session.selectedIndices.delete(startIndex + idx));

        // Add newly selected indices
        for (const val of interaction.values) {
          const idx = parseInt(val, 10);
          if (!isNaN(idx)) {
            session.selectedIndices.add(idx);
          }
        }

        const updated = gImport.buildImportResponse(interaction.user.id, page);
        return interaction.update(updated);
      }

      // E. Work Order List: Order Selection Dropdown (mirrors glist_select_item_)
      if (interaction.customId.startsWith('workorder_select_item_')) {
        const filter = interaction.customId.replace('workorder_select_item_', '');
        const selectedOrderId = interaction.values[0];

        const authorizedRoles = (process.env.AUTHORIZED_ROLE_IDS || '').split(',').map(r => r.trim());
        const hasOfficerRole = interaction.member?.roles?.cache?.some(r => authorizedRoles.includes(r.id));
        const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
        const isOfficer = Boolean(hasOfficerRole || isAdmin);

        const updated = gWork.buildWorkOrderResponse(interaction.user.id, isOfficer, filter, selectedOrderId);
        return interaction.update(updated);
      }

      // F. Work Order List: Action Selection Dropdown (mirrors glist_select_action_)
      if (interaction.customId.startsWith('workorder_select_action_')) {
        const filter = interaction.customId.replace('workorder_select_action_', '');
        const rawActionValue = interaction.values[0] || '';
        const [actionType, orderIdStr] = rawActionValue.split('_');
        const orderId = parseInt(orderIdStr, 10);

        const order = db.getWorkOrderById(orderId);
        if (!order) {
          return interaction.reply({ content: '❌ That work order no longer exists.', flags: MessageFlags.Ephemeral });
        }

        const authorizedRoles = (process.env.AUTHORIZED_ROLE_IDS || '').split(',').map(r => r.trim());
        const hasOfficerRole = interaction.member?.roles?.cache?.some(r => authorizedRoles.includes(r.id));
        const isAdmin = interaction.member?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
        const isOfficer = Boolean(hasOfficerRole || isAdmin);
        const isCrafter = order.claimed_by_discord_id === interaction.user.id;
        const isRequester = order.requester_discord_id === interaction.user.id;

        // Folded into the list's own re-render below instead of a separate
        // followUp message (see buildWorkOrderResponse's `notice` option).
        let notice = null;

        if (actionType === 'claim') {
          if (order.status !== 'unclaimed') {
            return interaction.reply({ content: `⚠️ Order #${order.id} is already ${order.status}.`, flags: MessageFlags.Ephemeral });
          }
          if (isRequester) {
            return interaction.reply({ content: '⚠️ You cannot claim your own work order.', flags: MessageFlags.Ephemeral });
          }
          db.claimWorkOrder(orderId, interaction.user.id, interaction.user.username);
          notice = `🛠️ You claimed work order **#${order.id}: ${order.item_name}**. Mark it complete once you've crafted/gathered it.`;
        } else if (actionType === 'complete') {
          if (!isCrafter && !isRequester && !isOfficer) {
            return interaction.reply({ content: '❌ Only the crafter, requester, or an officer can mark this complete.', flags: MessageFlags.Ephemeral });
          }
          if (order.status !== 'claimed') {
            return interaction.reply({ content: `⚠️ Order #${order.id} must be claimed first (currently ${order.status}).`, flags: MessageFlags.Ephemeral });
          }
          db.completeWorkOrder(orderId);
          notice = `✅ Marked work order **#${order.id}: ${order.item_name}** complete. Mark it delivered once it's actually handed over.`;
        } else if (actionType === 'deliver') {
          if (!isCrafter && !isRequester && !isOfficer) {
            return interaction.reply({ content: '❌ Only the crafter, requester, or an officer can mark this delivered.', flags: MessageFlags.Ephemeral });
          }
          if (order.status !== 'complete') {
            return interaction.reply({ content: `⚠️ Order #${order.id} must be marked complete first (currently ${order.status}).`, flags: MessageFlags.Ephemeral });
          }
          db.deliverWorkOrder(orderId);
          notice = `📬 Marked work order **#${order.id}: ${order.item_name}** delivered. It'll drop off the list automatically in 24h.`;
        } else if (actionType === 'cancel') {
          if (!isRequester && !isOfficer) {
            return interaction.reply({ content: '❌ Only the requester or an officer can cancel this order.', flags: MessageFlags.Ephemeral });
          }
          if (order.status !== 'unclaimed' && order.status !== 'claimed') {
            return interaction.reply({ content: `⚠️ Order #${order.id} can no longer be cancelled (currently ${order.status}).`, flags: MessageFlags.Ephemeral });
          }
          db.cancelWorkOrder(orderId);
          notice = `🗑️ Cancelled work order **#${order.id}: ${order.item_name}**. It'll drop off the list automatically in 24h.`;
        } else if (actionType === 'delete') {
          // Officer-only, any status, no 24h wait — immediate and permanent.
          // Distinct from cancel: cancel is the normal player-facing
          // withdrawal (pre-completion only, still goes through the 24h
          // grace window like delivered orders do); delete is the
          // moderation tool for spam/duplicates/mistakes.
          if (!isOfficer) {
            return interaction.reply({ content: '❌ Only an officer can delete a work order outright.', flags: MessageFlags.Ephemeral });
          }
          db.deleteWorkOrder(orderId);
          notice = `🗑️ Deleted work order **#${order.id}: ${order.item_name}** permanently.`;
        }

        // Re-render the same list-plus-dropdowns view (still on this order,
        // so the action menu updates to whatever's valid at the new status)
        // in place, same as gear list does after claim/withdraw/remove —
        // with the confirmation folded into this one update instead of a
        // separate followUp, so no second message opens alongside the list.
        const updated = gWork.buildWorkOrderResponse(interaction.user.id, isOfficer, filter, orderId, { notice });
        return interaction.update(updated);
      }
    }
  } catch (err) {
    if (err.code !== 10062) {
      console.error('Interaction error:', err);
    }
  }
});

// Start bot if token is supplied
if (process.env.DISCORD_TOKEN && process.env.DISCORD_TOKEN !== 'your_discord_bot_token_here') {
  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error('❌ Failed to login to Discord:', err.message);
  });
} else {
  console.log('ℹ️ Bot token not set. To run the bot, provide DISCORD_TOKEN in .env or via environment variables.');
}

module.exports = client;