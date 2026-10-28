// =================================
//
// Importing Libraries
//
// =================================
//
const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, REST, Routes, ChannelType, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const db = require('./database.js');
// config.json (lokal) oder Umgebungsvariablen (Hosting wie Render).
let config;
try {
    config = require('./config.json');
    console.log('[CONFIG] Loaded from config.json');
} catch (e) {
    console.log('[CONFIG] config.json nicht gefunden - nutze Umgebungsvariablen.');
    config = {
        botToken: process.env.BOT_TOKEN,
        guildId: process.env.GUILD_ID || '1557841343491866795',
        adminRoleId: process.env.ADMIN_ROLE_ID,
        deleteRoleId: process.env.DELETE_ROLE_ID,
        customerRoleId: process.env.CUSTOMER_ROLE_ID,
        adminHwidResetRoleId: process.env.ADMIN_HWID_RESET_ROLE_ID,
        adminDiscordResetRoleId: process.env.ADMIN_DISCORD_RESET_ROLE_ID,
        apiPort: process.env.PORT || 3000,
        enableStatsChannels: false,
        logChannels: {},
        chatUsers: { '1027571297514967140': 'OWNER' },
        voiceChannels: {}
    };
}

// Override with env vars if present
if (process.env.BOT_TOKEN) config.botToken = process.env.BOT_TOKEN;
if (process.env.GUILD_ID) config.guildId = process.env.GUILD_ID;
if (process.env.ADMIN_ROLE_ID) config.adminRoleId = process.env.ADMIN_ROLE_ID;
if (process.env.DELETE_ROLE_ID) config.deleteRoleId = process.env.DELETE_ROLE_ID;
if (process.env.CUSTOMER_ROLE_ID) config.customerRoleId = process.env.CUSTOMER_ROLE_ID;
if (process.env.ADMIN_HWID_RESET_ROLE_ID) config.adminHwidResetRoleId = process.env.ADMIN_HWID_RESET_ROLE_ID;
if (process.env.ADMIN_DISCORD_RESET_ROLE_ID) config.adminDiscordResetRoleId = process.env.ADMIN_DISCORD_RESET_ROLE_ID;
if (process.env.PORT) config.apiPort = process.env.PORT;
const botToken = process.env.BOT_TOKEN || config.botToken;
console.log('[BOT] Token source:', process.env.BOT_TOKEN ? 'env' : 'config');
if (!botToken || botToken === 'PASTE_YOUR_BOT_TOKEN_HERE' || botToken.trim() === '') {
    console.error('[FEHLER] Kein Bot-Token gesetzt. BOT_TOKEN Umgebungsvariable oder config.json pruefen.');
    console.error('[DEBUG] process.env.BOT_TOKEN exists:', !!process.env.BOT_TOKEN);
    process.exit(1);
}
const axios = require('axios');

// Single-Instance-Lock: Eine zweite Instanz beendet sich sofort,
// damit Panels/Logs niemals doppelt gepostet werden.
(function ensureSingleInstance() {
    // Skip lock on Render/cloud environments to avoid issues
    if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
        console.log('[LOCK] Skipping single-instance lock on Render');
        return;
    }
    const fs = require('fs');
    const path = require('path');
    const lockPath = path.join(__dirname, 'bot.lock');
    const pidAlive = (pid) => {
        try { process.kill(pid, 0); return true; }
        catch (e) { return !!(e && e.code === 'EPERM'); }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
            break;
        } catch (e) {
            let oldPid = 0;
            try { oldPid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10) || 0; } catch (_) {}
            if (oldPid && pidAlive(oldPid)) {
                console.error(`[FEHLER] Bot laeuft bereits (PID ${oldPid}). Zweite Instanz wird beendet, damit nichts doppelt gepostet wird.`);
                process.exit(1);
            }
            try { fs.unlinkSync(lockPath); } catch (_) {}
        }
    }
    const release = () => {
        try {
            if (fs.readFileSync(lockPath, 'utf8') === String(process.pid)) fs.unlinkSync(lockPath);
        } catch (_) {}
    };
    process.on('exit', release);
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
})();

process.on('unhandledRejection', (reason, promise) => {
    console.error('[PROCESS] Unhandled rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[PROCESS] Uncaught exception:', err);
    console.error(err.stack);
    // Don't exit on Render, try to keep running
    if (process.env.RENDER) {
        console.log('[PROCESS] On Render - attempting to recover...');
    } else {
        process.exit(1);
    }
});

// =================================
//
// Bot Initialization
//
// =================================
//
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

client.on('error', (error) => {
    console.error('[DISCORD] Client error:', error && error.message ? error.message : error);
    if (error && error.stack) console.error(error.stack);
});

client.on('warn', (warning) => {
    console.warn('[DISCORD] Client warning:', warning);
});

client.on('shardError', (error) => {
    console.error('[DISCORD] Shard error:', error && error.message ? error.message : error);
});

client.on('debug', (info) => {
    console.log('[DISCORD-DEBUG]', info);
});

client.on('disconnect', (event) => {
    console.log('[DISCORD] Client disconnected', event);
});

client.on('reconnecting', () => {
    console.log('[DISCORD] Client reconnecting...');
});

client.on('invalidated', () => {
    console.error('[DISCORD] Session invalidated, attempting to login again...');
    startBot();
});

client.on('shardReady', (id) => {
    console.log(`[DISCORD] Shard ${id} ready`);
});

client.on('shardDisconnect', (event, id) => {
    console.log(`[DISCORD] Shard ${id} disconnected`, event?.code);
});

client.on('shardReconnecting', (id) => {
    console.log(`[DISCORD] Shard ${id} reconnecting`);
});

client.on('shardResume', (replayed, id) => {
    console.log(`[DISCORD] Shard ${id} resumed, replayed ${replayed} events`);
});

// =================================
//
// Helper Variables
//
// =================================
//
const generateRandomString = (length) => Math.random().toString(36).substring(2, 2 + length).toUpperCase();

const formatExpiry = (expiresAt) => {
    if (!expiresAt) return "Lifetime";
    const diff = new Date(expiresAt) - Date.now();
    if (diff <= 0) return "Expired";
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    const months = Math.floor(days / 30);
    const remDays = days % 30;
    if (months > 0) return remDays > 0 ? `${months} month${months > 1 ? 's' : ''} ${remDays} day${remDays > 1 ? 's' : ''}` : `${months} month${months > 1 ? 's' : ''}`;
    if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    return `${Math.max(minutes, 1)} minute${minutes > 1 ? 's' : ''}`;
};

const parseDuration = (durationStr) => {
    const match = durationStr.match(/^(\d+)([dmy])$/i);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const date = new Date();
    if (unit === 'd') date.setDate(date.getDate() + value);
    else if (unit === 'm') date.setMonth(date.getMonth() + value);
    else if (unit === 'y') date.setFullYear(date.getFullYear() + value);
    else return null;
    return date;
};

// Plan type of a license: Day / Monat / Lifetime
const PLAN_LABELS = { day: 'Day', month: 'Monat', lifetime: 'Lifetime' };

const planOfLicense = (license) => {
    if (!license || !license.expires_at) return PLAN_LABELS.lifetime;
    const m = (license.duration || '').match(/^(\d+)([dmy])$/i);
    const unit = m ? m[2].toLowerCase() : 'd';
    if (unit === 'd') return PLAN_LABELS.day;
    if (unit === 'm') return PLAN_LABELS.month;
    return PLAN_LABELS.lifetime;
};

// Function for IP geolocation
async function getCountryFromIP(ip) {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
        return 'Unknown';
    }
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=country,countryCode`);
        if (response.data && response.data.country) {
            return response.data.country;
        }
    } catch (error) {
        console.error('Geolocation error:', error);
    }
    return 'Unknown';
}

// =================================
//
// REQUST Channel-System (neuer Server)
// Channels: all-logs / key / key-list / user / inject / login / logger / bot
//
// =================================
const bootTime = Date.now();

// Einmal-Login-Codes fuer das Config-Cloud-Web-Panel (Discord-Login).
const cloudLoginCodes = new Map();
const CLOUD_PANEL_URL = process.env.CLOUD_PANEL_URL || 'https://rqs-0trt.onrender.com/cloud/panel';
const CLOUD_PANEL_CHANNEL_ID = process.env.CLOUD_PANEL_CHANNEL_ID || config.cloudPanelChannelId || '1558887050072162374';
const CLOUD_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCloudCode() {
    let code = '';
    for (let i = 0; i < 6; i++) code += CLOUD_CODE_ALPHABET[Math.floor(Math.random() * CLOUD_CODE_ALPHABET.length)];
    return code;
}

// Abgelaufene Codes regelmaessig entfernen.
setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of cloudLoginCodes) if (now > entry.expires) cloudLoginCodes.delete(code);
}, 60 * 1000).unref?.();


const LOG_CHANNEL_NAMES = {
    all: 'all-logs',
    key: 'key',
    keyList: 'key-list',
    user: 'user',
    inject: 'inject',
    login: 'login',
    logger: 'logger',
    bot: 'bot'
};

// Name -> Channel-ID (wird beim Ready aufgeloest + in config.json persistiert).
let logChannelIds = Object.assign({}, config.logChannels || {});

function getLogChannel(name) {
    const id = logChannelIds[name];
    if (!id) return null;
    const ch = client.channels.cache.get(id);
    return (ch && ch.isTextBased && ch.isTextBased()) ? ch : null;
}

async function resolveLogChannels() {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
        console.error(`[FEHLER] Server ${config.guildId} nicht gefunden. Ist der Bot eingeladen?`);
        return;
    }
    await guild.channels.fetch().catch(() => null);
    let changed = false;
    for (const [key, name] of Object.entries(LOG_CHANNEL_NAMES)) {
        const ch = guild.channels.cache.find(
            c => c.name === name && c.type === ChannelType.GuildText
        );
        if (ch) {
            if (logChannelIds[key] !== ch.id) { logChannelIds[key] = ch.id; changed = true; }
        } else {
            console.error(`[WARN] Channel #${name} nicht gefunden - wird uebersprungen.`);
        }
    }
    if (changed) {
        config.logChannels = logChannelIds;
        try {
            require('fs').writeFileSync(
                require('path').join(__dirname, 'config.json'),
                JSON.stringify(config, null, 4) + '\n', 'utf8');
            console.log('[OK] Channel-IDs in config.json gespeichert.');
        } catch (e) { console.error('[FEHLER] config.json speichern:', e.message); }
    }
    const roleKeys = ['adminRoleId', 'deleteRoleId', 'customerRoleId', 'adminHwidResetRoleId', 'adminDiscordResetRoleId'];
    for (const rk of roleKeys) {
        if (config[rk] && !guild.roles.cache.has(config[rk]))
            console.error(`[WARN] Rolle ${rk} (${config[rk]}) existiert auf diesem Server nicht. Administratoren duerfen trotzdem alles.`);
    }
}

// Loescht alle Nachrichten in einem Channel (Neustart = saubere Logs).
async function purgeChannel(channel, maxSingleDeletes = 200) {
    if (!channel || !channel.isTextBased || !channel.isTextBased()) return 0;
    let removed = 0, singleDeletes = 0;
    try {
        while (true) {
            const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
            if (!fetched || fetched.size === 0) break;
            const cutoff = Date.now() - (14 * 24 * 3600 * 1000 - 60000);
            const recent = fetched.filter(m => m.createdTimestamp > cutoff);
            const old = fetched.filter(m => m.createdTimestamp <= cutoff);
            if (recent.size > 1) {
                await channel.bulkDelete(recent, true).catch(() => {});
                removed += recent.size;
            } else if (recent.size === 1) {
                await recent.first().delete().catch(() => {});
                removed += 1;
            }
            for (const m of old.values()) {
                if (singleDeletes >= maxSingleDeletes) break;
                await m.delete().catch(() => {});
                singleDeletes++; removed++;
                await new Promise(r => setTimeout(r, 400));
            }
            if (fetched.size < 100) break;
            if (singleDeletes >= maxSingleDeletes && old.size > 0) break;
            await new Promise(r => setTimeout(r, 1000));
        }
    } catch (e) { console.error(`Purge #${channel.name}:`, e.message); }
    return removed;
}

