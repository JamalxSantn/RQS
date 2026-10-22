'use strict';

// =================================
// Server attestation (anti-patch / anti-debug handshake)
// =================================
//
// Mounted from index.js:
//   require('./attestation.js')({ app, db });
//
// Endpoints used by FrameWork/Security/Attestation.hpp:
//   POST /attest/challenge { hwid }
//        -> { success, nonce, expires }
//   POST /attest/verify    { hwid, nonce, proof, integrity, debug, version }
//        -> { success, token, expires }  or  { success:false, stop, reason }
//
// The client signs:  nonce|hwid|integrity|debug|version   with HMAC-SHA256.
// If db is passed, a linked license is checked; expired/frozen licenses stop
// the client immediately. Unlinked HWIDs are allowed through (the loader
// already gates access), so a different HWID format cannot brick the cheat.
//
// Env:
//   ATTEST_SECRET    shared secret (must match ClientSecret() in Attestation.hpp)
//   ATTEST_VERSIONS  comma separated allowed client versions (default 1.0.0)
//   ATTEST_REVOKED   comma separated HWIDs that are refused with stop:true
//   ATTEST_EXPECTED_INTEGRITY  optional "version:digest" pairs (digest decimal,
//                    use * for all versions); when set, a different digest is
//                    treated as a patched client and stopped
//   ATTEST_ALLOW_DEBUG=1  do not stop when the client reports a debugger
//
// Optional: app.locals.attestation.authenticate can protect other routes and
// app.locals.attestation.revoke(hwid) adds a runtime ban.

const crypto = require('crypto');

const DEFAULT_SECRET = 'af8affc6172898f1e9f24118e4fc8ee0c127e55fd42cb41db622aaeb98936779';
const DEFAULT_VERSION = '1.0.0';

const CHALLENGE_TTL_MS = 30 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;

function timingSafeHexEqual(a, b) {
    try {
        const left = Buffer.from(String(a), 'hex');
        const right = Buffer.from(String(b), 'hex');
        if (left.length === 0 || left.length !== right.length) return false;
        return crypto.timingSafeEqual(left, right);
    } catch {
        return false;
    }
}

function safeHwid(value) {
    if (typeof value !== 'string') return '';
    const hwid = value.trim().toUpperCase();
    return /^[A-Z0-9_\-]{3,64}$/.test(hwid) ? hwid : '';
}

