// =================================
// Config Cloud (Port des Standalone-Servers auf den Bot/Express)
// =================================
//
// Endpunkte (kompatibel zum Cheat, der weiterhin /cloud/export + /cloud/import nutzt):
//   Cheat (no auth):
//     POST /cloud/export  { hwid, config, pcName, windowsUser }
//     GET  /cloud/import?hwid=XXX
//   Admin:
//     POST /admin/login { password }              -> Passwort-Login
//     POST /admin/login-code { code }             -> Discord-Einmal-Code-Login
//     GET  /admin/configs
//     GET  /admin/configs/:hwid
//     DELETE /admin/configs/:hwid
//     POST /admin/configs/:hwid/reset
//     GET  /cloud/panel   (Admin-Panel HTML)
//
// Storage: Datenbank (Postgres auf Render / SQLite lokal) statt configs.json,
// damit Configs auch nach einem Render-Redeploy erhalten bleiben.
//
// Mounted from index.js:
//   require('./config_cloud.js')({ app, db, loginCodes });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.CLOUD_ADMIN_PASSWORD || 'Rayx123';

// Vom Bot befüllte Einmal-Codes (Map: code -> { expires, adminTag }).
let loginCodes = new Map();
const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;

const safeHwid = (h) => {
    if (typeof h !== 'string') return '';
    h = h.trim().toUpperCase();
    if (!/^[A-Z0-9_\-]{3,64}$/.test(h)) return '';
    return h;
};

const cleanStr = (v, max = 128) => {
    if (typeof v !== 'string') return '';
    return v.slice(0, max).replace(/[\r\n\t]/g, ' ').trim();
};

const clientIp = (req) => {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return req.socket.remoteAddress || '';
};

const isAdmin = (req) => {
    const t = req.headers['x-admin-token'] || '';
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return t === ADMIN_PASSWORD || bearer === ADMIN_PASSWORD;
};