// Sendet ein Log in den Ziel-Channel + spiegelt alles nach #all-logs.
// #all-logs ist das dauerhafte Archiv (wird beim Restart NICHT geleert).
async function sendLog(target, payload) {
    try {
        const main = getLogChannel(target);
        if (main) await main.send(payload).catch((e) => console.error(`sendLog #${target}:`, e.message));
        if (target !== 'all') {
            const all = getLogChannel('all');
            if (all) await all.send(payload).catch((e) => console.error('sendLog #all-logs:', e.message));
        }
    } catch (e) { console.error('sendLog:', e.message); }
}

// Rechte-Pruefung: konfigurierte Rolle ODER Administrator (wichtig auf neuem Server).
function hasPriv(member, roleId) {
    if (!member) return false;
    try {
        if (member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
        if (roleId && member.roles && member.roles.cache.has(roleId)) return true;
    } catch (e) {}
    return false;
}

// Sorting definitions
const SORT_TYPES = {
    DEFAULT: 'default',
    TEMP: 'temp',
    PRIVATE: 'private',
    PUBLIC: 'public',
    PERM: 'perm'
};

const SORT_DISPLAY_NAMES = {
    [SORT_TYPES.DEFAULT]: 'Default',
    [SORT_TYPES.TEMP]: 'TEMP',
    [SORT_TYPES.PRIVATE]: 'Private',
    [SORT_TYPES.PUBLIC]: 'Public',
    [SORT_TYPES.PERM]: 'Perm'
};

const SORT_ORDER = [SORT_TYPES.DEFAULT, SORT_TYPES.TEMP, SORT_TYPES.PRIVATE, SORT_TYPES.PUBLIC, SORT_TYPES.PERM];

// =================================
//
// Slash Commands Definitions
//
// =================================
//
const commands = [
    {
        name: 'generate-license',
        description: 'Generates a new license key (Admin only).',
    },
    {
        name: 'reset-discord',
        description: 'Unlinks the Discord account from your license key.',
    },
    {
        name: 'reset-hwid',
        description: 'Resets the HWID linked to your license key.',
    },
    {
        name: 'license-delete',
        description: 'Deletes a license key permanently (Admin only).',
    },
    {
        name: 'admin-hwid',
        description: 'ADMIN: Resets the HWID for a given license key.'
    },
    {
        name: 'admin-discord',
        description: 'ADMIN: Resets the Discord ID for a given license key.'
    },
    {
        name: 'licenses-check',
        description: 'Check all licenses or a specific license (Admin only).',
        options: [
            {
                name: 'license',
                type: 3,
                description: 'Specific license key to check (optional)',
                required: false
            }
        ]
    },
    {
        name: 'stats',
        description: 'Show detailed statistics about licenses and users'
    },
    // NEW COMMANDS
    {
        name: 'freeze',
        description: 'Freeze licenses (Admin only).'
    },
    {
        name: 'unfreeze',
        description: 'Unfreeze licenses (Admin only).'
    },
    {
        name: 'addtime',
        description: 'Add time to licenses (Admin only).'
    }
];

// =================================
//
// Bot Event: Ready
//
// =================================
//
client.once('ready', async () => {
    console.log('[BOT] READY EVENT RECEIVED');
    try {
        console.log(`[BOT] Ready event fired! Logged in as ${client.user.tag} (${client.user.id})`);
        console.log(`[BOT] Connected to ${client.guilds.cache.size} guild(s)`);
        console.log(`[BOT] Guild ID from config: ${config.guildId}`);
        if (!client.guilds.cache.has(config.guildId)) {
            console.error(`[BOT] WARNING: Config guildId ${config.guildId} not found in guild cache!`);
        }
        try {
            await db.initializeDatabase();
            console.log('[BOT] Database initialized');
        } catch (e) {
            console.error('[BOT] Database init error:', e);
        }

        const rest = new REST({ version: '10' }).setToken(botToken);
        try {
            console.log('[BOT] Started refreshing application (/) commands.');
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, config.guildId),
                { body: commands },
            );
            console.log('[BOT] Successfully reloaded application (/) commands.');
        } catch (error) {
            console.error('[BOT] Failed to reload commands:', error);
        }

        try {
            await resolveLogChannels();
        } catch (e) {
            console.error('[BOT] Error resolving log channels:', e);
        }

        // Neustart = alle Logs loeschen - ausser Archiv-Channels (bleiben erhalten).
        const keepOnRestart = new Set(['all', 'login', 'inject']);
        for (const key of Object.keys(LOG_CHANNEL_NAMES)) {
            if (keepOnRestart.has(key)) continue;
            const ch = getLogChannel(key);
            if (!ch) continue;
            try {
                const n = await purgeChannel(ch);
                console.log(`[OK] #${ch.name} geleert (${n} Nachrichten).`);
            } catch (e) { console.error(`Purge:`, e.message); }
        }

        if (config.enableStatsChannels) {
            try {
                await initializeStatsChannels();
                setInterval(updateStatsChannels, 5 * 60 * 1000);
            } catch (e) {
                console.error('[BOT] Error initializing stats channels:', e);
            }
        }

        try { await sendKeyPanel(); } catch (e) { console.error('[BOT] Error sending key panel:', e); }
        try { await sendKeyListPanel(); } catch (e) { console.error('[BOT] Error sending key-list panel:', e); }
        try { await sendUserPanel(); } catch (e) { console.error('[BOT] Error sending user panel:', e); }
        try { await sendStaticHeaders(); } catch (e) { console.error('[BOT] Error sending static headers:', e); }
        try { await sendBotPanel(); } catch (e) { console.error('[BOT] Error sending bot panel:', e); }
        try { await sendCloudPanel(); } catch (e) { console.error('[BOT] Error sending cloud panel:', e); }
        setInterval(updateBotPanel, 60 * 1000);

        // Key-List Embed alle 5 Minuten neu aufbauen + senden/aktualisieren,
        // damit geloeschte/erstellte/benutzte Keys sofort verschwinden bzw. auftauchen.
        setInterval(() => { refreshKeyListPanel().catch((e) => console.error('[BOT] refreshKeyListPanel error:', e)); }, 5 * 60 * 1000);
        
        console.log('[BOT] Initialization complete');
    } catch (e) {
        console.error('[BOT] Fatal error in ready event:', e);
        console.error(e.stack);
    }
});

// =================================
//
// Command Overview Embed (buttons)
//
// =================================
//
async function sendKeyPanel() {
    const channel = getLogChannel('key');
    if (!channel) {
        console.log('Key channel (#key) nicht gefunden.');
        return;
    }

    try {

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .addFields(
                {
                    name: '📅 Key · Day',
                    value: '> Erstellt einen Key nach **Tagen** (Anzahl angeben).',
                    inline: true
                },
                {
                    name: '🗓️ Key · Month',
                    value: '> Erstellt einen Key nach **Monaten** (Anzahl angeben).',
                    inline: true
                },
                {
                    name: '♾️ Key · Lifetime',
                    value: '> Erstellt einen **dauerhaften** Key.',
                    inline: true
                }
            )
            .setTitle('🔑 REQUST Key System')
            .setFooter({ text: 'REQUST' })
            .setTimestamp();

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('gen_day').setLabel('Key · Day').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('gen_month').setLabel('Key · Month').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('gen_lifetime').setLabel('Key · Lifetime').setStyle(ButtonStyle.Success)
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('licenses_check').setLabel('Check').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('stats').setLabel('Stats').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('delete_key').setLabel('Delete').setStyle(ButtonStyle.Danger)
        );

        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('freeze_key').setLabel('Freeze').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('unfreeze_key').setLabel('Unfreeze').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('addtime_key').setLabel('Add Time').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('admin_hwid').setLabel('Reset HWID (Admin)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('admin_discord').setLabel('Reset Discord (Admin)').setStyle(ButtonStyle.Secondary)
        );

        const row4 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('reset_discord').setLabel('Reset Discord').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('reset_hwid').setLabel('Reset HWID').setStyle(ButtonStyle.Secondary)
        );

        await channel.send({ embeds: [embed], components: [row1, row2, row3, row4] });
        console.log('Key panel (#key) has been sent.');
    } catch (error) {
        console.error('Error sending key panel:', error);
    }
}

// =================================
//
// Key-List Panel (#key-list) + Refresh
//
// =================================
async function buildKeyListPage(page = 0, sortType = SORT_TYPES.DEFAULT) {
    const licensesPerPage = 5;
    const allLicenses = await db.getAllLicenses();
    if (!allLicenses || allLicenses.length === 0) return { empty: true };

    let sortedLicenses;
    switch (sortType) {
        case SORT_TYPES.TEMP:
            sortedLicenses = allLicenses.sort((a, b) => {
                if (a.product === 'Temp' && b.product !== 'Temp') return -1;
                if (a.product !== 'Temp' && b.product === 'Temp') return 1;
                return 0;
            });
            break;
        case SORT_TYPES.PRIVATE:
            sortedLicenses = allLicenses.sort((a, b) => {
                if (a.product === 'Private' && b.product !== 'Private') return -1;
                if (a.product !== 'Private' && b.product === 'Private') return 1;
                return 0;
            });
            break;
        case SORT_TYPES.PUBLIC:
            sortedLicenses = allLicenses.sort((a, b) => {
                if (a.product === 'Public' && b.product !== 'Public') return -1;
                if (a.product !== 'Public' && b.product === 'Public') return 1;
                return 0;
            });
            break;
        case SORT_TYPES.PERM:
            sortedLicenses = allLicenses.sort((a, b) => {
                if (a.product === 'Perm' && b.product !== 'Perm') return -1;
                if (a.product !== 'Perm' && b.product === 'Perm') return 1;
                return 0;
            });
            break;
        default:
            const productOrder = { 'Temp': 0, 'Private': 1, 'Public': 2, 'Perm': 3 };
            sortedLicenses = allLicenses.sort((a, b) => {
                return productOrder[a.product] - productOrder[b.product];
            });
    }

    const totalPages = Math.max(1, Math.ceil(sortedLicenses.length / licensesPerPage));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const startIndex = safePage * licensesPerPage;
    const endIndex = startIndex + licensesPerPage;
    const currentLicenses = sortedLicenses.slice(startIndex, endIndex);

    const embed = new EmbedBuilder()
        .setTitle(`📋 Key List (Page ${safePage + 1}/${totalPages})`)
        .setColor('Blue')
        .setFooter({ text: `Total: ${sortedLicenses.length}` })
        .setTimestamp();

    currentLicenses.forEach((license, index) => {
        const globalIndex = startIndex + index + 1;
        const status = (!license.linked_discord_id && !license.linked_hwid) ? 'Not used 🟢' : 'Used 🔴';
        const createdBy = license.created_by_id ? `<@${license.created_by_id}>` : license.created_by_tag;
        const createdAt = license.created_at ? `<t:${Math.floor(new Date(license.created_at).getTime() / 1000)}:F>` : 'Unknown';
        const resetsLimit = license.resets_limit === -1 ? '∞' : license.resets_limit;
        const remainingResets = license.resets_limit === -1 ? '∞' : (license.resets_limit - license.resets_used);

        embed.addFields({
            name: `**License #${globalIndex} - ${license.product}**`,
            value: `- Status: ${status}\n- Created by: ${createdBy}\n- Created at: ${createdAt}\n- Default Resets: ${resetsLimit} resets\n- Remaining Resets: ${remainingResets} resets\n- License Key: ||${license.license_key}||`,
            inline: false
        });
    });

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`licenses_prev_${safePage}_${sortType}`)
                .setLabel('◀')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(safePage === 0),
            new ButtonBuilder()
                .setCustomId(`licenses_next_${safePage}_${sortType}`)
                .setLabel('▶')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(safePage === totalPages - 1)
        );

    return { empty: false, embed, row };
}

let keyListPanel = null; // { channelId, messageId }

async function sendKeyListPanel() {
    const channel = getLogChannel('keyList');
    if (!channel) {
        console.log('Key-List channel (#key-list) nicht gefunden.');
        return;
    }
    try {
        const built = await buildKeyListPage(0, SORT_TYPES.DEFAULT);
        const payload = built.empty
            ? { embeds: [new EmbedBuilder().setTitle('📋 Key List').setDescription('No licenses in the database.').setColor('Blue')] }
            : { embeds: [built.embed], components: [built.row] };
        const msg = await channel.send(payload);
        keyListPanel = { channelId: channel.id, messageId: msg.id };
        console.log('Key-List panel (#key-list) has been sent.');
    } catch (e) { console.error('Error sending key-list panel:', e.message); }
}

