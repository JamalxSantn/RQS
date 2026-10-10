// FACE Discord Bot - one-time setup
// Creates all required roles + channels in your guild and writes the real IDs
// into config.json. Also prints the invite link for the bot.
//
// Usage:  node setup.js
// (First paste your bot token into config.json!)

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const GUILD_CONFIG_KEYS = [
    ['adminRoleId', 'FACE Admin'],
    ['deleteRoleId', 'FACE Delete'],
    ['customerRoleId', 'FACE Customer'],
    ['adminHwidResetRoleId', 'FACE HWID Reset'],
    ['adminDiscordResetRoleId', 'FACE Discord Reset']
];
const CHANNEL_GLUE = [
    ['logChannelId', 'logs'],
    ['redeemChannelId', 'redeem']
];

// Permissions for the invite link:
// Manage Roles, Manage Channels, Create Invite, Add Reactions, View Channels,
// Send Messages, Manage Messages, Embed Links, Attach Files, Read Message History
const INVITE_PERMISSIONS = 268561489;

function loadConfig() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4) + '\n', 'utf8');
}

function waitForEnter(prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function ensureRole(guild, name, options = {}) {
    let role = guild.roles.cache.find(r => r.name === name);
    if (!role) {
        role = await guild.roles.create({ name, ...options });
        console.log(`  [OK] Rolle erstellt: ${name}`);
    } else {
        console.log(`  [OK] Rolle gefunden: ${name}`);
    }
    return role;
}

async function ensureTextChannel(guild, name, parent) {
    let channel = guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText);
    if (!channel) {
        channel = await guild.channels.create({ name, parent, type: ChannelType.GuildText });
        console.log(`  [OK] Channel erstellt: ${name}`);
    } else {
        console.log(`  [OK] Channel gefunden: ${name}`);
    }
    return channel;
}

async function main() {
    const config = loadConfig();

    if (!config.botToken || config.botToken === 'PASTE_YOUR_BOT_TOKEN_HERE' || config.botToken === 'YOUR_BOT_TOKEN') {
        console.error('[FEHLER] Trage zuerst deinen Bot-Token in config.json ein (Feld "botToken").');
        process.exit(1);
    }

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', async () => {
        console.log(`\n[OK] Bot eingeloggt als: ${client.user.tag}\n`);

        // 1) Invite link
        const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands`;
        console.log('----------------------------------------------');
        console.log('LADE DEN BOT SO EIN (klick den Link, dann Server):');
        console.log(inviteUrl);
        console.log('----------------------------------------------\n');

        await waitForEnter('→ Druecke ENTER, sobald der Bot auf deinem Server ist (Server-ID wird gecheckt) ...\n');

        const guild = client.guilds.cache.get(config.guildId);
        if (!guild) {
            console.error(`[FEHLER] Bot ist NICHT auf dem Server ${config.guildId}. Bitte zuerst einladen und erneut ausfuehren.`);
            process.exit(1);
        }
        console.log(`[OK] Server gefunden: ${guild.name}\n`);

        // 2) Roles
        console.log('Erstelle/verifiziere Rollen ...');
        for (const [key, name] of GUILD_CONFIG_KEYS) {
            const role = await ensureRole(guild, name);
            config[key] = role.id;
        }

        // 3) Category + Channels
        console.log('\nErstelle/verifiziere Category + Channels ...');
        let systemCategory = guild.channels.cache.find(
            c => c.name === 'FACE SYSTEM' && c.type === ChannelType.GuildCategory
        );
        if (!systemCategory) {
            systemCategory = await guild.channels.create({ name: 'FACE SYSTEM', type: ChannelType.GuildCategory });
            console.log('  [OK] Category erstellt: FACE SYSTEM');
        } else {
            console.log('  [OK] Category gefunden: FACE SYSTEM');
        }

        for (const [key, name] of CHANNEL_GLUE) {
            const channel = await ensureTextChannel(guild, name, systemCategory.id);
            config[key] = channel.id;
        }

        // 4) Save config.json
        saveConfig(config);
        console.log('\n[OK] config.json wurde mit den echten IDs aktualisiert.');
        console.log('\nFertig! Starte den Bot jetzt mit:  node index.js');
        console.log('Beim Start richtet er die Statistik-Channels ein und registriert die Slash-Commands.\n');

        process.exit(0);
    });

    client.on('error', (e) => console.error('[FEHLER]', e.message));

    await client.login(config.botToken).catch((e) => {
        console.error(`[FEHLER] Login fehlgeschlagen: ${e.message}\nPruefe, ob der Token korrekt in config.json steht.`);
        process.exit(1);
    });
}

main();