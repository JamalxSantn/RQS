const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

let db;

async function initializeDatabase() {
    db = await open({
        filename: './licenses.db',
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

    console.log("Baza danych jest gotowa.");
}

// PODSTAWOWE FUNKCJE DO LICENCJI
const getLicense = async (licenseKey) => {
    return await db.get('SELECT * FROM licenses WHERE license_key = ?', licenseKey);
};

const deleteLicenseDB = async (licenseKey) => {
    return await db.run('DELETE FROM licenses WHERE license_key = ?', licenseKey);
};

const getLicenseByHwid = async (hwid) => {
    if (!hwid) return undefined;
    return await db.get('SELECT * FROM licenses WHERE linked_hwid = ?', hwid);
};

const getLicensesByDiscordId = async (discordId) => {
    if (!discordId) return [];
    return await db.all('SELECT * FROM licenses WHERE linked_discord_id = ? ORDER BY created_at DESC', discordId);
};

const getActiveSessions = async () => {
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
    return await db.run(
        `INSERT INTO licenses (license_key, product, duration, created_at, expires_at, created_by_id, created_by_tag, resets_limit) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        key, product, duration, createdAt, expiresAt, createdById, createdByTag, resetsLimit
    );
};

const updateLicense = async (licenseKey, updates) => {
    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(licenseKey);
    return await db.run(`UPDATE licenses SET ${setClause} WHERE license_key = ?`, values);
};

// FUNKCJE STATYSTYK
const getActiveLicensesCount = async () => {
    const result = await db.get(`SELECT COUNT(*) as count FROM licenses 
                         WHERE (expires_at IS NULL OR expires_at > datetime('now')) 
                         AND linked_discord_id IS NOT NULL`);
    return result;
};

const getActiveUsersCount = async () => {
    const result = await db.get(`SELECT COUNT(DISTINCT linked_discord_id) as count FROM licenses 
                         WHERE (expires_at IS NULL OR expires_at > datetime('now')) 
                         AND linked_discord_id IS NOT NULL`);
    return result;
};

const getLicenseStats = async () => {
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
    return await db.get(`SELECT 
        SUM(resets_used) as total_resets_used,
        SUM(CASE WHEN resets_limit = -1 THEN 0 ELSE resets_limit END) as total_resets_available
    FROM licenses`);
};

const getRecentActivity = async () => {
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
    return await db.run(
        `INSERT INTO user_sessions (license_key, discord_id, ip_address, country) 
         VALUES (?, ?, ?, ?)`,
        licenseKey, discordId, ipAddress, country
    );
};

const endUserSession = async (licenseKey) => {
    return await db.run(
        `UPDATE user_sessions SET is_active = 0, end_time = datetime('now') 
         WHERE license_key = ? AND is_active = 1`,
        licenseKey
    );
};

// FUNKCJE ZAMRAŻANIA I DODAWANIA CZASU
const freezeLicense = async (licenseKey, frozenUntil, originalExpiresAt) => {
    return db.run(
        'UPDATE licenses SET frozen_until = ?, original_expires_at = ? WHERE license_key = ?',
        frozenUntil, originalExpiresAt, licenseKey
    );
};

const unfreezeLicense = async (licenseKey) => {
    const license = await db.get('SELECT * FROM licenses WHERE license_key = ?', licenseKey);
    if (!license) return null;

    let newExpiresAt = license.expires_at;
    if (license.original_expires_at) {
        // Przywróć oryginalną datę wygaśnięcia
        newExpiresAt = license.original_expires_at;
    }

    return db.run(
        'UPDATE licenses SET frozen_until = NULL, original_expires_at = NULL, expires_at = ? WHERE license_key = ?',
        newExpiresAt, licenseKey
    );
};

const addTimeToLicense = async (licenseKey, timeToAdd) => {
    const license = await db.get('SELECT * FROM licenses WHERE license_key = ?', licenseKey);
    if (!license) return null;

    let newExpiresAt = new Date(license.expires_at);
    if (license.expires_at) {
        newExpiresAt.setTime(newExpiresAt.getTime() + timeToAdd);
    } else {
        // Jeśli licencja jest permanentna, nie zmieniamy
        return null;
    }

    return db.run(
        'UPDATE licenses SET expires_at = ? WHERE license_key = ?',
        newExpiresAt.toISOString(), licenseKey
    );
};

// FUNKCJE POBRANIA LICENCJI
const getFrozenLicenses = () => 
    db.all('SELECT * FROM licenses WHERE frozen_until IS NOT NULL');

const getActiveLicenses = () =>
    db.all(`SELECT * FROM licenses 
            WHERE (expires_at IS NULL OR expires_at > datetime('now')) 
            AND linked_discord_id IS NOT NULL`);

const getAllLicenses = () => db.all('SELECT * FROM licenses ORDER BY created_at DESC');

// FUNKCJE LOGOWANIA
const logAdminAction = (adminId, adminTag, action, targetLicense, details) =>
    db.run(
        'INSERT INTO admin_logs (admin_id, admin_tag, action, target_license, details) VALUES (?, ?, ?, ?, ?)',
        adminId, adminTag, action, targetLicense, details
    );

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
    logAdminAction
};