async function refreshKeyListPanel() {
    try {
        const built = await buildKeyListPage(0, SORT_TYPES.DEFAULT);
        const payload = built.empty
            ? { embeds: [new EmbedBuilder().setTitle('📋 Key List').setDescription('No licenses in the database.').setColor('Blue')] }
            : { embeds: [built.embed], components: [built.row] };
        if (keyListPanel) {
            const channel = await client.channels.fetch(keyListPanel.channelId).catch(() => null);
            if (channel && channel.isTextBased && channel.isTextBased()) {
                const msg = await channel.messages.fetch(keyListPanel.messageId).catch(() => null);
                if (msg) { await msg.edit(payload).catch(() => {}); return; }
            }
        }
        await sendKeyListPanel();
    } catch (e) { console.error('refreshKeyListPanel:', e.message); }
}

// =================================
//
// User Panel (#user) - per Discord-ID pruefen
//
// =================================
async function sendUserPanel() {
    const channel = getLogChannel('user');
    if (!channel) {
        console.log('User channel (#user) nicht gefunden.');
        return;
    }
    try {
        const embed = new EmbedBuilder()
            .setTitle('👤 User Check')
            .setDescription('> Discord-ID eingeben und sehen:\n> • verknuepfter Key\n> • wer den Key erstellt hat\n> • letzter Inject + letzter Login\n> • Plan, Ablauf, HWID')
            .setColor('Purple')
            .setFooter({ text: 'REQUST' })
            .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('user_check').setLabel('User Check').setStyle(ButtonStyle.Primary)
        );
        await channel.send({ embeds: [embed], components: [row] });
        console.log('User panel (#user) has been sent.');
    } catch (e) { console.error('Error sending user panel:', e.message); }
}

async function buildUserInfoEmbed(discordId) {
    const user = await client.users.fetch(discordId).catch(() => null);
    const licenses = await db.getLicensesByDiscordId(discordId);
    const embed = new EmbedBuilder().setTimestamp();

    if (!licenses || licenses.length === 0) {
        return embed
            .setTitle('👤 User Check')
            .setDescription(`Kein Key mit Discord-ID \`${discordId}\` verknuepft.${user ? `\nUser: ${user} (${user.tag})` : ''}`)
            .setColor('Red');
    }

    const lic = licenses[0];
    const createdBy = lic.created_by_id ? `<@${lic.created_by_id}>` : (lic.created_by_tag || 'Unknown');
    const lastLogin = lic.last_login ? `<t:${Math.floor(new Date(lic.last_login).getTime() / 1000)}:F>` : 'Never';
    const lastInject = lic.last_inject ? `<t:${Math.floor(new Date(lic.last_inject).getTime() / 1000)}:F>` : 'Never';
    const expiresAt = lic.expires_at ? `<t:${Math.floor(new Date(lic.expires_at).getTime() / 1000)}:F>` : 'Lifetime';

    return embed
        .setTitle(`👤 User Check - ${user ? user.tag : discordId}`)
        .setColor('Purple')
        .addFields(
            { name: 'User', value: user ? `${user} (\`${discordId}\`)` : `\`${discordId}\``, inline: false },
            { name: 'License Key', value: `||${lic.license_key}||`, inline: false },
            { name: 'Product / Plan', value: `${lic.product} / ${planOfLicense(lic)}`, inline: true },
            { name: 'Expires', value: `${expiresAt} (${formatExpiry(lic.expires_at)})`, inline: true },
            { name: 'Key erstellt von', value: `${createdBy}`, inline: false },
            { name: 'Letzter Inject', value: lastInject, inline: true },
            { name: 'Letzter Login', value: lastLogin, inline: true },
            { name: 'HWID', value: lic.linked_hwid ? `||${lic.linked_hwid}||` : 'None', inline: false }
        );
}

// =================================
//
// Bot Status Panel (#bot) + Restart
//
// =================================
function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    parts.push(`${sec}s`);
    return parts.join(' ');
}

function buildBotEmbed() {
    const guild = client.guilds.cache.get(config.guildId);
    return new EmbedBuilder()
        .setTitle('🤖 REQUST Bot Status')
        .setColor('Green')
        .addFields(
            { name: 'Status', value: '🟢 Online', inline: true },
            { name: 'Ping', value: `${client.ws.ping} ms`, inline: true },
            { name: 'Online seit', value: `<t:${Math.floor(bootTime / 1000)}:R> (${formatUptime(Date.now() - bootTime)})`, inline: false },
            { name: 'Server', value: guild ? `${guild.name}` : '-', inline: true },
            { name: 'API', value: `Port ${config.apiPort}`, inline: true }
        )
        .setFooter({ text: 'REQUST' })
        .setTimestamp();
}

function botRestartRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bot_restart').setLabel('Restart').setStyle(ButtonStyle.Danger)
    );
}

let botPanel = null; // { channelId, messageId }

async function sendBotPanel() {
    const channel = getLogChannel('bot');
    if (!channel) {
        console.log('Bot channel (#bot) nicht gefunden.');
        return;
    }
    try {
        const msg = await channel.send({ embeds: [buildBotEmbed()], components: [botRestartRow()] });
        botPanel = { channelId: channel.id, messageId: msg.id };
        console.log('Bot panel (#bot) has been sent.');
    } catch (e) { console.error('Error sending bot panel:', e.message); }
}

async function updateBotPanel() {
    try {
        if (!botPanel) return sendBotPanel();
        const channel = await client.channels.fetch(botPanel.channelId).catch(() => null);
        if (!channel || !channel.isTextBased || !channel.isTextBased()) return;
        const msg = await channel.messages.fetch(botPanel.messageId).catch(() => null);
        if (msg) await msg.edit({ embeds: [buildBotEmbed()], components: [botRestartRow()] }).catch(() => {});
        else await sendBotPanel();
    } catch (e) { console.error('updateBotPanel:', e.message); }
}

// =================================
//
// Config-Cloud Panel (Discord-Login fuer die Website)
//
// =================================
function buildCloudPanelEmbed() {
    return new EmbedBuilder()
        .setTitle('🔐 Config Cloud · Website-Login')
        .setDescription(
            '> Hier kannst du dich für das **Config-Cloud Panel** anmelden.\n' +
            '> Klicke auf **Login**, um einen einmaligen Code zu erhalten.\n' +
            '> Gib den Code anschließend auf der Website ein.'
        )
        .addFields(
            { name: '🌐 Website', value: CLOUD_PANEL_URL, inline: false },
            { name: '⏱️ Gültigkeit', value: '> Der Code ist **5 Minuten** gültig.', inline: false }
        )
        .setColor('#5865F2')
        .setFooter({ text: 'REQUST' })
        .setTimestamp();
}

function cloudLoginRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cloud_panel_login').setLabel('Login').setStyle(ButtonStyle.Primary)
    );
}

let cloudPanel = null; // { channelId, messageId }

async function sendCloudPanel() {
    const channel = await client.channels.fetch(CLOUD_PANEL_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased || !channel.isTextBased()) {
        console.log(`Config-Cloud Panel-Channel (${CLOUD_PANEL_CHANNEL_ID}) nicht gefunden.`);
        return;
    }
    try {
        let existing = cloudPanel
            ? await channel.messages.fetch(cloudPanel.messageId).catch(() => null)
            : null;
        if (!existing) {
            const recent = await channel.messages.fetch({ limit: 25 }).catch(() => null);
            if (recent) {
                existing = recent.find(m =>
                    m.author.id === client.user.id &&
                    m.components && m.components.some(r => (r.components || []).some(c => (c.customId || c.custom_id) === 'cloud_panel_login'))
                ) || null;
            }
        }
        if (existing) {
            cloudPanel = { channelId: channel.id, messageId: existing.id };
            await existing.edit({ embeds: [buildCloudPanelEmbed()], components: [cloudLoginRow()] }).catch(() => {});
            console.log('Config-Cloud panel updated.');
            return;
        }
        const msg = await channel.send({ embeds: [buildCloudPanelEmbed()], components: [cloudLoginRow()] });
        cloudPanel = { channelId: channel.id, messageId: msg.id };
        console.log('Config-Cloud panel has been sent.');
    } catch (e) { console.error('Error sending cloud panel:', e.message); }
}

// =================================
//
// Statische Header (#inject / #login)
//
// =================================
async function channelIsEmpty(channel) {
    try {
        const msgs = await channel.messages.fetch({ limit: 1 });
        return msgs.size === 0;
    } catch (e) { return true; }
}

async function sendStaticHeaders() {
    try {
        // Header nur posten, wenn der Channel leer ist (keine Doppel-Header nach Restart,
        // da #inject/#login jetzt erhalten bleiben).
        const inj = getLogChannel('inject');
        if (inj && await channelIsEmpty(inj)) await inj.send({ embeds: [new EmbedBuilder().setTitle('💉 Inject Logs').setDescription('> Jeder Inject aus dem Loader landet hier mit Key + Zeitpunkt.').setColor('Purple')] }).catch(() => {});
        const log = getLogChannel('login');
        if (log && await channelIsEmpty(log)) await log.send({ embeds: [new EmbedBuilder().setTitle('🔐 Login Logs').setDescription('> Jeder Loader-Login landet hier.').setColor('Blue')] }).catch(() => {});
        // #logger bleibt vorerst leer.
    } catch (e) { console.error('sendStaticHeaders:', e.message); }
}

// =================================
//
// Statistics Channels Functions
//
// =================================
//
async function initializeStatsChannels() {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;

    try {
        let statsCategory = guild.channels.cache.find(
            channel => channel.name === '📊 STATISTICS' && channel.type === ChannelType.GuildCategory
        );

        if (!statsCategory) {
            statsCategory = await guild.channels.create({
                name: '📊 STATISTICS',
                type: ChannelType.GuildCategory,
                permissionOverwrites: [
                    {
                        id: guild.id,
                        deny: [PermissionFlagsBits.Connect]
                    }
                ]
            });
        }

        const channelsConfig = [
            { name: '👥 | Customers: 0', type: ChannelType.GuildVoice, id: 'customersChannel' },
            { name: '🔑 | Active Licenses: 0', type: ChannelType.GuildVoice, id: 'activeLicensesChannel' },
            { name: '🌐 | Active Users: 0', type: ChannelType.GuildVoice, id: 'activeUsersChannel' }
        ];

        for (const channelConfig of channelsConfig) {
            let channel = guild.channels.cache.find(
                ch => ch.name.startsWith(channelConfig.name.split('|')[0]) && 
                      ch.type === ChannelType.GuildVoice &&
                      ch.parentId === statsCategory.id
            );

            if (!channel) {
                channel = await guild.channels.create({
                    name: channelConfig.name,
                    type: channelConfig.type,
                    parent: statsCategory.id,
                    permissionOverwrites: [
                        {
                            id: guild.id,
                            deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
                        }
                    ]
                });
            }

            config.voiceChannels = config.voiceChannels || {};
            config.voiceChannels[channelConfig.id] = channel.id;
        }

        console.log('Statistics channels have been initialized');
        await updateStatsChannels();
    } catch (error) {
        console.error('Error during statistics channels initialization:', error);
    }
}

async function updateStatsChannels() {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild || !config.voiceChannels) return;

    try {
        const customerRole = guild.roles.cache.get(config.customerRoleId);
        const totalCustomers = customerRole ? customerRole.members.size : 0;

        const activeLicenses = await db.getActiveLicensesCount();
        const activeUsers = await db.getActiveUsersCount();

        const customersChannel = guild.channels.cache.get(config.voiceChannels.customersChannel);
        const activeLicensesChannel = guild.channels.cache.get(config.voiceChannels.activeLicensesChannel);
        const activeUsersChannel = guild.channels.cache.get(config.voiceChannels.activeUsersChannel);

        if (customersChannel) {
            await customersChannel.setName(`👥 | Customers: ${totalCustomers}`).catch(console.error);
        }
        if (activeLicensesChannel) {
            await activeLicensesChannel.setName(`🔑 | Active Licenses: ${activeLicenses.count}`).catch(console.error);
        }
        if (activeUsersChannel) {
            await activeUsersChannel.setName(`🌐 | Active Users: ${activeUsers.count}`).catch(console.error);
        }
    } catch (error) {
        console.error('Error updating statistics channels:', error);
    }
}

