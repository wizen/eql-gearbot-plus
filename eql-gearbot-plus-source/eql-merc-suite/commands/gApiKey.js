const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('g-apikey')
    .setDescription('Generate (or rotate) your personal Apprentice API key. Sent to you via DM.'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const token = db.createOrRotateApiToken(interaction.user.id, interaction.user.username);

      const dmMessage =
        `🔑 **Your Apprentice API Key**\n\n` +
        `\`${token}\`\n\n` +
        `Paste this into Apprentice's settings to let it submit and check work orders ` +
        `on your behalf.\n\n` +
        `⚠️ Treat this like a password — anyone with it can act as you on the gear bot's API. ` +
        `Run \`/g-apikey\` again any time to invalidate the old key and get a new one.`;

      await interaction.user.send(dmMessage);
      await interaction.editReply('✅ Your API key has been sent to you via DM. Check your Discord DMs.');
    } catch (err) {
      if (err.code === 50007) {
        await interaction.editReply(
          '❌ I couldn\'t DM you your API key — please check your Privacy Settings to allow DMs from server members, then try again.'
        );
      } else {
        console.error('g-apikey error:', err);
        await interaction.editReply('❌ Something went wrong generating your API key.');
      }
    }
  }
};