function listFromEnv(name) {
    return String(process.env[name] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

module.exports = function registerAttestation({ app, db }) {
    if (!app) throw new Error('attestation: app is required');

    const secret = process.env.ATTEST_SECRET || DEFAULT_SECRET;
    const versions = new Set(listFromEnv('ATTEST_VERSIONS').length ? listFromEnv('ATTEST_VERSIONS') : [DEFAULT_VERSION]);
    const revoked = new Set(listFromEnv('ATTEST_REVOKED').map((h) => h.toUpperCase()));
    const stopOnDebug = process.env.ATTEST_ALLOW_DEBUG !== '1';

    const expectedIntegrity = new Map();
    for (const entry of listFromEnv('ATTEST_EXPECTED_INTEGRITY')) {
        const separator = entry.lastIndexOf(':');
        if (separator <= 0) continue;
        const version = entry.slice(0, separator).trim() || '*';
        const digest = entry.slice(separator + 1).trim();
        if (/^[0-9]{1,20}$/.test(digest)) expectedIntegrity.set(version, digest);
    }

    const challenges = new Map(); // hwid -> { nonce, expires }
    const sessions = new Map();   // token -> { hwid, version, integrity, expires }
    const integrity = new Map();  // `${hwid}:${version}` -> digest

    function prune(now) {
        for (const [key, value] of challenges) if (value.expires <= now) challenges.delete(key);
        for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
    }

    function reject(res, status, reason, stop = false) {
        return res.status(status).json({ success: false, stop, reason });
    }

    async function checkLicense(hwid) {
        if (!db || typeof db.getLicenseByHwid !== 'function') {
            return { ok: true, license: null };
        }

        try {
            const license = await db.getLicenseByHwid(hwid);
            if (!license) return { ok: true, license: null }; // not linked -> allowed

            const now = new Date();
            const frozen = license.frozen_until && new Date(license.frozen_until) > now;
            if (!frozen && license.expires_at && new Date(license.expires_at) < now) {
                return { ok: false, reason: 'expired', stop: true };
            }

            return { ok: true, license };
        } catch (e) {
            console.error('[ATTEST] license lookup failed:', e.message);
            return { ok: true, license: null }; // DB hiccup must not kill clients
        }
    }

    app.post('/attest/challenge', async (req, res) => {
        try {
            const now = Date.now();
            const hwid = safeHwid((req.body || {}).hwid);
            if (!hwid) return reject(res, 400, 'bad-hwid');
            if (revoked.has(hwid)) return reject(res, 403, 'revoked', true);

            const license = await checkLicense(hwid);
            if (!license.ok) return reject(res, 403, license.reason, !!license.stop);

            prune(now);

            const nonce = crypto.randomBytes(16).toString('hex');
            challenges.set(hwid, { nonce, expires: now + CHALLENGE_TTL_MS });
            return res.json({ success: true, nonce, expires: now + CHALLENGE_TTL_MS });
        } catch (e) {
            console.error('[ATTEST] challenge error:', e.message);
            return reject(res, 500, 'server-error');
        }
    });

    app.post('/attest/verify', async (req, res) => {
        try {
            const now = Date.now();
            const body = req.body || {};
            const hwid = safeHwid(body.hwid);
            const nonce = String(body.nonce || '');
            const proof = String(body.proof || '');
            const digest = String(body.integrity || '');
            const debug = Number(body.debug);
            const version = String(body.version || '');

            if (!hwid) return reject(res, 400, 'bad-hwid');
            if (revoked.has(hwid)) return reject(res, 403, 'revoked', true);
            if (!versions.has(version)) return reject(res, 400, 'version');
            if (!/^[0-9]{1,20}$/.test(digest)) return reject(res, 400, 'integrity');
            if (![0, 1, 2].includes(debug)) return reject(res, 400, 'debug');

            const license = await checkLicense(hwid);
            if (!license.ok) return reject(res, 403, license.reason, !!license.stop);

            const pending = challenges.get(hwid);
            if (!pending || pending.expires <= now || !timingSafeHexEqual(pending.nonce, nonce)) {
                return reject(res, 401, 'challenge');
            }
            challenges.delete(hwid); // single use, prevents replay

            const message = [nonce, hwid, digest, String(debug), version].join('|');
            const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');
            if (!timingSafeHexEqual(expected, proof)) return reject(res, 401, 'proof');

            const requiredIntegrity = expectedIntegrity.get(version) || expectedIntegrity.get('*');
            if (requiredIntegrity && requiredIntegrity !== digest) {
                console.warn(`[ATTEST] integrity mismatch for ${hwid} (${version})`);
                return reject(res, 403, 'integrity-mismatch', true);
            }

            // The same build must always report the same code digest. A change
            // means the binary was patched in memory.
            const key = `${hwid}:${version}`;
            const previous = integrity.get(key);
            if (previous && previous !== digest) {
                integrity.set(key, digest);
                console.warn(`[ATTEST] integrity drift for ${hwid} (${version})`);
                return reject(res, 403, 'integrity-drift', true);
            }
            integrity.set(key, digest);

            if (stopOnDebug && debug > 0) {
                console.warn(`[ATTEST] debugger reported by ${hwid} (level ${debug})`);
                return reject(res, 403, 'debugger', true);
            }

            const token = crypto.randomBytes(24).toString('hex');
            const expires = now + TOKEN_TTL_MS;
            sessions.set(token, { hwid, version, integrity: digest, expires });

            console.log(`[ATTEST] ok hwid=${hwid} version=${version}${license.license ? ' licensed' : ''}`);
            return res.json({ success: true, token, expires });
        } catch (e) {
            console.error('[ATTEST] verify error:', e.message);
            return reject(res, 500, 'server-error');
        }
    });

    function authenticate(req, res, next) {
        const now = Date.now();
        prune(now);

        const header = String(req.headers.authorization || '');
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        const session = sessions.get(token);
        if (!session || session.expires <= now) return reject(res, 401, 'token');

        req.attestation = session;
        return next();
    }

    function revoke(hwid) {
        const clean = safeHwid(hwid);
        if (clean) revoked.add(clean);
    }

    const api = {
        authenticate,
        revoke,
        stats: () => ({ sessions: sessions.size, challenges: challenges.size, revoked: revoked.size }),
    };

    app.locals.attestation = api;
    console.log(`[ATTEST] mounted (versions: ${[...versions].join(', ')}, stopOnDebug: ${stopOnDebug})`);
    return api;
};