// =================================
//
// Bot Interactions Handling
//
// =================================
//
client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            await handleSlashCommand(interaction);
        } else if (interaction.isButton()) {
            await handleButton(interaction);
        } else if (interaction.isModalSubmit()) {
            await handleModal(interaction);
        }
    } catch (err) {
        console.error(`[INTERACTION-ERROR] id=${interaction.customId || interaction.commandName} von ${interaction.user ? interaction.user.tag : '?'}:`, err && err.stack ? err.stack : err);
        try {
            const msg = `⚠️ Fehler bei dieser Aktion: ${err && err.message ? err.message : err}`;
            if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: msg, ephemeral: true });
            } else if (interaction.isRepliable()) {
                await interaction.followUp({ content: msg, ephemeral: true });
            }
        } catch (_) {}
    }
});

async function handleSlashCommand(interaction) {
    const { commandName } = interaction;

    if (commandName === 'generate-license') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            if (interaction.deferred) {
                return interaction.editReply({ content: "You don't have permission to use this command." });
            }
            return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('gen_day').setLabel('Key · Day').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('gen_month').setLabel('Key · Month').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('gen_lifetime').setLabel('Key · Lifetime').setStyle(ButtonStyle.Success)
        );
        if (interaction.deferred) {
            return interaction.editReply({ content: 'Wähle den Key-Typ:', components: [row] });
        }
        return interaction.reply({ content: 'Wähle den Key-Typ:', ephemeral: true, components: [row] });
    }

    if (commandName === 'license-delete') {
        if (!hasPriv(interaction.member, config.deleteRoleId)) {
            if (interaction.deferred) {
                return interaction.editReply({ content: "You don't have permission to use this command." });
            }
            return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId('delete_license_modal').setTitle('Delete a License')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("License key to delete").setStyle(TextInputStyle.Short).setRequired(true)));
        await interaction.showModal(modal);
    }

    if (commandName === 'reset-discord' || commandName === 'reset-hwid') {
        const modalId = commandName === 'reset-discord' ? 'reset_discord_modal' : 'reset_hwid_modal';
        const modal = new ModalBuilder().setCustomId(modalId).setTitle(`Reset ${commandName === 'reset-discord' ? 'Discord' : 'HWID'}`)
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("Enter your license key").setStyle(TextInputStyle.Short).setRequired(true)));
        // If deferred, need to delete reply first
        if (interaction.deferred) {
            try { await interaction.deleteReply(); } catch (e) {}
        }
        await interaction.showModal(modal);
    }

    if (commandName === 'admin-hwid') {
        if (!hasPriv(interaction.member, config.adminHwidResetRoleId)) {
            if (interaction.deferred) {
                return interaction.editReply({ content: "You don't have permission to use this command." });
            }
            return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId('admin_hwid_modal').setTitle('ADMIN: Reset HWID')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("Enter license key").setStyle(TextInputStyle.Short).setRequired(true)));
        if (interaction.deferred) {
            try { await interaction.deleteReply(); } catch (e) {}
        }
        await interaction.showModal(modal);
    }

    if (commandName === 'admin-discord') {
        if (!hasPriv(interaction.member, config.adminDiscordResetRoleId)) {
            if (interaction.deferred) {
                return interaction.editReply({ content: "You don't have permission to use this command." });
            }
            return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId('admin_discord_modal').setTitle('ADMIN: Reset Discord ID')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("Enter license key").setStyle(TextInputStyle.Short).setRequired(true)));
        if (interaction.deferred) {
            try { await interaction.deleteReply(); } catch (e) {}
        }
        await interaction.showModal(modal);
    }

    if (commandName === 'licenses-check') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            if (interaction.deferred) {
                return interaction.editReply({ content: "You don't have permission to use this command." });
            }
            return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }

        const licenseKey = interaction.options.getString('license');
        
        if (licenseKey) {
            await showSingleLicense(interaction, licenseKey);
        } else {
            await showAllLicenses(interaction, 0, SORT_TYPES.DEFAULT);
        }
    }

    if (commandName === 'stats') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            if (interaction.deferred) {
                return interaction.editReply({ content: "You don't have permission to use this command." });
            }
            return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }
        await showDetailedStats(interaction);
    }

    // NEW COMMANDS
    if (commandName === 'freeze') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            if (interaction.deferred) {
                return interaction.editReply({ content: "You don't have permission to use this command." });
            }
            return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }
        if (interaction.deferred) {
            try { await interaction.deleteReply(); } catch (e) {}
        }

        const modal = new ModalBuilder()
            .setCustomId('freeze_modal')
            .setTitle('Freeze License');

        const licenseInput = new TextInputBuilder()
            .setCustomId('license_input')
            .setLabel("License (All/Specific license key)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const timeInput = new TextInputBuilder()
            .setCustomId('time_input')
            .setLabel("Time (e.g., 1d, 7d, 1m, 1y)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const informInput = new TextInputBuilder()
            .setCustomId('inform_input')
            .setLabel("Inform customers (Yes/No)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(licenseInput);
        const secondActionRow = new ActionRowBuilder().addComponents(timeInput);
        const thirdActionRow = new ActionRowBuilder().addComponents(informInput);

        modal.addComponents(firstActionRow, secondActionRow, thirdActionRow);
        await interaction.showModal(modal);
    }

    if (commandName === 'unfreeze') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            if (interaction.deferred) {
                return interaction.editReply({ content: "You don't have permission to use this command." });
            }
            return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }
        if (interaction.deferred) {
            try { await interaction.deleteReply(); } catch (e) {}
        }

        const modal = new ModalBuilder()
            .setCustomId('unfreeze_modal')
            .setTitle('Unfreeze License');

        const licenseInput = new TextInputBuilder()
            .setCustomId('license_input')
            .setLabel("License (All/Specific license key)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const informInput = new TextInputBuilder()
            .setCustomId('inform_input')
            .setLabel("Inform customers (Yes/No)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(licenseInput);
        const secondActionRow = new ActionRowBuilder().addComponents(informInput);

        modal.addComponents(firstActionRow, secondActionRow);
        await interaction.showModal(modal);
    }

    if (commandName === 'addtime') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            if (interaction.deferred) {
                return interaction.editReply({ content: "You don't have permission to use this command." });
            }
            return interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
        }
        if (interaction.deferred) {
            try { await interaction.deleteReply(); } catch (e) {}
        }

        const modal = new ModalBuilder()
            .setCustomId('addtime_modal')
            .setTitle('Add Time to License');

        const licenseInput = new TextInputBuilder()
            .setCustomId('license_input')
            .setLabel("License (All/Specific/Frozen)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const timeInput = new TextInputBuilder()
            .setCustomId('time_input')
            .setLabel("How much time (e.g., 1d, 7d, 1m, 1y)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const informInput = new TextInputBuilder()
            .setCustomId('inform_input')
            .setLabel("Inform customers (Yes/No)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(licenseInput);
        const secondActionRow = new ActionRowBuilder().addComponents(timeInput);
        const thirdActionRow = new ActionRowBuilder().addComponents(informInput);

        modal.addComponents(firstActionRow, secondActionRow, thirdActionRow);
        await interaction.showModal(modal);
    }
}

// Function to display detailed statistics
async function showDetailedStats(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const guild = client.guilds.cache.get(config.guildId);
        const customerRole = guild.roles.cache.get(config.customerRoleId);
        const totalCustomers = customerRole ? customerRole.members.size : 0;

        const activeLicenses = await db.getActiveLicensesCount();
        const activeUsers = await db.getActiveUsersCount();
        const licenseStats = await db.getLicenseStats();
        const countryStats = await db.getCountryStats();
        const resetStats = await db.getResetStats();
        const recentActivity = await db.getRecentActivity();

        // Main embed with statistics
        const mainEmbed = new EmbedBuilder()
            .setTitle('📊 DETAILED SYSTEM STATISTICS')
            .setColor('Blue')
            .setTimestamp()
            .addFields(
                {
                    name: '👥 USER STATISTICS',
                    value: `**• Customers:** ${totalCustomers}\n**• Active users:** ${activeUsers.count}\n**• Active licenses:** ${activeLicenses.count}`,
                    inline: false
                },
                {
                    name: '🔄 RESET STATISTICS',
                    value: `**• Used resets:** ${resetStats.total_resets_used || 0}\n**• Available resets:** ${resetStats.total_resets_available || 0}\n**• Usage:** ${((resetStats.total_resets_used / (resetStats.total_resets_available || 1)) * 100).toFixed(2)}%`,
                    inline: false
                }
            );

        // Embed for license statistics
        const licenseEmbed = new EmbedBuilder()
            .setTitle('📦 LICENSE STATISTICS')
            .setColor('Green')
            .setTimestamp();

        let licenseDescription = '';
        licenseStats.forEach(stat => {
            licenseDescription += `**${stat.product}:**\n`;
            licenseDescription += `• Total: ${stat.total}\n`;
            licenseDescription += `• Activated: ${stat.activated}\n`;
            licenseDescription += `• Available: ${stat.available}\n`;
            licenseDescription += `• Expired: ${stat.expired}\n\n`;
        });
        licenseEmbed.setDescription(licenseDescription);

        // Embed for country statistics
        const countryEmbed = new EmbedBuilder()
            .setTitle('🌍 COUNTRY STATISTICS')
            .setColor('Orange')
            .setTimestamp();

        let countryDescription = '';
        if (countryStats.length > 0) {
            countryStats.forEach(stat => {
                countryDescription += `**${stat.country}:** ${stat.user_count} users (${stat.percentage}%)\n`;
            });
        } else {
            countryDescription = 'No country data available';
        }
        countryEmbed.setDescription(countryDescription);

        // Embed for recent activity
        const activityEmbed = new EmbedBuilder()
            .setTitle('🕐 RECENT ACTIVITY')
            .setColor('Purple')
            .setTimestamp();

        let activityDescription = '';
        if (recentActivity.length > 0) {
            recentActivity.forEach(activity => {
                const timeAgo = `<t:${Math.floor(new Date(activity.start_time).getTime() / 1000)}:R>`;
                activityDescription += `**${activity.product}** - <@${activity.discord_id}>\n`;
                activityDescription += `• Country: ${activity.country || 'Unknown'}\n`;
                activityDescription += `• Time: ${timeAgo}\n\n`;
            });
        } else {
            activityDescription = 'No recent activity';
        }
        activityEmbed.setDescription(activityDescription);

        await interaction.editReply({ 
            embeds: [mainEmbed, licenseEmbed, countryEmbed, activityEmbed]
        });

    } catch (error) {
        console.error('Error fetching statistics:', error);
        await interaction.editReply({ 
            content: 'An error occurred while fetching statistics.', 
            ephemeral: true 
        });
    }
}

// Function to display all licenses with pagination
async function showAllLicenses(interaction, page = 0, sortType = SORT_TYPES.DEFAULT, isUpdate = false) {
    const licensesPerPage = 5;
    
    const allLicenses = await db.getAllLicenses();
    
    if (!allLicenses || allLicenses.length === 0) {
        if (isUpdate) {
            return interaction.editReply({ content: "No licenses in the database." });
        }
        return interaction.reply({ content: "No licenses in the database.", ephemeral: true });
    }

    let sortedLicenses;
    switch (sortType) {
        case SORT_TYPES.TEMP:
            sortedLicenses = allLicenses.sort((a, b) => {
                if (a.product === 'Temp' && b.product !== 'Temp') return -1;
                if (a.product !== 'Temp' && b.product === 'Temp') return 1;
                return 0;
            });
            break;
        case SORT_TYPES.PRIVATE:
            sortedLicenses = allLicenses.sort((a, b) => {
                if (a.product === 'Private' && b.product !== 'Private') return -1;
                if (a.product !== 'Private' && b.product === 'Private') return 1;
                return 0;
            });
            break;
        case SORT_TYPES.PUBLIC:
            sortedLicenses = allLicenses.sort((a, b) => {
                if (a.product === 'Public' && b.product !== 'Public') return -1;
                if (a.product !== 'Public' && b.product === 'Public') return 1;
                return 0;
            });
            break;
        case SORT_TYPES.PERM:
            sortedLicenses = allLicenses.sort((a, b) => {
                if (a.product === 'Perm' && b.product !== 'Perm') return -1;
                if (a.product !== 'Perm' && b.product === 'Perm') return 1;
                return 0;
            });
            break;
        default:
            const productOrder = { 'Temp': 0, 'Private': 1, 'Public': 2, 'Perm': 3 };
            sortedLicenses = allLicenses.sort((a, b) => {
                return productOrder[a.product] - productOrder[b.product];
            });
    }

    const totalPages = Math.ceil(sortedLicenses.length / licensesPerPage);
    const startIndex = page * licensesPerPage;
    const endIndex = startIndex + licensesPerPage;
    const currentLicenses = sortedLicenses.slice(startIndex, endIndex);

    const embed = new EmbedBuilder()
        .setTitle(`📋 Licenses List (Page ${page + 1}/${totalPages})`)
        .setColor('Blue')
        .setFooter({ text: `Sorting: ${SORT_DISPLAY_NAMES[sortType]}` })
        .setTimestamp();

    currentLicenses.forEach((license, index) => {
        const globalIndex = startIndex + index + 1;
        const status = (!license.linked_discord_id && !license.linked_hwid) ? 'Not used 🟢' : 'Used 🔴';
        const createdBy = license.created_by_id ? `<@${license.created_by_id}>` : license.created_by_tag;
        const createdAt = license.created_at ? `<t:${Math.floor(new Date(license.created_at).getTime() / 1000)}:F>` : 'Unknown';
        const resetsLimit = license.resets_limit === -1 ? '∞' : license.resets_limit;
        const remainingResets = license.resets_limit === -1 ? '∞' : (license.resets_limit - license.resets_used);

        embed.addFields({
            name: `**License #${globalIndex} - ${license.product}**`,
            value: `- Status: ${status}\n- Created by: ${createdBy}\n- Created at: ${createdAt}\n- Default Resets: ${resetsLimit} resets\n- Remaining Resets: ${remainingResets} resets\n- License Key: ||${license.license_key}||`,
            inline: false
        });
    });

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`licenses_prev_${page}_${sortType}`)
                .setLabel('◀')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page === 0),
            new ButtonBuilder()
                .setCustomId(`licenses_sort_${sortType}`)
                .setLabel(`Sort by: ${SORT_DISPLAY_NAMES[sortType]}`)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`licenses_next_${page}_${sortType}`)
                .setLabel('▶')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(page === totalPages - 1)
        );

    if (isUpdate) {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ embeds: [embed], components: [row] });
        } else {
            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }
    } else {
        if (interaction.deferred) {
            await interaction.editReply({ embeds: [embed], components: [row] });
        } else {
            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }
    }
}