function registerCloudRoutes({ app, db, loginCodes: sharedLoginCodes }) {
    if (sharedLoginCodes) loginCodes = sharedLoginCodes;

    // ---------- CHEAT: EXPORT ----------
    app.post('/cloud/export', async (req, res) => {
        const body = req.body || {};
        const hwid = safeHwid(body.hwid);
        if (!hwid) return res.status(400).json({ success: false, error: 'missing hwid' });
        if (body.config === undefined || body.config === null) return res.status(400).json({ success: false, error: 'missing config' });

        let config = body.config;
        if (typeof config === 'string') {
            try { config = JSON.parse(config); } catch { return res.status(400).json({ success: false, error: 'config not valid json' }); }
        }
        if (typeof config !== 'object') return res.status(400).json({ success: false, error: 'config must be object' });

        const storedConfig = JSON.stringify(config);
        try {
            await db.upsertCloudConfig(hwid, {
                config: storedConfig,
                pcName: cleanStr(body.pcName || body.pc_name || body.computerName || body.desktopName || body.desktop || body.hostname || ''),
                windowsUser: cleanStr(body.windowsUser || body.windows_user || body.username || body.user || body.userName || ''),
                ip: clientIp(req)
            });
            console.log(`[CONFIG-EXPORT] ${hwid} pc=${(body.pcName || '').slice(0, 40)}`);
            return res.json({ success: true });
        } catch (e) {
            console.error('[CONFIG-EXPORT] error:', e.message);
            return res.status(500).json({ success: false, error: 'db error' });
        }
    });

    // ---------- CHEAT: IMPORT ----------
    app.get('/cloud/import', async (req, res) => {
        const hwid = safeHwid(String(req.query.hwid || ''));
        if (!hwid) return res.status(400).json({ success: false, error: 'missing hwid' });

        try {
            const entry = await db.getCloudConfig(hwid);
            if (!entry) return res.json({ success: false, error: 'no config' });

            let config;
            try { config = JSON.parse(entry.config); } catch { return res.json({ success: false, error: 'no config' }); }
            if (config && typeof config === 'object' && Object.keys(config).length === 0) {
                return res.json({ success: false, error: 'no config' });
            }

            const ip = clientIp(req);
            await db.touchCloudConfig(hwid, ip);
            return res.json({ success: true, config });
        } catch (e) {
            console.error('[CONFIG-IMPORT] error:', e.message);
            return res.status(500).json({ success: false, error: 'db error' });
        }
    });

    // ---------- ADMIN: LOGIN ----------
    app.post('/admin/login', (req, res) => {
        const body = req.body || {};
        if (body.password === ADMIN_PASSWORD) {
            return res.json({ success: true, token: ADMIN_PASSWORD });
        }
        return res.status(401).json({ success: false, error: 'wrong password' });
    });

    // ---------- ADMIN: DISCORD-EINMAL-CODE-LOGIN ----------
    app.post('/admin/login-code', (req, res) => {
        const body = req.body || {};
        const code = String(body.code || '').trim().toUpperCase();
        const entry = loginCodes.get(code);
        if (!entry) return res.status(401).json({ success: false, error: 'invalid code' });
        if (Date.now() > entry.expires) {
            loginCodes.delete(code);
            return res.status(401).json({ success: false, error: 'code expired' });
        }
        loginCodes.delete(code);
        console.log(`[CONFIG-LOGIN] ${entry.adminTag} per Discord-Code`);
        return res.json({ success: true, token: ADMIN_PASSWORD, admin: entry.adminTag });
    });

    // ---------- ADMIN: LIST ----------
    app.get('/admin/configs', async (req, res) => {
        if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'unauthorized' });
        try {
            const rows = await db.listCloudConfigs();
            const list = rows.map(e => ({
                hwid: e.hwid,
                pcName: e.pc_name || '',
                windowsUser: e.windows_user || '',
                ip: e.ip || '',
                configSize: e.config_size || 0,
                createdAt: e.created_at ? new Date(e.created_at).toISOString() : '',
                updatedAt: e.updated_at ? new Date(e.updated_at).toISOString() : '',
                lastSeen: e.last_seen ? new Date(e.last_seen).toISOString() : '',
                isNew: e.created_at ? (Date.now() - new Date(e.created_at).getTime() < 10 * 60 * 1000) : false
            }));
            return res.json({ success: true, count: list.length, configs: list });
        } catch (e) {
            console.error('[CONFIG-ADMIN] list error:', e.message);
            return res.status(500).json({ success: false, error: 'db error' });
        }
    });

    // ---------- ADMIN: DETAIL / DELETE / RESET ----------
    const detailRe = /^\/admin\/configs\/([^/]+)(\/reset)?$/;
    app.use((req, res, next) => {
        const m = req.path.match(detailRe);
        if (!m) return next();
        if (!isAdmin(req)) return res.status(401).json({ success: false, error: 'unauthorized' });
        const hwid = safeHwid(decodeURIComponent(m[1]));
        if (!hwid) return res.status(400).json({ success: false, error: 'invalid hwid' });

        if (m[2] === '/reset' && req.method === 'POST') {
            (async () => {
                try {
                    const entry = await db.getCloudConfig(hwid);
                    if (!entry) return res.status(404).json({ success: false, error: 'not found' });
                    await db.setCloudConfigEmpty(hwid);
                    console.log(`[CONFIG-RESET] ${hwid}`);
                    return res.json({ success: true });
                } catch (e) { return res.status(500).json({ success: false, error: 'db error' }); }
            })();
            return;
        }

        if (req.method === 'GET' && !m[2]) {
            (async () => {
                try {
                    const entry = await db.getCloudConfig(hwid);
                    if (!entry) return res.status(404).json({ success: false, error: 'not found' });
                    let config;
                    try { config = JSON.parse(entry.config); } catch { config = {}; }
                    return res.json({ success: true, entry: { hwid, pcName: entry.pc_name, windowsUser: entry.windows_user, ip: entry.ip, configSize: entry.config_size, createdAt: entry.created_at, updatedAt: entry.updated_at, lastSeen: entry.last_seen, config } });
                } catch (e) { return res.status(500).json({ success: false, error: 'db error' }); }
            })();
            return;
        }

        if (req.method === 'DELETE' && !m[2]) {
            (async () => {
                try {
                    const entry = await db.getCloudConfig(hwid);
                    if (!entry) return res.status(404).json({ success: false, error: 'not found' });
                    await db.deleteCloudConfig(hwid);
                    console.log(`[CONFIG-DELETE] ${hwid}`);
                    return res.json({ success: true });
                } catch (e) { return res.status(500).json({ success: false, error: 'db error' }); }
            })();
            return;
        }

        return res.status(405).json({ success: false, error: 'method not allowed' });
    });

    // ---------- Health ----------
    app.get('/cloud/health', (req, res) => {
        res.json({ success: true });
    });

    // ---------- Admin-Panel (separate HTML-Datei) ----------
    app.get('/cloud/panel', (req, res) => {
        res.sendFile(require('path').join(__dirname, 'cloud_panel.html'));
    });
}

module.exports = registerCloudRoutes;