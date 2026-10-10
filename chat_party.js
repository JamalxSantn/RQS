// =================================
// Chat + Party API for the cheat menu
// =================================
//
// Live data source for the in-menu PARTY/Chat page:
//   - online users (+ roles OWNER / CO-OWNER / DEVELOPER, resolved from
//     Discord guild roles of the linked Discord account)
//   - global chat + per-party chat (real send/receive, polling)
//   - party create / join with 4-digit code
//
// Identity chain: cheat hwid -> licenses.linked_hwid -> linked_discord_id
//   -> Discord user (name/handle) + guild member roles (chat role label).
//
// Mounted from index.js:
//   require('./chat_party.js')({ app, db, client, config, planOfLicense, formatExpiry });

const ROLE_OWNER = 'OWNER';
const ROLE_CO_OWNER = 'CO-OWNER';
const ROLE_DEVELOPER = 'DEVELOPER';

const HEARTBEAT_TTL_MS = 60 * 1000;
const IDENTITY_CACHE_TTL_MS = 5 * 60 * 1000;
const PARTY_MEMBER_TTL_MS = 3 * 60 * 1000;
const MAX_TEXT_LEN = 500;
const MAX_MESSAGES = 100;
// Idempotency: same user + scope + text within this window is treated as a
// duplicate submit (double-click / retried request) and answered from cache
// without storing or logging it again.
const SEND_DEDUP_MS = 2000;
const CREATE_DEDUP_MS = 5000;
const sendDedup = new Map(); // key -> { text, ts, message }

// In-memory state (authoritative for chat/parties; presence merges heartbeats + license sessions)
const heartbeats = new Map();   // hwid -> { lastSeen, identity }
const identityCache = new Map(); // hwid -> { at, identity }
const globalMessages = [];
let nextGlobalId = 1;
const parties = new Map();      // code -> { code, created, nextId, messages: [], members: Map(hwid -> { lastSeen }) }
const hwidParty = new Map();    // hwid -> code

function roleRank(role) {
    if (role === ROLE_OWNER) return 0;
    if (role === ROLE_CO_OWNER) return 1;
    if (role === ROLE_DEVELOPER) return 2;
    return 3;
}

function normList(v) {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.map((x) => String(x).toLowerCase());
}

function normRoleLabel(v) {
    const s = String(v == null ? '' : v).toUpperCase().replace(/[\s_-]+/g, '');
    if (s === 'OWNER') return 'OWNER';
    if (s === 'COOWNER') return 'CO-OWNER';
    if (s === 'DEVELOPER' || s === 'DEV') return 'DEVELOPER';
    return '';
}

// Per-user override from config.json:
//   "chatUsers": { "<discord id or username>": "OWNER" | "CO-OWNER" | "DEVELOPER" }
// Checked before guild-role mapping, so team members always show the right
// label even without (or with different) Discord roles.
function lookupChatUserOverride(chatUsers, info) {
    if (!chatUsers || typeof chatUsers !== 'object') return '';
    const candidates = [];
    if (info.discordId) candidates.push(String(info.discordId));
    if (info.username) candidates.push(String(info.username).toLowerCase());
    if (info.displayName) candidates.push(String(info.displayName).toLowerCase());
    for (const key of Object.keys(chatUsers)) {
        const role = normRoleLabel(chatUsers[key]);
        if (!role) continue;
        const want = String(key).toLowerCase();
        if (candidates.includes(key) || candidates.includes(want)) return role;
    }
    return '';
}

// Map a guild member to a chat role label. Configurable via config.json:
//   "chatRoles": { "owner": [<role id or name>, ...], "coowner": [...], "developer": [...] }
// Falls back to matching role names containing owner / co-owner / developer.
function resolveChatRole(member, chatRoles) {
    if (!member) return '';
    const roleNames = [];
    const roleIds = new Set();
    try {
        for (const r of member.roles.cache.values()) {
            roleNames.push(String(r.name || ''));
            roleIds.add(String(r.id));
        }
    } catch (e) {
        return '';
    }
    const lowerNames = roleNames.map((n) => n.toLowerCase());

    const matches = (list) => {
        for (const wantRaw of normList(list)) {
            const want = wantRaw.toLowerCase();
            if (roleIds.has(String(want))) return true;
            for (const n of lowerNames) {
                if (n === want || n.includes(want)) return true;
            }
        }
        return false;
    };

    if (chatRoles) {
        if (matches(chatRoles.owner)) return ROLE_OWNER;
        if (matches(chatRoles.coowner)) return ROLE_CO_OWNER;
        if (matches(chatRoles.developer)) return ROLE_DEVELOPER;
        return '';
    }

    const hasCoOwner = lowerNames.some((n) => n.includes('co-owner') || n.includes('co owner') || n.includes('coowner'));
    const hasOwner = lowerNames.some((n) => n.includes('owner'));
    const hasDev = lowerNames.some((n) => n.includes('developer') || n === 'dev' || n.includes(' dev') || n.includes('dev '));
    if (hasOwner && !hasCoOwner) return ROLE_OWNER;
    if (hasCoOwner) return ROLE_CO_OWNER;
    if (hasDev) return ROLE_DEVELOPER;
    return '';
}