// Function to display a single license
async function showSingleLicense(interaction, licenseKey) {
    const license = await db.getLicense(licenseKey);
    
    if (!license) {
        if (interaction.deferred) {
            return interaction.editReply({ content: "No license found with the provided key." });
        }
        return interaction.reply({ content: "No license found with the provided key.", ephemeral: true });
    }

    const status = (!license.linked_discord_id && !license.linked_hwid) ? 'Not used 🟢' : 'Used 🔴';
    const createdBy = license.created_by_id ? `<@${license.created_by_id}>` : license.created_by_tag;
    const createdAt = license.created_at ? `<t:${Math.floor(new Date(license.created_at).getTime() / 1000)}:F>` : 'Unknown';
    const expiresAt = license.expires_at ? `<t:${Math.floor(new Date(license.expires_at).getTime() / 1000)}:F>` : 'Never';
    const resetsLimit = license.resets_limit === -1 ? '∞' : license.resets_limit;
    const remainingResets = license.resets_limit === -1 ? '∞' : (license.resets_limit - license.resets_used);
    const linkedDiscord = license.linked_discord_id ? `<@${license.linked_discord_id}>` : 'None';
    const lastLogin = license.last_login ? `<t:${Math.floor(new Date(license.last_login).getTime() / 1000)}:F>` : 'Never';

    const embed = new EmbedBuilder()
        .setTitle(`📋 License Details - ${license.product}`)
        .setColor(status.includes('🟢') ? 'Green' : 'Red')
        .addFields(
            { name: 'Status', value: status, inline: true },
            { name: 'Product', value: license.product, inline: true },
            { name: 'Duration', value: license.duration, inline: true },
            { name: 'Created by', value: createdBy, inline: true },
            { name: 'Created at', value: createdAt, inline: true },
            { name: 'Expires at', value: expiresAt, inline: true },
            { name: 'Linked Discord', value: linkedDiscord, inline: true },
            { name: 'Last Login', value: lastLogin, inline: true },
            { name: 'Default Resets', value: `${resetsLimit} resets`, inline: true },
            { name: 'Remaining Resets', value: `${remainingResets} resets`, inline: true },
            { name: 'Resets Used', value: `${license.resets_used}`, inline: true },
            { name: 'License Key', value: `||${license.license_key}||`, inline: false }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Handle pagination buttons
async function handleButton(interaction) {
    // ---- Config-Cloud Website-Login ----
    if (interaction.customId === 'cloud_panel_login') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            return interaction.reply({ content: "You don't have permission to log in to the panel.", ephemeral: true });
        }
        const code = makeCloudCode();
        cloudLoginCodes.set(code, { expires: Date.now() + 5 * 60 * 1000, adminTag: interaction.user.tag });
        console.log(`[CONFIG-CODE] ${code} generiert fuer ${interaction.user.tag}`);
        return interaction.reply({
            content: `🔐 **Dein Login-Code:** \`${code}\`\n> Gültig **5 Minuten**. Gib ihn auf der Website ein: ${CLOUD_PANEL_URL}`,
            ephemeral: true
        });
    }

    // ---- Bot Restart (#bot Panel) ----
    if (interaction.customId === 'bot_restart') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            return interaction.reply({ content: "You don't have permission to restart the bot.", ephemeral: true });
        }
        await interaction.reply({ content: '🔄 Bot wird neugestartet ...', ephemeral: true }).catch(() => {});
        console.log(`Bot-Restart angefordert von ${interaction.user.tag}.`);
        setTimeout(() => process.exit(0), 1500);
        return;
    }

    // ---- User Check (#user Panel) ----
    if (interaction.customId === 'user_check') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            return interaction.reply({ content: "You don't have permission to use this function.", ephemeral: true });
        }
        const modal = new ModalBuilder().setCustomId('user_check_modal').setTitle('User Check')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('discord_id').setLabel("Discord ID").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(5).setMaxLength(32)));
        return interaction.showModal(modal);
    }

    // ---- Key generation buttons (Day / Month / Lifetime) ----
    if (interaction.customId === 'gen_day' || interaction.customId === 'gen_month' || interaction.customId === 'gen_lifetime') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            return interaction.reply({ content: "You don't have permission to create keys.", ephemeral: true });
        }

        const plan = interaction.customId.replace('gen_', '');
        const title = plan === 'day' ? 'Key · Day' : plan === 'month' ? 'Key · Month' : 'Key · Lifetime';

        const resetsInput = new TextInputBuilder()
            .setCustomId('resets')
            .setLabel("HWID/Discord ID Resets (* for ∞)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const modal = new ModalBuilder()
            .setCustomId(`gen_${plan}_modal`)
            .setTitle(title);

        if (plan === 'day' || plan === 'month') {
            const amountInput = new TextInputBuilder()
                .setCustomId('amount')
                .setLabel(plan === 'day' ? "Anzahl Tage" : "Anzahl Monate")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(
                new ActionRowBuilder().addComponents(amountInput),
                new ActionRowBuilder().addComponents(resetsInput)
            );
        } else {
            modal.addComponents(new ActionRowBuilder().addComponents(resetsInput));
        }

        return interaction.showModal(modal);
    }

    if (interaction.customId === 'licenses_check') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            return interaction.reply({ content: "You don't have permission to use this function.", ephemeral: true });
        }
        return showAllLicenses(interaction, 0, SORT_TYPES.DEFAULT);
    }

    if (interaction.customId === 'stats') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            return interaction.reply({ content: "You don't have permission to use this function.", ephemeral: true });
        }
        return showDetailedStats(interaction);
    }

    if (interaction.customId === 'delete_key') {
        if (!hasPriv(interaction.member, config.deleteRoleId)) {
            return interaction.reply({ content: "You don't have permission to use this function.", ephemeral: true });
        }
        const modal = new ModalBuilder().setCustomId('delete_license_modal').setTitle('Delete a License')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("License key to delete").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
    }

    if (interaction.customId === 'freeze_key' || interaction.customId === 'unfreeze_key' || interaction.customId === 'addtime_key') {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            return interaction.reply({ content: "You don't have permission to use this function.", ephemeral: true });
        }

        const modalId = interaction.customId.replace('_key', '_modal');
        const titles = {
            'freeze_modal': 'Freeze License',
            'unfreeze_modal': 'Unfreeze License',
            'addtime_modal': 'Add Time to License'
        };

        const licenseInput = new TextInputBuilder()
            .setCustomId('license_input')
            .setLabel(modalId === 'freeze_modal' ? "License (All/Specific license key)" :
                      modalId === 'addtime_modal' ? "License (All/Specific/Frozen)" : "License (All/Specific license key)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const informInput = new TextInputBuilder()
            .setCustomId('inform_input')
            .setLabel("Inform customers (Yes/No)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const modal = new ModalBuilder().setCustomId(modalId).setTitle(titles[modalId]);
        modal.addComponents(new ActionRowBuilder().addComponents(licenseInput));

        if (modalId !== 'unfreeze_modal') {
            const timeInput = new TextInputBuilder()
                .setCustomId('time_input')
                .setLabel(modalId === 'addtime_modal' ? "How much time (e.g., 1d, 7d, 1m, 1y)" : "Time (e.g., 1d, 7d, 1m, 1y)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(timeInput));
        }

        modal.addComponents(new ActionRowBuilder().addComponents(informInput));
        return interaction.showModal(modal);
    }

    if (interaction.customId === 'admin_hwid') {
        if (!hasPriv(interaction.member, config.adminHwidResetRoleId)) {
            return interaction.reply({ content: "You don't have permission to use this function.", ephemeral: true });
        }
        const modal = new ModalBuilder().setCustomId('admin_hwid_modal').setTitle('ADMIN: Reset HWID')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("Enter license key").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
    }

    if (interaction.customId === 'admin_discord') {
        if (!hasPriv(interaction.member, config.adminDiscordResetRoleId)) {
            return interaction.reply({ content: "You don't have permission to use this function.", ephemeral: true });
        }
        const modal = new ModalBuilder().setCustomId('admin_discord_modal').setTitle('ADMIN: Reset Discord ID')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("Enter license key").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
    }

    if (interaction.customId === 'reset_discord') {
        const modal = new ModalBuilder().setCustomId('reset_discord_modal').setTitle('Reset Discord')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("Enter your license key").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
    }

    if (interaction.customId === 'reset_hwid') {
        const modal = new ModalBuilder().setCustomId('reset_hwid_modal').setTitle('Reset HWID')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("Enter your license key").setStyle(TextInputStyle.Short).setRequired(true)));
        return interaction.showModal(modal);
    }

    if (interaction.customId === 'redeem_key_button') {
        const modal = new ModalBuilder().setCustomId('redeem_key_modal').setTitle('Redeem Your Customer Role')
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('license_key').setLabel("Enter your license key").setStyle(TextInputStyle.Short).setRequired(true)));
        await interaction.showModal(modal);
    } 
    else if (interaction.customId.startsWith('licenses_prev_') || interaction.customId.startsWith('licenses_next_')) {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            return interaction.reply({ content: "You don't have permission to use this function.", ephemeral: true });
        }

        const parts = interaction.customId.split('_');
        const action = parts[1];
        const page = parseInt(parts[2]);
        const sortType = parts[3] || SORT_TYPES.DEFAULT;

        const newPage = action === 'prev' ? page - 1 : page + 1;

        await interaction.deferUpdate();
        await showAllLicenses(interaction, newPage, sortType, true);
    }
    else if (interaction.customId.startsWith('licenses_sort_')) {
        if (!hasPriv(interaction.member, config.adminRoleId)) {
            return interaction.reply({ content: "You don't have permission to use this function.", ephemeral: true });
        }

        const parts = interaction.customId.split('_');
        const currentSortType = parts[2] || SORT_TYPES.DEFAULT;
        
        const currentIndex = SORT_ORDER.indexOf(currentSortType);
        const nextIndex = (currentIndex + 1) % SORT_ORDER.length;
        const nextSortType = SORT_ORDER[nextIndex];

        await interaction.deferUpdate();
        await showAllLicenses(interaction, 0, nextSortType, true);
    }
}

