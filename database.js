const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// Backend-Wahl: Mit DATABASE_URL -> Postgres (Neon, persistent).
// Ohne -> lokales SQLite (wie bisher).
const usePg = !!process.env.DATABASE_URL;

// Auf Cloud-Hostern (z. B. Render) ist die Festplatte fluechtig: ohne
// DATABASE_URL wird SQLite benutzt und Aenderungen (z. B. geloeschte Keys)
// werden bei jedem Neustart zurueckgesetzt. Darum deutlich warnen.
if (!usePg && (process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.NODE_ENV === 'production')) {
    console.warn('====================================================');
    console.warn(' WARNUNG: DATABASE_URL ist NICHT gesetzt!');
    console.warn(' Es wird fluechtiges SQLite benutzt -> geloeschte Keys');
    console.warn(' kommen nach jedem Neustart zurueck.');
    console.warn(' Bitte DATABASE_URL (Neon/Postgres) in den Env-Variablen');
    console.warn(' des Hosters setzen.');
    console.warn('====================================================');
}

let db = null;     // sqlite
let pgPool = null; // postgres

async function initializeDatabase() {
    if (usePg) {
        const { Pool } = require('pg');
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000
        });
        pgPool.on('error', (e) => console.error('pg pool error:', e.message));

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                license_key TEXT PRIMARY KEY,
                product TEXT NOT NULL,
                duration TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                expires_at TIMESTAMPTZ,
                created_by_id TEXT NOT NULL,
                created_by_tag TEXT NOT NULL,
                resets_limit BIGINT NOT NULL,
                resets_used BIGINT DEFAULT 0,
                linked_discord_id TEXT,
                linked_hwid TEXT,
                role_redeemed BOOLEAN DEFAULT FALSE,
                last_login TIMESTAMPTZ,
                verification_code TEXT,
                verification_expires TIMESTAMPTZ,
                frozen_until TIMESTAMPTZ,
                original_expires_at TIMESTAMPTZ,
                last_inject TIMESTAMPTZ
            )
        `);

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS user_sessions (
                id SERIAL PRIMARY KEY,
                license_key TEXT NOT NULL,
                discord_id TEXT NOT NULL,
                ip_address TEXT,
                country TEXT,
                start_time TIMESTAMPTZ DEFAULT NOW(),
                end_time TIMESTAMPTZ,
                is_active BOOLEAN DEFAULT TRUE,
                FOREIGN KEY (license_key) REFERENCES licenses (license_key)
            )
        `);

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS admin_logs (
                id SERIAL PRIMARY KEY,
                admin_id TEXT NOT NULL,
                admin_tag TEXT NOT NULL,
                action TEXT NOT NULL,
                target_license TEXT,
                details TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await pgPool.query(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS last_inject TIMESTAMPTZ`);

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS cloud_configs (
                hwid TEXT PRIMARY KEY,
                config TEXT NOT NULL,
                pc_name TEXT,
                windows_user TEXT,
                ip TEXT,
                config_size INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                last_seen TIMESTAMPTZ
            )
        `);

        console.log("Baza danych jest gotowa. (Postgres)");
        return;
    }

    db = await open({
        filename: process.env.DB_PATH || './licenses.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS licenses (
            license_key TEXT PRIMARY KEY,
            product TEXT NOT NULL,
            duration TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL,
            expires_at TIMESTAMP,
            created_by_id TEXT NOT NULL,
            created_by_tag TEXT NOT NULL,
            resets_limit INTEGER NOT NULL,
            resets_used INTEGER DEFAULT 0,
            linked_discord_id TEXT,
            linked_hwid TEXT,
            role_redeemed BOOLEAN DEFAULT 0,
            last_login TIMESTAMP,
            verification_code TEXT,
            verification_expires TIMESTAMP,
            frozen_until TIMESTAMP,
            original_expires_at TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            license_key TEXT NOT NULL,
            discord_id TEXT NOT NULL,
            ip_address TEXT,
            country TEXT,
            start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            end_time TIMESTAMP,
            is_active BOOLEAN DEFAULT 1,
            FOREIGN KEY (license_key) REFERENCES licenses (license_key)
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS admin_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id TEXT NOT NULL,
            admin_tag TEXT NOT NULL,
            action TEXT NOT NULL,
            target_license TEXT,
            details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Migration: letzter Inject-Zeitpunkt pro Lizenz (fuer #inject / #user).
    try {
        await db.exec(`ALTER TABLE licenses ADD COLUMN last_inject TIMESTAMP`);
    } catch (e) {
        // Spalte existiert bereits -> ignorieren.
    }

    await db.exec(`
        CREATE TABLE IF NOT EXISTS cloud_configs (
            hwid TEXT PRIMARY KEY,
            config TEXT NOT NULL,
            pc_name TEXT,
            windows_user TEXT,
            ip TEXT,
            config_size INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_seen TIMESTAMP
        )
    `);

    console.log("Baza danych jest gotowa. (SQLite)");
}

// PODSTAWOWE FUNKCJE DO LICENCJI
const getLicense = async (licenseKey) => {
    if (usePg) {
        const r = await pgPool.query('SELECT * FROM licenses WHERE license_key = $1', [licenseKey]);
        return r.rows[0];
    }
    return await db.get('SELECT * FROM licenses WHERE license_key = ?', licenseKey);
};

const deleteLicenseDB = async (licenseKey) => {
    // user_sessions hat einen Foreign Key auf licenses (ohne ON DELETE CASCADE).
    // Erst die abhaengigen Sitzungen loeschen, sonst schlaegt das Loeschen auf
    // Postgres fehl und der Key "kommt nach dem Neustart wieder".
    if (usePg) {
        await pgPool.query('DELETE FROM user_sessions WHERE license_key = $1', [licenseKey]);
        return await pgPool.query('DELETE FROM licenses WHERE license_key = $1', [licenseKey]);
    }
    await db.run('DELETE FROM user_sessions WHERE license_key = ?', licenseKey);
    return await db.run('DELETE FROM licenses WHERE license_key = ?', licenseKey);
};

const getLicenseByHwid = async (hwid) => {
    if (!hwid) return undefined;
    if (usePg) {
        const r = await pgPool.query('SELECT * FROM licenses WHERE linked_hwid = $1', [hwid]);
        return r.rows[0];
    }
    return await db.get('SELECT * FROM licenses WHERE linked_hwid = ?', hwid);
};

const getLicensesByDiscordId = async (discordId) => {
    if (!discordId) return [];
    if (usePg) {
        const r = await pgPool.query('SELECT * FROM licenses WHERE linked_discord_id = $1 ORDER BY created_at DESC', [discordId]);
        return r.rows;
    }
    return await db.all('SELECT * FROM licenses WHERE linked_discord_id = ? ORDER BY created_at DESC', discordId);
};

const getActiveSessions = async () => {
    if (usePg) {
        const r = await pgPool.query(`SELECT
            us.license_key,
            us.discord_id,
            us.start_time,
            l.product,
            l.expires_at,
            l.linked_hwid
        FROM user_sessions us
        JOIN licenses l ON us.license_key = l.license_key
        WHERE us.is_active = TRUE
        ORDER BY us.start_time DESC`);
        return r.rows;
    }
    return await db.all(`SELECT
        us.license_key,
        us.discord_id,
        us.start_time,
        l.product,
        l.expires_at,
        l.linked_hwid
    FROM user_sessions us
    JOIN licenses l ON us.license_key = l.license_key
    WHERE us.is_active = 1
    ORDER BY us.start_time DESC`);
};

const addLicense = async (licenseData) => {
    const { key, product, duration, createdAt, expiresAt, createdById, createdByTag, resetsLimit } = licenseData;
    if (usePg) {
        return await pgPool.query(
            `INSERT INTO licenses (license_key, product, duration, created_at, expires_at, created_by_id, created_by_tag, resets_limit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [key, product, duration, createdAt, expiresAt, createdById, createdByTag, resetsLimit]
        );
    }
    return await db.run(
        `INSERT INTO licenses (license_key, product, duration, created_at, expires_at, created_by_id, created_by_tag, resets_limit)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        key, product, duration, createdAt, expiresAt, createdById, createdByTag, resetsLimit
    );
};

const updateLicense = async (licenseKey, updates) => {
    const keys = Object.keys(updates);
    const values = Object.values(updates);
    if (usePg) {
        const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
        values.push(licenseKey);
        return await pgPool.query(
            `UPDATE licenses SET ${setClause} WHERE license_key = $${keys.length + 1}`, values);
    }
    const setClause = keys.map(key => `${key} = ?`).join(', ');
    values.push(licenseKey);
    return await db.run(`UPDATE licenses SET ${setClause} WHERE license_key = ?`, values);
};

// FUNKCJE STATYSTYK
const getActiveLicensesCount = async () => {
    if (usePg) {
        const r = await pgPool.query(`SELECT COUNT(*)::int as count FROM licenses
                             WHERE (expires_at IS NULL OR expires_at > NOW())
                             AND linked_discord_id IS NOT NULL`);
        return r.rows[0];
    }
    const result = await db.get(`SELECT COUNT(*) as count FROM licenses
                         WHERE (expires_at IS NULL OR expires_at > datetime('now'))
                         AND linked_discord_id IS NOT NULL`);
    return result;
};

const getActiveUsersCount = async () => {
    if (usePg) {
        const r = await pgPool.query(`SELECT COUNT(DISTINCT linked_discord_id)::int as count FROM licenses
                             WHERE (expires_at IS NULL OR expires_at > NOW())
                             AND linked_discord_id IS NOT NULL`);
        return r.rows[0];
    }
    const result = await db.get(`SELECT COUNT(DISTINCT linked_discord_id) as count FROM licenses
                         WHERE (expires_at IS NULL OR expires_at > datetime('now'))
                         AND linked_discord_id IS NOT NULL`);
    return result;
};

const getLicenseStats = async () => {
    if (usePg) {
        const r = await pgPool.query(`SELECT
            product,
            COUNT(*)::int as total,
            SUM(CASE WHEN linked_discord_id IS NOT NULL THEN 1 ELSE 0 END)::int as activated,
            SUM(CASE WHEN linked_discord_id IS NULL THEN 1 ELSE 0 END)::int as available,
            SUM(CASE WHEN expires_at < NOW() THEN 1 ELSE 0 END)::int as expired
        FROM licenses
        GROUP BY product`);
        return r.rows;
    }
    return await db.all(`SELECT
        product,
        COUNT(*) as total,
        SUM(CASE WHEN linked_discord_id IS NOT NULL THEN 1 ELSE 0 END) as activated,
        SUM(CASE WHEN linked_discord_id IS NULL THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN expires_at < datetime('now') THEN 1 ELSE 0 END) as expired
    FROM licenses
    GROUP BY product`);
};

const getCountryStats = async () => {
    if (usePg) {
        const r = await pgPool.query(`SELECT
            country,
            COUNT(*)::int as user_count,
            ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM user_sessions WHERE is_active = TRUE), 0), 2) as percentage
        FROM user_sessions
        WHERE is_active = TRUE
        GROUP BY country
        ORDER BY user_count DESC`);
        return r.rows;
    }
    return await db.all(`SELECT
        country,
        COUNT(*) as user_count,
        ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM user_sessions WHERE is_active = 1), 2) as percentage
    FROM user_sessions
    WHERE is_active = 1
    GROUP BY country
    ORDER BY user_count DESC`);
};

const getResetStats = async () => {
    if (usePg) {
        const r = await pgPool.query(`SELECT
            SUM(resets_used) as total_resets_used,
            SUM(CASE WHEN resets_limit = -1 THEN 0 ELSE resets_limit END) as total_resets_available
        FROM licenses`);
        return r.rows[0];
    }
    return await db.get(`SELECT
        SUM(resets_used) as total_resets_used,
        SUM(CASE WHEN resets_limit = -1 THEN 0 ELSE resets_limit END) as total_resets_available
    FROM licenses`);
};

const getRecentActivity = async () => {
    if (usePg) {
        const r = await pgPool.query(`SELECT
            us.license_key,
            l.product,
            us.discord_id,
            us.country,
            us.start_time
        FROM user_sessions us
        JOIN licenses l ON us.license_key = l.license_key
        WHERE us.is_active = TRUE
        ORDER BY us.start_time DESC
        LIMIT 10`);
        return r.rows;
    }
    return await db.all(`SELECT
        us.license_key,
        l.product,
        us.discord_id,
        us.country,
        us.start_time
    FROM user_sessions us
    JOIN licenses l ON us.license_key = l.license_key
    WHERE us.is_active = 1
    ORDER BY us.start_time DESC
    LIMIT 10`);
};

// FUNKCJE SESJI UŻYTKOWNIKA
const startUserSession = async (sessionData) => {
    const { licenseKey, discordId, ipAddress, country } = sessionData;
    if (usePg) {
        return await pgPool.query(
            `INSERT INTO user_sessions (license_key, discord_id, ip_address, country)
             VALUES ($1, $2, $3, $4)`,
            [licenseKey, discordId, ipAddress, country]
        );
    }
    return await db.run(
        `INSERT INTO user_sessions (license_key, discord_id, ip_address, country)
          VALUES (?, ?, ?, ?)`,
        licenseKey, discordId, ipAddress, country
    );
};

const endUserSession = async (licenseKey) => {
    if (usePg) {
        return await pgPool.query(
            `UPDATE user_sessions SET is_active = FALSE, end_time = NOW()
             WHERE license_key = $1 AND is_active = TRUE`,
            [licenseKey]
        );
    }
    return await db.run(
        `UPDATE user_sessions SET is_active = 0, end_time = datetime('now')
         WHERE license_key = ? AND is_active = 1`,
        licenseKey
    );
};

// FUNKCJE ZAMRAŻANIA I DODAWANIA CZASU
const freezeLicense = async (licenseKey, frozenUntil, originalExpiresAt) => {
    if (usePg) {
        return pgPool.query(
            'UPDATE licenses SET frozen_until = $1, original_expires_at = $2 WHERE license_key = $3',
            [frozenUntil, originalExpiresAt, licenseKey]
        );
    }
    return db.run(
        'UPDATE licenses SET frozen_until = ?, original_expires_at = ? WHERE license_key = ?',
        frozenUntil, originalExpiresAt, licenseKey
    );
};

const unfreezeLicense = async (licenseKey) => {
    const license = await getLicense(licenseKey);
    if (!license) return null;

    let newExpiresAt = license.expires_at;
    if (license.original_expires_at) {
        // Przywróć oryginalną datę wygaśnięcia
        newExpiresAt = license.original_expires_at;
    }

    if (usePg) {
        return pgPool.query(
            'UPDATE licenses SET frozen_until = NULL, original_expires_at = NULL, expires_at = $1 WHERE license_key = $2',
            [newExpiresAt, licenseKey]
        );
    }
    return db.run(
        'UPDATE licenses SET frozen_until = NULL, original_expires_at = NULL, expires_at = ? WHERE license_key = ?',
        newExpiresAt, licenseKey
    );
};

const addTimeToLicense = async (licenseKey, timeToAdd) => {
    const license = await getLicense(licenseKey);
    if (!license) return null;

    let newExpiresAt = new Date(license.expires_at);
    if (license.expires_at) {
        newExpiresAt.setTime(newExpiresAt.getTime() + timeToAdd);
    } else {
        // Jeśli licencja jest permanentna, nie zmieniamy
        return null;
    }

    if (usePg) {
        return pgPool.query(
            'UPDATE licenses SET expires_at = $1 WHERE license_key = $2',
            [newExpiresAt.toISOString(), licenseKey]
        );
    }
    return db.run(
        'UPDATE licenses SET expires_at = ? WHERE license_key = ?',
        newExpiresAt.toISOString(), licenseKey
    );
};

// FUNKCJE POBRANIA LICENCJI
const getFrozenLicenses = async () => {
    if (usePg) {
        const r = await pgPool.query('SELECT * FROM licenses WHERE frozen_until IS NOT NULL');
        return r.rows;
    }
    return db.all('SELECT * FROM licenses WHERE frozen_until IS NOT NULL');
};

const getActiveLicenses = async () => {
    if (usePg) {
        const r = await pgPool.query(`SELECT * FROM licenses
            WHERE (expires_at IS NULL OR expires_at > NOW())
            AND linked_discord_id IS NOT NULL`);
        return r.rows;
    }
    return db.all(`SELECT * FROM licenses
            WHERE (expires_at IS NULL OR expires_at > datetime('now'))
            AND linked_discord_id IS NOT NULL`);
};

const getAllLicenses = async () => {
    if (usePg) {
        const r = await pgPool.query('SELECT * FROM licenses ORDER BY created_at DESC');
        return r.rows;
    }
    return db.all('SELECT * FROM licenses ORDER BY created_at DESC');
};

// FUNKCJE LOGOWANIA
const logAdminAction = (adminId, adminTag, action, targetLicense, details) => {
    if (usePg) {
        return pgPool.query(
            'INSERT INTO admin_logs (admin_id, admin_tag, action, target_license, details) VALUES ($1, $2, $3, $4, $5)',
            [adminId, adminTag, action, targetLicense, details]
        );
    }
    return db.run(
        'INSERT INTO admin_logs (admin_id, admin_tag, action, target_license, details) VALUES (?, ?, ?, ?, ?)',
        adminId, adminTag, action, targetLicense, details
    );
};

// FUNKCJE CONFIG CHMURY (config-cloud)
// hwid -> JSON-String. Postgres: column jsonb. SQLite: TEXT.
const upsertCloudConfig = async (hwid, cfg) => {
    const configStr = typeof cfg.config === 'string' ? cfg.config : JSON.stringify(cfg.config);
    const pcName = cfg.pcName || '';
    const windowsUser = cfg.windowsUser || '';
    const ip = cfg.ip || '';
    if (usePg) {
        return await pgPool.query(`
            INSERT INTO cloud_configs (hwid, config, pc_name, windows_user, ip, config_size, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (hwid)
            DO UPDATE SET config = EXCLUDED.config,
                pc_name = EXCLUDED.pc_name,
                windows_user = EXCLUDED.windows_user,
                ip = EXCLUDED.ip,
                config_size = EXCLUDED.config_size,
                updated_at = NOW()
        `, [hwid, configStr, pcName, windowsUser, ip, configStr.length]);
    }
    return await db.run(`
        INSERT INTO cloud_configs (hwid, config, pc_name, windows_user, ip, config_size, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(hwid) DO UPDATE SET
            config = excluded.config,
            pc_name = excluded.pc_name,
            windows_user = excluded.windows_user,
            ip = excluded.ip,
            config_size = excluded.config_size,
            updated_at = CURRENT_TIMESTAMP
    `, [hwid, configStr, pcName, windowsUser, ip, configStr.length]);
};

const getCloudConfig = async (hwid) => {
    if (usePg) {
        const r = await pgPool.query('SELECT * FROM cloud_configs WHERE hwid = $1', [hwid]);
        return r.rows[0];
    }
    return await db.get('SELECT * FROM cloud_configs WHERE hwid = ?', hwid);
};

const touchCloudConfig = async (hwid, ip) => {
    if (usePg) {
        return await pgPool.query(
            'UPDATE cloud_configs SET last_seen = NOW(), ip = COALESCE($2, ip) WHERE hwid = $1',
            [hwid, ip]
        );
    }
    return await db.run(
        'UPDATE cloud_configs SET last_seen = CURRENT_TIMESTAMP, ip = COALESCE(?, ip) WHERE hwid = ?',
        ip, hwid
    );
};

const setCloudConfigEmpty = async (hwid) => {
    if (usePg) {
        return await pgPool.query(
            'UPDATE cloud_configs SET config = $2, config_size = 2, updated_at = NOW() WHERE hwid = $1',
            [hwid, '{}']
        );
    }
    return await db.run(
        'UPDATE cloud_configs SET config = ?, config_size = 2, updated_at = CURRENT_TIMESTAMP WHERE hwid = ?',
        '{}', hwid
    );
};

const deleteCloudConfig = async (hwid) => {
    if (usePg) {
        return await pgPool.query('DELETE FROM cloud_configs WHERE hwid = $1', [hwid]);
    }
    return await db.run('DELETE FROM cloud_configs WHERE hwid = ?', hwid);
};

const listCloudConfigs = async () => {
    if (usePg) {
        const r = await pgPool.query(`
            SELECT hwid, pc_name, windows_user, ip, config_size,
                   created_at, updated_at, last_seen
            FROM cloud_configs
            ORDER BY updated_at DESC`);
        return r.rows;
    }
    return await db.all(`
        SELECT hwid, pc_name, windows_user, ip, config_size,
               created_at, updated_at, last_seen
        FROM cloud_configs
        ORDER BY updated_at DESC`);
};

module.exports = {
    initializeDatabase,
    getLicense,
    deleteLicenseDB,
    addLicense,
    updateLicense,
    getActiveLicensesCount,
    getActiveUsersCount,
    getLicenseStats,
    getCountryStats,
    getResetStats,
    getRecentActivity,
    startUserSession,
    endUserSession,
    getLicenseByHwid,
    getLicensesByDiscordId,
    getActiveSessions,
    freezeLicense,
    unfreezeLicense,
    addTimeToLicense,
    getFrozenLicenses,
    getActiveLicenses,
    getAllLicenses,
    logAdminAction,
    upsertCloudConfig,
    getCloudConfig,
    touchCloudConfig,
    setCloudConfigEmpty,
    deleteCloudConfig,
    listCloudConfigs
};
