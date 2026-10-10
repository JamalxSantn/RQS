// One-time: assigns the FACE roles to a given user ID
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(require('fs').readFileSync(CONFIG_PATH, 'utf8'));

const TARGET_USER_ID = process.argv[2];
const ROLE_IDS = [
    config.adminRoleId,
    config.deleteRoleId,
    config.adminHwidResetRoleId,
    config.adminDiscordResetRoleId
];

if (!TARGET_USER_ID) {
    console.error('Usage: node assign_roles.js <DISCORD_USER_ID>');
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
    try {
        const guild = client.guilds.cache.get(config.guildId);
        if (!guild) throw new Error(`Guild ${config.guildId} nicht gefunden`);
        console.log(`[OK] Server: ${guild.name}`);

        const member = await guild.members.fetch(TARGET_USER_ID);
        if (!member) throw new Error('Member nicht gefunden');

        const missing = ROLE_IDS.filter(id => !member.roles.cache.has(id));
        if (missing.length === 0) {
            console.log('[OK] Alle FACE-Rollen sind bereits zugewiesen.');
        } else {
            await member.roles.add(missing);
            console.log(`[OK] Rollen zugewiesen an ${member.user.tag}:`);
            for (const id of missing) {
                const r = guild.roles.cache.get(id);
                console.log(`   - ${r ? r.name : id}`);
            }
        }
    } catch (e) {
        console.error('[FEHLER]', e.message);
        process.exit(1);
    }
    process.exit(0);
});

client.on('error', (e) => console.error('[FEHLER]', e.message));

client.login(config.botToken).catch((e) => {
    console.error(`[FEHLER] Login: ${e.message}`);
    process.exit(1);
});