// Creates a license for a given plan and stores + DMs + logs it.
async function createLicense(interaction, opts) {
    const { product, durationStr, expiresAt, planLabel, resetsStr } = opts;

    const licenseKey = `RQS-${generateRandomString(6)}-${generateRandomString(6)}-${generateRandomString(6)}`;
    const createdAt = new Date();
    const resetsLimit = resetsStr === '*' ? -1 : parseInt(resetsStr);
    if (isNaN(resetsLimit) || resetsLimit < 0) return { error: "Reset count must be a number or '*'." };

    await db.addLicense({
        key: licenseKey,
        product,
        duration: durationStr,
        createdAt,
        expiresAt,
        createdById: interaction.user.id,
        createdByTag: interaction.user.tag,
        resetsLimit
    });

    const durationText = expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:F>` : 'Permanent';
    const dmEmbed = new EmbedBuilder().setTitle("License Generated!").setColor("Green")
        .setDescription(`> Date generated: <t:${Math.floor(createdAt.getTime() / 1000)}:F>\n> Plan: **${planLabel}**\n> Product: **${product}**\n> Duration: ${durationText}\n> HWID / Discord ID Resets: **${resetsStr} resets**\n\n> **License Key:** ||${licenseKey}||`);
    await interaction.user.send({ embeds: [dmEmbed] }).catch(() => console.log("Cannot send DM to user."));

    {
        const logEmbed = new EmbedBuilder().setTitle("License Generated!").setColor("Blue")
            .setDescription(`> Date generated: <t:${Math.floor(createdAt.getTime() / 1000)}:F>\n> Generated by: ${interaction.user}\n> Plan: **${planLabel}**\n> Product: **${product}**\n> Duration: ${durationText}\n> HWID / Discord ID Resets: **${resetsStr} resets**\n\n> **License Key:** ||${licenseKey}||`);
        await sendLog('all', { embeds: [logEmbed] });
        await refreshKeyListPanel();
    }

    return { key: licenseKey };
}

async function handleModal(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (interaction.customId === 'user_check_modal') {
        const discordId = interaction.fields.getTextInputValue('discord_id').trim();
        try {
            const embed = await buildUserInfoEmbed(discordId);
            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            console.error('user_check_modal:', e.message);
            return interaction.editReply({ content: 'Fehler beim User-Check.' });
        }
    }

    if (interaction.customId === 'gen_day_modal' || interaction.customId === 'gen_month_modal' || interaction.customId === 'gen_lifetime_modal') {
        const plan = interaction.customId.replace('_modal', '').replace('gen_', '');
        const resetsStr = interaction.fields.getTextInputValue('resets');

        let product, durationStr, expiresAt = null, planLabel;

        if (plan === 'day') {
            const amount = parseInt(interaction.fields.getTextInputValue('amount'));
            if (!Number.isInteger(amount) || amount < 1) return interaction.editReply({ content: "Invalid amount. Enter a positive number." });
            const d = parseDuration(`${amount}d`);
            if (!d) return interaction.editReply({ content: "Invalid day amount." });
            product = 'Temp';
            durationStr = `${amount}d`;
            expiresAt = d;
            planLabel = PLAN_LABELS.day;
        } else if (plan === 'month') {
            const amount = parseInt(interaction.fields.getTextInputValue('amount'));
            if (!Number.isInteger(amount) || amount < 1) return interaction.editReply({ content: "Invalid amount. Enter a positive number." });
            const d = parseDuration(`${amount}m`);
            if (!d) return interaction.editReply({ content: "Invalid month amount." });
            product = 'Private';
            durationStr = `${amount}m`;
            expiresAt = d;
            planLabel = PLAN_LABELS.month;
        } else {
            product = 'Perm';
            durationStr = 'lifetime';
            expiresAt = null;
            planLabel = PLAN_LABELS.lifetime;
        }

        const result = await createLicense(interaction, {
            product, durationStr, expiresAt, planLabel, resetsStr
        });
        if (result.error) return interaction.editReply({ content: result.error });
        await interaction.editReply("License created successfully! You received the key in a private message!");
    }

    if (interaction.customId === 'redeem_key_modal') {
        const licenseKey = interaction.fields.getTextInputValue('license_key');
        const license = await db.getLicense(licenseKey);
        if (!license) return interaction.editReply({ content: "This license key does not exist." });
        if (!license.linked_discord_id) return interaction.editReply({ content: "This key must be activated first by logging into the program." });
        if (license.linked_discord_id !== interaction.user.id) return interaction.editReply({ content: "This key is assigned to a different Discord account." });
        if (license.role_redeemed) return interaction.editReply({ content: "Customer role has already been redeemed for this key." });

        try {
            const role = await interaction.guild.roles.fetch(config.customerRoleId);
            if (role) await interaction.member.roles.add(role);
            await db.updateLicense(licenseKey, { role_redeemed: true });
            return interaction.editReply({ content: "Successfully received the customer role!" });
        } catch (error) {
            console.error("Error assigning role:", error);
            return interaction.editReply({ content: "An error occurred while assigning the role. Contact an administrator." });
        }
    }

    if (interaction.customId === 'reset_discord_modal') {
        const licenseKey = interaction.fields.getTextInputValue('license_key');
        const license = await db.getLicense(licenseKey);
        if (!license) return interaction.editReply({ content: "This license key does not exist." });
        if (license.linked_discord_id !== interaction.user.id) return interaction.editReply({ content: "You are not the owner of this key." });
        if (license.resets_limit !== -1 && license.resets_used >= license.resets_limit) return interaction.editReply({ content: "You have used all available resets." });

        const oldDiscordId = license.linked_discord_id;
        const newResetsUsed = license.resets_used + 1;
        await db.updateLicense(licenseKey, { linked_discord_id: null, resets_used: newResetsUsed });

        const remaining = license.resets_limit === -1 ? 'unlimited' : license.resets_limit - newResetsUsed;
        await sendResetLog('discord', interaction, license, { oldDiscordId });

        return interaction.editReply(`Your linked Discord account has been unlinked. Remaining resets: \`${remaining}\``);
    }

    if (interaction.customId === 'reset_hwid_modal') {
        const licenseKey = interaction.fields.getTextInputValue('license_key');
        const license = await db.getLicense(licenseKey);
        if (!license) return interaction.editReply({ content: "This license key does not exist." });
        if (license.linked_discord_id !== interaction.user.id) return interaction.editReply({ content: "You are not the owner of this key." });
        if (license.resets_limit !== -1 && license.resets_used >= license.resets_limit) return interaction.editReply({ content: "You have used all available resets." });

        const oldHwid = license.linked_hwid;
        const newResetsUsed = license.resets_used + 1;
        await db.updateLicense(licenseKey, { linked_hwid: null, resets_used: newResetsUsed });

        const remaining = license.resets_limit === -1 ? 'unlimited' : license.resets_limit - newResetsUsed;
        await sendResetLog('hwid', interaction, license, { oldHwid });

        return interaction.editReply(`Your assigned HWID has been reset. Remaining resets: \`${remaining}\``);
    }

    if (interaction.customId === 'delete_license_modal') {
        const raw = interaction.fields.getTextInputValue('license_key') || '';
        const licenseKey = raw.trim().replace(/^\|\|/, '').replace(/\|\|$/, '').replace(/^`+|`+$/g, '').trim();
        const license = await db.getLicense(licenseKey);
        if (!license) return interaction.editReply({ content: "No key found to delete." });

        await db.deleteLicenseDB(licenseKey);

        {
            const embed = new EmbedBuilder().setTitle("License Removed!").setColor("Red").setDescription(`- **License key Information:**\n> License key: ||${license.license_key}||\n> Deleted by: ${interaction.user}\n> Date of deletion: <t:${Math.floor(new Date().getTime() / 1000)}:F>\n> Product: **${license.product}**\n> License Duration: ${license.duration}`);
            await sendLog('key', { embeds: [embed] });
            await refreshKeyListPanel();
        }

        return interaction.editReply(`Successfully deleted license: ${licenseKey}`);
    }

    if (interaction.customId === 'admin_discord_modal') {
        const licenseKey = interaction.fields.getTextInputValue('license_key');
        const license = await db.getLicense(licenseKey);
        if (!license) return interaction.editReply({ content: "This license key does not exist." });

        const oldDiscordId = license.linked_discord_id;
        await db.updateLicense(licenseKey, { linked_discord_id: null });

        await sendResetLog('discord', interaction, license, { oldDiscordId, admin: interaction.user });
        return interaction.editReply(`Successfully reset Discord ID for key ||${licenseKey}||.`);
    }

    if (interaction.customId === 'admin_hwid_modal') {
        const licenseKey = interaction.fields.getTextInputValue('license_key');
        const license = await db.getLicense(licenseKey);
        if (!license) return interaction.editReply({ content: "This license key does not exist." });

        const oldHwid = license.linked_hwid;
        await db.updateLicense(licenseKey, { linked_hwid: null });

        await sendResetLog('hwid', interaction, license, { oldHwid, admin: interaction.user });
        return interaction.editReply(`Successfully reset HWID for key ||${licenseKey}||.`);
    }

    // NEW MODALS
    if (interaction.customId === 'freeze_modal') {
        const licenseValue = interaction.fields.getTextInputValue('license_input');
        const timeValue = interaction.fields.getTextInputValue('time_input');
        const informValue = interaction.fields.getTextInputValue('inform_input').toLowerCase();

        const freezeDuration = parseDuration(timeValue);
        if (!freezeDuration) {
            return interaction.editReply({ content: "Invalid time format. Use 'd', 'm' or 'y'." });
        }

        const frozenUntil = freezeDuration.toISOString();
        let processedLicenses = 0;
        let failedLicenses = 0;

        try {
            if (licenseValue.toLowerCase() === 'all') {
                const allLicenses = await db.getAllLicenses();
                for (const license of allLicenses) {
                    try {
                        await db.freezeLicense(license.license_key, frozenUntil, license.expires_at);
                        processedLicenses++;
                        
                        // Logging action
                        await db.logAdminAction(
                            interaction.user.id,
                            interaction.user.tag,
                            'FREEZE',
                            license.license_key,
                            `Frozen until: ${frozenUntil}, Inform customers: ${informValue}`
                        );

                        // Sending DM to user if requested
                        if (informValue === 'yes' && license.linked_discord_id) {
                            try {
                                const user = await client.users.fetch(license.linked_discord_id);
                                const embed = new EmbedBuilder()
                                    .setTitle('❄️ License Frozen')
                                    .setColor('Blue')
                                    .setDescription(`Your license **${license.license_key}** has been frozen until <t:${Math.floor(freezeDuration.getTime() / 1000)}:F>\n\nDuring this time, your license duration will not decrease.`)
                                    .setTimestamp();
                                await user.send({ embeds: [embed] });
                            } catch (dmError) {
                                console.log(`Cannot send DM to user ${license.linked_discord_id}`);
                            }
                        }
                    } catch (error) {
                        failedLicenses++;
                        console.error(`Error freezing license ${license.license_key}:`, error);
                    }
                }
            } else {
                const license = await db.getLicense(licenseValue);
                if (!license) {
                    return interaction.editReply({ content: "No license found with the provided key." });
                }

                await db.freezeLicense(license.license_key, frozenUntil, license.expires_at);
                processedLicenses++;

                // Logging action
                await db.logAdminAction(
                    interaction.user.id,
                    interaction.user.tag,
                    'FREEZE',
                    license.license_key,
                    `Frozen until: ${frozenUntil}, Inform customers: ${informValue}`
                );

                // Sending DM to user if requested
                if (informValue === 'yes' && license.linked_discord_id) {
                    try {
                        const user = await client.users.fetch(license.linked_discord_id);
                        const embed = new EmbedBuilder()
                            .setTitle('❄️ License Frozen')
                            .setColor('Blue')
                            .setDescription(`Your license **${license.license_key}** has been frozen until <t:${Math.floor(freezeDuration.getTime() / 1000)}:F>\n\nDuring this time, your license duration will not decrease.`)
                            .setTimestamp();
                        await user.send({ embeds: [embed] });
                    } catch (dmError) {
                        console.log(`Cannot send DM to user ${license.linked_discord_id}`);
                    }
                }
            }

            // Log to #key (+ #all-logs)
            {
                const logEmbed = new EmbedBuilder()
                    .setTitle('❄️ License Freeze')
                    .setColor('Blue')
                    .addFields(
                        { name: 'Admin', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
                        { name: 'Target', value: licenseValue, inline: true },
                        { name: 'Frozen Until', value: `<t:${Math.floor(freezeDuration.getTime() / 1000)}:F>`, inline: true },
                        { name: 'Processed', value: `${processedLicenses} licenses`, inline: true },
                        { name: 'Failed', value: `${failedLicenses} licenses`, inline: true },
                        { name: 'Notify Customers', value: informValue === 'yes' ? 'Yes' : 'No', inline: true }
                    )
                    .setTimestamp();
                await sendLog('key', { embeds: [logEmbed] });
            }

            await interaction.editReply({ 
                content: `Successfully frozen ${processedLicenses} licenses.${failedLicenses > 0 ? ` ${failedLicenses} licenses failed to freeze.` : ''}` 
            });

        } catch (error) {
            console.error('Error in freeze modal:', error);
            await interaction.editReply({ content: "An error occurred while freezing licenses." });
        }
    }

    if (interaction.customId === 'unfreeze_modal') {
        const licenseValue = interaction.fields.getTextInputValue('license_input');
        const informValue = interaction.fields.getTextInputValue('inform_input').toLowerCase();

        let processedLicenses = 0;
        let failedLicenses = 0;

        try {
            if (licenseValue.toLowerCase() === 'all') {
                const frozenLicenses = await db.getFrozenLicenses();
                for (const license of frozenLicenses) {
                    try {
                        await db.unfreezeLicense(license.license_key);
                        processedLicenses++;

                        // Logging action
                        await db.logAdminAction(
                            interaction.user.id,
                            interaction.user.tag,
                            'UNFREEZE',
                            license.license_key,
                            `Inform customers: ${informValue}`
                        );

                        // Sending DM to user if requested
                        if (informValue === 'yes' && license.linked_discord_id) {
                            try {
                                const user = await client.users.fetch(license.linked_discord_id);
                                const embed = new EmbedBuilder()
                                    .setTitle('☀️ License Unfrozen')
                                    .setColor('Green')
                                    .setDescription(`Your license **${license.license_key}** has been unfrozen.\n\nYour license duration will now continue to decrease normally.`)
                                    .setTimestamp();
                                await user.send({ embeds: [embed] });
                            } catch (dmError) {
                                console.log(`Cannot send DM to user ${license.linked_discord_id}`);
                            }
                        }
                    } catch (error) {
                        failedLicenses++;
                        console.error(`Error unfreezing license ${license.license_key}:`, error);
                    }
                }
            } else {
                const license = await db.getLicense(licenseValue);
                if (!license) {
                    return interaction.editReply({ content: "No license found with the provided key." });
                }

                await db.unfreezeLicense(license.license_key);
                processedLicenses++;

                // Logging action
                await db.logAdminAction(
                    interaction.user.id,
                    interaction.user.tag,
                    'UNFREEZE',
                    license.license_key,
                    `Inform customers: ${informValue}`
                );

                // Sending DM to user if requested
                if (informValue === 'yes' && license.linked_discord_id) {
                    try {
                        const user = await client.users.fetch(license.linked_discord_id);
                        const embed = new EmbedBuilder()
                            .setTitle('☀️ License Unfrozen')
                            .setColor('Green')
                            .setDescription(`Your license **${license.license_key}** has been unfrozen.\n\nYour license duration will now continue to decrease normally.`)
                            .setTimestamp();
                        await user.send({ embeds: [embed] });
                    } catch (dmError) {
                        console.log(`Cannot send DM to user ${license.linked_discord_id}`);
                    }
                }
            }

            // Log to #key (+ #all-logs)
            {
                const logEmbed = new EmbedBuilder()
                    .setTitle('☀️ License Unfreeze')
                    .setColor('Green')
                    .addFields(
                        { name: 'Admin', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
                        { name: 'Target', value: licenseValue, inline: true },
                        { name: 'Processed', value: `${processedLicenses} licenses`, inline: true },
                        { name: 'Failed', value: `${failedLicenses} licenses`, inline: true },
                        { name: 'Notify Customers', value: informValue === 'yes' ? 'Yes' : 'No', inline: true }
                    )
                    .setTimestamp();
                await sendLog('key', { embeds: [logEmbed] });
            }

            await interaction.editReply({ 
                content: `Successfully unfrozen ${processedLicenses} licenses.${failedLicenses > 0 ? ` ${failedLicenses} licenses failed to unfreeze.` : ''}` 
            });

        } catch (error) {
            console.error('Error in unfreeze modal:', error);
            await interaction.editReply({ content: "An error occurred while unfreezing licenses." });
        }
    }

    if (interaction.customId === 'addtime_modal') {
        const licenseValue = interaction.fields.getTextInputValue('license_input');
        const timeValue = interaction.fields.getTextInputValue('time_input');
        const informValue = interaction.fields.getTextInputValue('inform_input').toLowerCase();

        const timeToAdd = parseDuration(timeValue);
        if (!timeToAdd) {
            return interaction.editReply({ content: "Invalid time format. Use 'd', 'm' or 'y'." });
        }

        const timeToAddMs = timeToAdd.getTime() - new Date().getTime();
        let processedLicenses = 0;
        let failedLicenses = 0;

        try {
            let licensesToProcess = [];

            if (licenseValue.toLowerCase() === 'all') {
                licensesToProcess = await db.getActiveLicenses();
            } else if (licenseValue.toLowerCase() === 'freezed') {
                licensesToProcess = await db.getFrozenLicenses();
            } else {
                const license = await db.getLicense(licenseValue);
                if (!license) {
                    return interaction.editReply({ content: "No license found with the provided key." });
                }
                licensesToProcess = [license];
            }

            for (const license of licensesToProcess) {
                try {
                    await db.addTimeToLicense(license.license_key, timeToAddMs);
                    processedLicenses++;

                    // Logging action
                    await db.logAdminAction(
                        interaction.user.id,
                        interaction.user.tag,
                        'ADDTIME',
                        license.license_key,
                        `Time added: ${timeValue}, Inform customers: ${informValue}`
                    );

                    // Sending DM to user if requested
                    if (informValue === 'yes' && license.linked_discord_id) {
                        try {
                            const user = await client.users.fetch(license.linked_discord_id);
                            const embed = new EmbedBuilder()
                                .setTitle('⏰ Time Added to License')
                                .setColor('Gold')
                                .setDescription(`**${timeValue}** has been added to your license **${license.license_key}**.\n\nYour new expiration date: <t:${Math.floor((new Date(license.expires_at).getTime() + timeToAddMs) / 1000)}:F>`)
                                .setTimestamp();
                            await user.send({ embeds: [embed] });
                        } catch (dmError) {
                            console.log(`Cannot send DM to user ${license.linked_discord_id}`);
                        }
                    }
                } catch (error) {
                    failedLicenses++;
                    console.error(`Error adding time to license ${license.license_key}:`, error);
                }
            }

            // Log to #key (+ #all-logs)
            {
                const logEmbed = new EmbedBuilder()
                    .setTitle('⏰ Time Added to Licenses')
                    .setColor('Gold')
                    .addFields(
                        { name: 'Admin', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
                        { name: 'Target', value: licenseValue, inline: true },
                        { name: 'Time Added', value: timeValue, inline: true },
                        { name: 'Processed', value: `${processedLicenses} licenses`, inline: true },
                        { name: 'Failed', value: `${failedLicenses} licenses`, inline: true },
                        { name: 'Notify Customers', value: informValue === 'yes' ? 'Yes' : 'No', inline: true }
                    )
                    .setTimestamp();
                await sendLog('key', { embeds: [logEmbed] });
            }

            await interaction.editReply({ 
                content: `Successfully added time to ${processedLicenses} licenses.${failedLicenses > 0 ? ` ${failedLicenses} licenses failed to update.` : ''}` 
            });

        } catch (error) {
            console.error('Error in addtime modal:', error);
            await interaction.editReply({ content: "An error occurred while adding time to licenses." });
        }
    }
}

async function sendResetLog(type, interaction, license, data) {
    const ownerId = type === 'discord' ? data.oldDiscordId : license.linked_discord_id;
    let owner = null;
    let ownerMember = null;
    
    if (ownerId) {
        try {
            owner = await client.users.fetch(ownerId);
            ownerMember = await interaction.guild.members.fetch(ownerId);
        } catch (e) { }
    }

    const embed = new EmbedBuilder().setColor(type === 'hwid' ? "Orange" : "Aqua");
    const duration = license.expires_at ? `<t:${Math.floor(new Date(license.expires_at).getTime() / 1000)}:R>` : 'Permanent';

    if (type === 'hwid') {
        embed.setTitle("HWID Reset!").addFields(
            { name: "- Key Information:", value: `> License key: ||${license.license_key}||\n> Old HWID: ||${data.oldHwid || 'None'}||\n> Product: **${license.product}**\n> Duration: ${duration}\n> Key generated by: <@${license.created_by_id}>` },
            { name: "- Owner Information", value: `> Discord ID: **${ownerId || 'None'}**\n> Discord Name: **${owner ? owner.tag : 'Unknown'}**\n> Account Created: ${owner ? `<t:${Math.floor(owner.createdTimestamp / 1000)}:F>` : 'Unknown'}\n> Joined to the Server: ${ownerMember ? `<t:${Math.floor(ownerMember.joinedTimestamp / 1000)}:F>` : 'Unknown'}` }
        );
    } else {
        embed.setTitle("Discord Reset!").addFields(
            { name: "- Key Information:", value: `> License key: ||${license.license_key}||\n> HWID: ||${license.linked_hwid || 'None'}||\n> Product: **${license.product}**\n> Duration: ${duration}\n> Key generated by: <@${license.created_by_id}>`},
            { name: "- Owner Information", value: `> Old Discord ID: **${data.oldDiscordId || 'None'}**\n> Old Discord Name: **${owner ? owner.tag : 'Unknown'}**\n> Account Created: ${owner ? `<t:${Math.floor(owner.createdTimestamp / 1000)}:F>` : 'Unknown'}\n> Joined to the Server: ${ownerMember ? `<t:${Math.floor(ownerMember.joinedTimestamp / 1000)}:F>` : 'Unknown'}` }
        );
    }

    if (data.admin) {
        embed.setFooter({ text: `Reset performed by admin: ${data.admin.tag}`, iconURL: data.admin.displayAvatarURL() });
    }

    await sendLog('user', { embeds: [embed] });
}

// =================================
//
// API Initialization
//
// =================================
//
const app = express();
app.use(express.json());

// Health-Check fuer Uptime-Monitore (haelt Render-Free wach).
app.get('/api/health', (req, res) => {
    res.json({
        status: "ok",
        bot: client.user ? client.user.tag : "starting",
        uptime_ms: Date.now() - bootTime,
        guilds: client.guilds.cache.size
    });
});

app.post('/api/start-session', async (req, res) => {
    const { licenseKey, discordId, ipAddress } = req.body;
    
    if (!licenseKey || !discordId) {
        return res.status(400).json({ status: "error", message: "Missing required data." });
    }

    try {
        const license = await db.getLicense(licenseKey);
        if (!license) {
            return res.status(404).json({ status: "error", message: "License not found." });
        }

        // Check if license is frozen
        const now = new Date();
        if (license.frozen_until && new Date(license.frozen_until) > now) {
            // License is frozen - treat as active
        } else if (license.expires_at && new Date(license.expires_at) < now) {
            return res.status(403).json({ status: "error", message: "Your license has expired." });
        }

        await db.endUserSession(licenseKey);

        let country = 'Unknown';
        if (ipAddress && ipAddress !== '127.0.0.1') {
            country = await getCountryFromIP(ipAddress);
        }

        await db.startUserSession({
            licenseKey,
            discordId,
            ipAddress,
            country
        });

        {
            const embed = new EmbedBuilder().setTitle("🟢 Session Started").setColor("Green")
                .addFields(
                    { name: "User", value: `<@${discordId}> (\`${discordId}\`)`, inline: false },
                    { name: "License Key", value: `||${licenseKey}||`, inline: false },
                    { name: "Details", value: `> Product: **${license.product}**\n> Country: ${country}\n> Date: <t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                );
            await sendLog('login', { embeds: [embed] });
        }

        res.json({ status: "success", message: "Session started." });
    } catch (error) {
        console.error('Error starting session:', error);
        res.status(500).json({ status: "error", message: "Internal server error." });
    }
});

app.post('/api/end-session', async (req, res) => {
    const { licenseKey } = req.body;
    
    if (!licenseKey) {
        return res.status(400).json({ status: "error", message: "Missing license key." });
    }

    try {
        await db.endUserSession(licenseKey);
        res.json({ status: "success", message: "Session ended." });
    } catch (error) {
        console.error('Error ending session:', error);
        res.status(500).json({ status: "error", message: "Internal server error." });
    }
});

app.post('/api/login', async (req, res) => {
    const { licenseKey, hwid } = req.body;
    if (!licenseKey || !hwid) return res.status(400).json({ status: "error", message: "Missing license key or HWID." });

    const license = await db.getLicense(licenseKey);
    if (!license) return res.status(403).json({ status: "error", message: "Invalid license key." });

    // Check if license is frozen
    const now = new Date();
    if (license.frozen_until && new Date(license.frozen_until) > now) {
        // License is frozen - treat as active
    } else if (license.expires_at && new Date(license.expires_at) < now) {
        return res.status(403).json({ status: "error", message: "Your license has expired." });
    }

    if (!license.linked_hwid) {
        return res.json({ status: "success", action: "verify_discord" });
    }

    if (license.linked_hwid !== hwid) {
        return res.status(403).json({ status: "error", message: "HWID does not match the one assigned to the key." });
    }

    await db.updateLicense(licenseKey, { last_login: new Date() });

    const user = await client.users.fetch(license.linked_discord_id).catch(() => null);
    const discordName = user ? user.username : "Unknown";

    {
        const embed = new EmbedBuilder().setTitle("✅ Successful Login").setColor("Green")
            .addFields(
                { name: "User", value: `<@${license.linked_discord_id || "0"}>\n> Discord Name: **${discordName}**\n> Discord ID: \`${license.linked_discord_id || "N/A"}\`` },
                { name: "License Key Information", value: `> License key: ||${licenseKey}||\n> Product: **${license.product}**\n> Login date: <t:${Math.floor(Date.now() / 1000)}:F>` }
            );
        await sendLog('login', { embeds: [embed] });
    }

    return res.json({ status: "success", action: "login", data: { discord_name: discordName, avatar_url: user ? user.displayAvatarURL({ extension: "png", size: 128 }) : null, discord_id: license.linked_discord_id || null, product: license.product, expires_at: license.expires_at, expires_text: formatExpiry(license.expires_at), plan_label: planOfLicense(license) } });
});

app.post('/api/login-discord', async (req, res) => {
    const { discordId, hwid } = req.body;
    if (!discordId || !hwid) return res.status(400).json({ status: "error", message: "Missing Discord ID or HWID." });

    try {
        const license = await db.getLicenseByHwid(hwid);
        if (!license || String(license.linked_discord_id || '') !== String(discordId)) {
            return res.status(403).json({ status: "error", message: "No license linked to this PC + Discord ID. Register first." });
        }

        const now = new Date();
        if (license.frozen_until && new Date(license.frozen_until) > now) {
            // License is frozen - treat as active
        } else if (license.expires_at && new Date(license.expires_at) < now) {
            return res.status(403).json({ status: "error", message: "Your license has expired." });
        }

        await db.updateLicense(license.license_key, { last_login: new Date() });

        const user = await client.users.fetch(license.linked_discord_id).catch(() => null);
        const discordName = user ? (user.globalName || user.username) : "Unknown";

        {
            const embed = new EmbedBuilder().setTitle("✅ Successful Login").setColor("Green")
                .addFields(
                    { name: "User", value: `<@${license.linked_discord_id || "0"}>\n> Discord Name: **${discordName}**\n> Discord ID: \`${license.linked_discord_id || "N/A"}\`` },
                    { name: "License Key Information", value: `> License key: ||${license.license_key}||\n> Product: **${license.product}**\n> Login date: <t:${Math.floor(Date.now() / 1000)}:F>\n> Via: Discord-only login` }
                );
            await sendLog('login', { embeds: [embed] });
        }

        return res.json({ status: "success", action: "login", data: { discord_name: discordName, avatar_url: user ? user.displayAvatarURL({ extension: "png", size: 128 }) : null, discord_id: license.linked_discord_id || null, product: license.product, expires_at: license.expires_at, expires_text: formatExpiry(license.expires_at), plan_label: planOfLicense(license) } });
    } catch (error) {
        console.error('Error in discord login:', error);
        return res.status(500).json({ status: "error", message: "Internal server error." });
    }
});

app.post('/api/request-verification', async (req, res) => {
    const { licenseKey, discordId } = req.body;
    if (!licenseKey || !discordId) return res.status(400).json({ status: "error", message: "Missing key or Discord ID." });

    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) return res.status(404).json({ status: "error", message: "No Discord user found with the provided ID." });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 5 * 60 * 1000);
    await db.updateLicense(licenseKey, { verification_code: code, verification_expires: expires });

    try {
        await user.send(`Your verification code is: **${code}**\nThe code is valid for 5 minutes.`);
        res.json({ status: "success", message: "Verification code sent." });
    } catch (error) {
        res.status(500).json({ status: "error", message: "Cannot send DM. Make sure you have DMs from strangers enabled." });
    }
});

app.post('/api/submit-verification', async (req, res) => {
    const { licenseKey, code, hwid, deviceInfo } = req.body;
    if (!licenseKey || !code || !hwid || !deviceInfo) return res.status(400).json({ status: "error", message: "Missing all required data." });

    const license = await db.getLicense(licenseKey);
    if (!license) return res.status(404).json({ status: "error", message: "Invalid key." });
    if (license.verification_code !== code) return res.status(403).json({ status: "error", message: "Invalid verification code." });
    if (new Date(license.verification_expires) < new Date()) return res.status(403).json({ status: "error", message: "Verification code has expired." });

    await db.updateLicense(licenseKey, {
        linked_hwid: hwid,
        linked_discord_id: deviceInfo.discordId,
        last_login: new Date(),
        verification_code: null,
        verification_expires: null
    });

const embed = new EmbedBuilder().setTitle("Login").setColor("Purple")
        .addFields(
            { name: "Computer Info", value: `> Device Name: **${deviceInfo.deviceName}**\n> Windows Version: **${deviceInfo.windowsVersion}**\n> HWID: ||${hwid}||`},
            { name: "License Key Information", value: `> License key: ||${license.license_key}||\n> Key created by: <@${license.created_by_id}> (${license.created_by_tag})\n> Login date: <t:${Math.floor(new Date().getTime() / 1000)}:F>\n> Key duration: ${license.expires_at ? `<t:${Math.floor(new Date(license.expires_at).getTime() / 1000)}:F>` : 'Permanent'}`}
        );

    await sendLog('login', { embeds: [embed] });

    const user = await client.users.fetch(deviceInfo.discordId).catch(() => null);
    return res.json({ status: "success", action: "login", data: { discord_name: user ? user.username : "Unknown", avatar_url: user ? user.displayAvatarURL({ extension: "png", size: 128 }) : null, discord_id: deviceInfo.discordId, product: license.product, expires_at: license.expires_at, expires_text: formatExpiry(license.expires_at), plan_label: planOfLicense(license) } });
});

app.post('/api/inject', async (req, res) => {
    const { discordId, hwid } = req.body;
    if (!discordId || !hwid) return res.status(400).json({ status: "error", message: "Missing Discord ID or HWID." });

    try {
        const license = await db.getLicenseByHwid(hwid);
        if (!license || String(license.linked_discord_id || '') !== String(discordId)) {
            return res.status(403).json({ status: "error", message: "No license linked to this PC + Discord ID." });
        }

        const now = new Date();
        if (license.frozen_until && new Date(license.frozen_until) > now) {
            // License is frozen - treat as active
        } else if (license.expires_at && new Date(license.expires_at) < now) {
            return res.status(403).json({ status: "error", message: "Your license has expired." });
        }

        await db.updateLicense(license.license_key, { last_inject: new Date() });

        {
            const embed = new EmbedBuilder().setTitle("💉 Inject").setColor("Purple")
                .addFields(
                    { name: "User", value: `<@${license.linked_discord_id}> (\`${license.linked_discord_id}\`)`, inline: false },
                    { name: "License Key", value: `||${license.license_key}||`, inline: false },
                    { name: "Details", value: `> Product: **${license.product}** (${planOfLicense(license)})\n> Inject date: <t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                );
            await sendLog('inject', { embeds: [embed] });
        }

        return res.json({ status: "success", message: "Inject logged." });
    } catch (error) {
        console.error('Error in inject log:', error);
        return res.status(500).json({ status: "error", message: "Internal server error." });
    }
});

app.post('/api/log-failed-login', async (req, res) => {
    const { licenseKey, reason, discordId } = req.body;
    if (!licenseKey) return res.status(400).json({ status: "error", message: "Missing licenseKey." });

    const license = await db.getLicense(licenseKey);

    let resolvedDiscordId = discordId;
    if (!resolvedDiscordId && license && license.linked_discord_id) {
        resolvedDiscordId = license.linked_discord_id;
    }

    let discordName = null;
    if (resolvedDiscordId) {
        const user = await client.users.fetch(resolvedDiscordId).catch(() => null);
        discordName = user ? user.username : null;
    }

    {
        let discordField;
        if (resolvedDiscordId) {
            discordField = `<@${resolvedDiscordId}>\n> Discord Name: **${discordName || "Unknown"}**\n> Discord ID: \`${resolvedDiscordId}\``;
        } else if (license) {
            discordField = 'Not linked to a Discord account yet';
        } else {
            discordField = 'Unknown (invalid key)';
        }
        const embed = new EmbedBuilder().setTitle("⚠️ Failed Login Attempt").setColor("Red")
            .addFields(
                { name: "License Key Information", value: `> License key: ||${licenseKey}||\n> Reason: ${reason || "Unknown"}` },
                { name: "Discord", value: discordField },
                { name: "Details", value: `> Date: <t:${Math.floor(Date.now() / 1000)}:F>` }
            );
        await sendLog('login', { embeds: [embed] });
    }
    res.json({ status: "success" });
});

// Chat + Party API for the cheat menu (presence, global/party chat, parties).
require('./chat_party.js')({ app, db, client, config, planOfLicense, formatExpiry });

// Config Cloud (Sicherung der Cheat-Einstellungen in der DB, statt separatem Server).
require('./config_cloud.js')({ app, db, loginCodes: cloudLoginCodes });

// Client attestation: nonce/challenge + HMAC proof, bound to HWID and license.
require('./attestation.js')({ app, db });

const listenPort = process.env.PORT ? Number(process.env.PORT) : config.apiPort;
app.listen(listenPort, '0.0.0.0', () => {
    console.log(`[API] Server listening on 0.0.0.0:${listenPort}`);
});

let isLoggingIn = false;
async function startBot() {
    console.log('[BOT] Starting bot login process...');
    console.log('[BOT] Token present:', !!botToken);
    console.log('[BOT] Token length:', botToken ? botToken.length : 0);
    while (true) {
        try {
            console.log('[BOT] Attempting to login to Discord...');
            await client.login(botToken);
            console.log('[BOT] Login call returned - waiting for ready event');
            break;
        } catch (err) {
            console.error('[BOT] Login failed, retrying in 15s:', err && err.message ? err.message : err);
            await new Promise(r => setTimeout(r, 15000));
        }
    }
}
startBot();