function cleanText(v) {
    let s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim();
    if (s.length > MAX_TEXT_LEN) s = s.slice(0, MAX_TEXT_LEN);
    return s;
}

function makeCode() {
    let code = '';
    do {
        code = String(Math.floor(1000 + Math.random() * 9000));
    } while (parties.has(code));
    return code;
}

const { EmbedBuilder } = require('discord.js');

// Discord channel for the full chat-system log (messages, party create/join/leave).
const CHAT_LOG_CHANNEL_ID = (typeof config !== 'undefined' && config && config.chatLogChannelId)
    || '1552686721538326608';

module.exports = function registerChatParty(deps) {
    const { app, db, client, config, planOfLicense, formatExpiry } = deps;

    function avatarUrlFor(user) {
        try {
            if (user && user.avatar) {
                const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
                return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=64`;
            }
        } catch (e) { /* ignore */ }
        return '';
    }
    const LOG_CHANNEL_ID = (config && config.chatLogChannelId) || CHAT_LOG_CHANNEL_ID;

    async function getLogChannel() {
        try {
            const cached = client.channels.cache.get(LOG_CHANNEL_ID);
            if (cached) return cached;
            return await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        } catch (e) {
            return null;
        }
    }

    // Fire-and-forget: chat must never block on Discord logging.
    function logChat(embed) {
        getLogChannel().then((ch) => {
            if (ch) ch.send({ embeds: [embed] }).catch(() => {});
        }).catch(() => {});
    }

    function userField(identity) {
        const mention = identity.discordId ? `<@${identity.discordId}>` : null;
        const who = `${identity.name} (${identity.handle})${identity.role ? ` [${identity.role}]` : ''}`;
        return mention ? `${mention}\n> ${who}` : `> ${who}`;
    }

    function keyField(licenseKey) {
        return licenseKey ? `||${licenseKey}||` : 'Unknown (no linked license)';
    }

    function timeField(ts) {
        const s = Math.floor((ts || Date.now()) / 1000);
        return `<t:${s}:F>`;
    }

    async function resolveIdentity(hwid) {
        const now = Date.now();
        const cached = identityCache.get(hwid);
        if (cached && now - cached.at < IDENTITY_CACHE_TTL_MS) return cached.identity;

        // No fabricated users: unknown hwids resolve to "Unknown" and are
        // never listed as online users (see touchHeartbeat).
        let identity = { name: 'Unknown', handle: '@unknown', role: '', plan: '', discordId: null, licenseKey: null, avatar: '', expires_text: '' };
        try {
            const license = await db.getLicenseByHwid(hwid);
            if (license && license.linked_discord_id) {
                const user = await client.users.fetch(license.linked_discord_id).catch(() => null);
                const username = user ? user.username : 'Unknown';
                const display = user && user.globalName ? user.globalName : username;
                let role = lookupChatUserOverride(config.chatUsers, {
                    discordId: license.linked_discord_id,
                    username,
                    displayName: display
                });
                if (!role) {
                    try {
                        const guild = client.guilds.cache.get(config.guildId);
                        const member = guild ? await guild.members.fetch(license.linked_discord_id).catch(() => null) : null;
                        role = resolveChatRole(member, config.chatRoles);
                    } catch (e) {
                        role = '';
                    }
                }
                let plan = 'lifetime';
                try {
                    plan = String(planOfLicense ? planOfLicense(license) : 'Lifetime').toLowerCase();
                } catch (e) {
                    plan = 'lifetime';
                }
                identity = {
                    name: display || username,
                    handle: '@' + String(username || 'unknown').toLowerCase(),
                    role,
                    plan,
                    discordId: license.linked_discord_id,
                    licenseKey: license.license_key || null,
                    avatar: avatarUrlFor(user),
                    expires_text: (() => { try { return String(formatExpiry ? formatExpiry(license.expires_at) : 'Lifetime'); } catch (e) { return 'Lifetime'; } })()
                };
            }
        } catch (e) {
            // fall through to cached/default identity
        }

        identityCache.set(hwid, { at: now, identity });
        return identity;
    }

    async function touchHeartbeat(hwid) {
        const identity = await resolveIdentity(hwid);
        // Only track hwids that resolve to a linked license. Unknown hwids
        // must not show up as online users (no fake "op" entries).
        if (identity && identity.discordId) {
            heartbeats.set(hwid, { lastSeen: Date.now(), identity });
        } else {
            heartbeats.delete(hwid);
        }
        return identity;
    }

    // Online users = active license sessions + recent heartbeats, deduped.
    async function collectOnlineUsers() {
        const byKey = new Map();
        try {
            const sessions = await db.getActiveSessions();
            for (const s of sessions) {
                if (!s || !s.discord_id) continue;
                const key = 'discord:' + s.discord_id;
                if (byKey.has(key)) continue;
                let name = 'Unknown';
                let uname = 'unknown';
                let handle = '@unknown';
                let avatar = '';
                try {
                    const user = await client.users.fetch(s.discord_id).catch(() => null);
                    if (user) {
                        uname = String(user.username || 'unknown');
                        name = user.globalName || user.username;
                        handle = '@' + uname.toLowerCase();
                        avatar = avatarUrlFor(user);
                    }
                } catch (e) { /* keep defaults */ }
                let role = lookupChatUserOverride(config.chatUsers, {
                    discordId: s.discord_id,
                    username: uname,
                    displayName: name
                });
                if (!role) {
                    try {
                        const guild = client.guilds.cache.get(config.guildId);
                        const member = guild ? await guild.members.fetch(s.discord_id).catch(() => null) : null;
                        role = resolveChatRole(member, config.chatRoles);
                    } catch (e) { /* keep default */ }
                }
                byKey.set(key, { name, handle, role, online: true, avatar });
            }
        } catch (e) { /* sessions unavailable -> heartbeats only */ }

        const now = Date.now();
        for (const [hwid, hb] of heartbeats) {
            if (now - hb.lastSeen > HEARTBEAT_TTL_MS) continue;
            const id = hb.identity || { name: 'op', handle: '@op', role: '' };
            const key = id.discordId ? 'discord:' + id.discordId : 'hwid:' + hwid;
            if (!byKey.has(key)) {
                byKey.set(key, { name: id.name, handle: id.handle, role: id.role, online: true });
            }
        }

        const users = Array.from(byKey.values());
        users.sort((a, b) => {
            const r = roleRank(a.role) - roleRank(b.role);
            if (r !== 0) return r;
            return String(a.name).localeCompare(String(b.name));
        });
        return users;
    }

    function partyMembers(party) {
        const out = [];
        const now = Date.now();
        for (const [hwid] of party.members) {
            const hb = heartbeats.get(hwid);
            const id = hb && now - hb.lastSeen <= HEARTBEAT_TTL_MS
                ? hb.identity
                : (identityCache.get(hwid) || {}).identity || { name: 'Unknown', handle: '@unknown', role: '' };
            out.push({ name: id.name, handle: id.handle, role: id.role, online: !!(hb && now - hb.lastSeen <= HEARTBEAT_TTL_MS) });
        }
        out.sort((a, b) => {
            const r = roleRank(a.role) - roleRank(b.role);
            if (r !== 0) return r;
            return String(a.name).localeCompare(String(b.name));
        });
        return out;
    }

    function leaveParty(hwid, logIt) {
        const code = hwidParty.get(hwid);
        if (!code) return;
        const party = parties.get(code);
        if (party) {
            party.members.delete(hwid);
            if (party.members.size === 0) parties.delete(code);
        }
        hwidParty.delete(hwid);
        if (logIt) {
            resolveIdentity(hwid).then((self) => {
                logChat(new EmbedBuilder().setTitle('⬅️ Party Leave').setColor('Orange')
                    .addFields(
                        { name: 'User', value: userField(self) },
                        { name: 'License Key', value: keyField(self.licenseKey) },
                        { name: 'Party Code', value: `> \`${code}\`` },
                        { name: 'Time', value: `> ${timeField(Date.now())}` }
                    ));
            }).catch(() => {});
        }
    }

    // ---- background pruning (stale heartbeats / members / empty parties) ----
    setInterval(() => {
        const now = Date.now();
        for (const [hwid, hb] of heartbeats) {
            if (now - hb.lastSeen > HEARTBEAT_TTL_MS) heartbeats.delete(hwid);
        }
        for (const [code, party] of parties) {
            for (const [hwid, m] of party.members) {
                if (now - m.lastSeen > PARTY_MEMBER_TTL_MS) {
                    party.members.delete(hwid);
                    if (hwidParty.get(hwid) === code) hwidParty.delete(hwid);
                }
            }
            if (party.members.size === 0) parties.delete(code);
        }
    }, 30000).unref();

    // ---- POST /api/client/presence { hwid } ----
    app.post('/api/client/presence', async (req, res) => {
        const { hwid } = req.body || {};
        if (!hwid || typeof hwid !== 'string') {
            return res.status(400).json({ ok: false, error: 'missing_hwid' });
        }
        try {
            const self = await touchHeartbeat(hwid);
            const users = await collectOnlineUsers();
            return res.json({ ok: true, server_time: Date.now(), self, users });
        } catch (e) {
            console.error('presence error:', e);
            return res.status(500).json({ ok: false, error: 'internal' });
        }
    });

    // ---- POST /api/client/chat/send { hwid, scope, text, party_code? } ----
    app.post('/api/client/chat/send', async (req, res) => {
        const { hwid, scope, text, party_code } = req.body || {};
        if (!hwid || typeof hwid !== 'string') {
            return res.status(400).json({ ok: false, error: 'missing_hwid' });
        }
        const clean = cleanText(text);
        if (!clean) {
            return res.status(400).json({ ok: false, error: 'empty_text' });
        }
        try {
            const self = await touchHeartbeat(hwid);
            const ts = Date.now();
            const isPartyScope = scope === 'party';
            const scopeCode = isPartyScope ? String(party_code || hwidParty.get(hwid) || '') : '';
            const dedupKey = hwid + '|' + (isPartyScope ? 'party:' + scopeCode : 'global');
            const prev = sendDedup.get(dedupKey);
            if (prev && prev.text === clean && ts - prev.ts < SEND_DEDUP_MS) {
                return res.json({ ok: true, message: prev.message, duplicate: true });
            }
            if (isPartyScope) {
                const code = scopeCode;
                const party = parties.get(code);
                if (!party || !party.members.has(hwid)) {
                    return res.status(403).json({ ok: false, error: 'not_in_party' });
                }
                party.members.get(hwid).lastSeen = ts;
                const msg = { id: party.nextId++, name: self.name, handle: self.handle, role: self.role, text: clean, ts };
                party.messages.push(msg);
                while (party.messages.length > MAX_MESSAGES) party.messages.shift();
                logChat(new EmbedBuilder().setTitle('💬 Party Chat Message').setColor('Blue')
                    .addFields(
                        { name: 'User', value: userField(self) },
                        { name: 'License Key', value: keyField(self.licenseKey) },
                        { name: 'Party Code', value: `> \`${code}\`` },
                        { name: 'Message', value: `> ${clean.slice(0, 1000)}` },
                        { name: 'Time', value: `> ${timeField(ts)}` }
                    ));
                sendDedup.set(dedupKey, { text: clean, ts, message: msg });
                return res.json({ ok: true, message: msg });
            }
            const msg = { id: nextGlobalId++, name: self.name, handle: self.handle, role: self.role, text: clean, ts };
            globalMessages.push(msg);
            while (globalMessages.length > MAX_MESSAGES) globalMessages.shift();
            logChat(new EmbedBuilder().setTitle('💬 Global Chat Message').setColor('Green')
                .addFields(
                    { name: 'User', value: userField(self) },
                    { name: 'License Key', value: keyField(self.licenseKey) },
                    { name: 'Message', value: `> ${clean.slice(0, 1000)}` },
                    { name: 'Time', value: `> ${timeField(ts)}` }
                ));
            sendDedup.set(dedupKey, { text: clean, ts, message: msg });
            return res.json({ ok: true, message: msg });
        } catch (e) {
            console.error('chat/send error:', e);
            return res.status(500).json({ ok: false, error: 'internal' });
        }
    });

    // ---- POST /api/client/chat/poll { hwid, scope, party_code?, since_id? } ----
    app.post('/api/client/chat/poll', async (req, res) => {
        const { hwid, scope, party_code, since_id } = req.body || {};
        if (!hwid || typeof hwid !== 'string') {
            return res.status(400).json({ ok: false, error: 'missing_hwid' });
        }
        const since = Number(since_id) || 0;
        try {
            await touchHeartbeat(hwid);
            if (scope === 'party') {
                const code = String(party_code || hwidParty.get(hwid) || '');
                const party = parties.get(code);
                if (!party || !party.members.has(hwid)) {
                    return res.json({ ok: true, messages: [], party: null });
                }
                party.members.get(hwid).lastSeen = Date.now();
                return res.json({
                    ok: true,
                    messages: party.messages.filter((m) => m.id > since),
                    party: { code, members: partyMembers(party) }
                });
            }
            return res.json({ ok: true, messages: globalMessages.filter((m) => m.id > since), party: null });
        } catch (e) {
            console.error('chat/poll error:', e);
            return res.status(500).json({ ok: false, error: 'internal' });
        }
    });

    // ---- POST /api/client/party/create { hwid } ----
    app.post('/api/client/party/create', async (req, res) => {
        const { hwid } = req.body || {};
        if (!hwid || typeof hwid !== 'string') {
            return res.status(400).json({ ok: false, error: 'missing_hwid' });
        }
        try {
            const self = await touchHeartbeat(hwid);
            // Idempotent create: a second tap within a few seconds returns the
            // existing party instead of spawning (and logging) another one.
            const existingCode = hwidParty.get(hwid);
            const existing = existingCode ? parties.get(existingCode) : null;
            if (existing && Date.now() - existing.created < CREATE_DEDUP_MS) {
                return res.json({ ok: true, code: existingCode, members: partyMembers(existing), duplicate: true });
            }
            leaveParty(hwid);
            const code = makeCode();
            const party = { code, created: Date.now(), nextId: 1, messages: [], members: new Map() };
            party.members.set(hwid, { lastSeen: Date.now() });
            parties.set(code, party);
            hwidParty.set(hwid, code);
            logChat(new EmbedBuilder().setTitle('🎉 Party Created').setColor('Purple')
                .addFields(
                    { name: 'User', value: userField(self) },
                    { name: 'License Key', value: keyField(self.licenseKey) },
                    { name: 'Party Code', value: `> \`${code}\`` },
                    { name: 'Time', value: `> ${timeField(Date.now())}` }
                ));
            return res.json({ ok: true, code, members: partyMembers(party) });
        } catch (e) {
            console.error('party/create error:', e);
            return res.status(500).json({ ok: false, error: 'internal' });
        }
    });

    // ---- POST /api/client/party/join { hwid, code } ----
    app.post('/api/client/party/join', async (req, res) => {
        const { hwid, code } = req.body || {};
        if (!hwid || typeof hwid !== 'string') {
            return res.status(400).json({ ok: false, error: 'missing_hwid' });
        }
        const cleanCode = String(code || '').replace(/\D/g, '').slice(0, 4);
        const party = parties.get(cleanCode);
        if (!party) {
            return res.status(404).json({ ok: false, error: 'invalid_code' });
        }
        try {
            const self = await touchHeartbeat(hwid);
            leaveParty(hwid);
            party.members.set(hwid, { lastSeen: Date.now() });
            hwidParty.set(hwid, cleanCode);
            logChat(new EmbedBuilder().setTitle('➡️ Party Join').setColor('Green')
                .addFields(
                    { name: 'User', value: userField(self) },
                    { name: 'License Key', value: keyField(self.licenseKey) },
                    { name: 'Party Code', value: `> \`${cleanCode}\`` },
                    { name: 'Time', value: `> ${timeField(Date.now())}` }
                ));
            return res.json({ ok: true, code: cleanCode, members: partyMembers(party) });
        } catch (e) {
            console.error('party/join error:', e);
            return res.status(500).json({ ok: false, error: 'internal' });
        }
    });

    // ---- POST /api/client/party/leave { hwid } ----
    app.post('/api/client/party/leave', async (req, res) => {
        const { hwid } = req.body || {};
        if (!hwid || typeof hwid !== 'string') {
            return res.status(400).json({ ok: false, error: 'missing_hwid' });
        }
        try {
            await touchHeartbeat(hwid);
            leaveParty(hwid, true);
            return res.json({ ok: true });
        } catch (e) {
            console.error('party/leave error:', e);
            return res.status(500).json({ ok: false, error: 'internal' });
        }
    });

    console.log('Chat + Party API mounted (/api/client/presence, /api/client/chat/*, /api/client/party/*)');
};
