// ============================================================
// FlowAccess Extension — Background Service Worker
// Handles: Cookie injection, tab management, session control
// ============================================================

// Companion watchdog extension name (mutual protection — see §7).
// The watchdog is exempt from the block-other-extensions enforcement.
const WATCHDOG_NAME = 'FlowAccess Watchdog';

// ========================
// 1. COOKIE INJECTION (single implementation)
// ========================

/**
 * Normalize one cookie object into chrome.cookies.set details.
 * Returns null when the cookie entry is invalid.
 */
function toCookieDetails(c) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') return null;
    if (c.name.length === 0 || c.name.length > 256) return null;

    let cookieDomain = typeof c.domain === 'string' && c.domain ? c.domain : '.google.com';
    if (!cookieDomain.startsWith('.')) cookieDomain = '.' + cookieDomain;

    const host = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
    const url = `https://${host}${typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/'}`;

    const details = {
        url,
        name: c.name,
        value: c.value,
        domain: cookieDomain,
        path: typeof c.path === 'string' && c.path ? c.path : '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        sameSite: (['no_restriction', 'lax', 'strict'].includes(String(c.sameSite || '').toLowerCase()))
            ? String(c.sameSite).toLowerCase()
            : 'lax'
    };

    if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
        details.expirationDate = c.expirationDate;
    }

    return details;
}

/**
 * Set a list of cookies. Returns { injected, failed }.
 */
async function setCookieList(cookies) {
    let injected = 0, failed = 0;
    const list = Array.isArray(cookies) ? cookies.slice(0, 500) : [];
    for (const c of list) {
        try {
            const details = toCookieDetails(c);
            if (!details) { failed++; continue; }
            await chrome.cookies.set(details);
            injected++;
        } catch (err) {
            console.warn(`[FlowAccess] Cookie set error for ${c && c.name}:`, err);
            failed++;
        }
    }
    console.log(`[FlowAccess] Injected ${injected} cookies, ${failed} failed`);
    return { injected, failed };
}

/**
 * Parse an endpoint JSON body into a cookie array.
 * Handles: { cookies: [...] }, { cookies: "<json string>" }, [...]
 */
function parseEndpointCookies(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.cookies)) return data.cookies;
    if (data && typeof data.cookies === 'string') {
        const parsed = JSON.parse(data.cookies);
        if (Array.isArray(parsed)) return parsed;
    }
    throw new Error('Unknown cookie format in response');
}

// Open Flow in a NEW tab (dashboard tab is left untouched).
// If a Flow tab already exists, focus it instead of opening another.
async function openFlowTab(targetUrl) {
    const finalUrl = targetUrl || 'https://flow.google.com/?pli=1';

    try {
        const existing = await chrome.tabs.query({ url: '*://flow.google.com/*' });
        if (existing && existing.length > 0) {
            const tab = existing[0];
            await chrome.tabs.update(tab.id, { active: true });
            try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
            return tab.id;
        }
    } catch (e) { /* fall through to create */ }

    const tab = await chrome.tabs.create({ url: finalUrl, active: true });
    setTimeout(() => {
        chrome.tabs.reload(tab.id, { bypassCache: true }).catch(() => {});
    }, 800);
    return tab.id;
}

// ========================
// 2. MESSAGE HANDLING
// ========================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Only accept messages from our own extension contexts
    if (sender && sender.id && sender.id !== chrome.runtime.id) {
        sendResponse({ success: false, error: 'Unauthorized sender' });
        return false;
    }

    // Cookie injection request from website (via content script bridge)
    if (request.action === 'INJECT_COOKIES') {
        (async () => {
            try {
                // Refuse while the watchdog is expected but missing — otherwise
                // removing the watchdog would silently drop the protection.
                if (!(await injectionAllowed())) {
                    sendResponse({ success: false, error: 'Watchdog missing — injection refused' });
                    return;
                }
                const { injected, failed } = await setCookieList(request.cookies);
                await openFlowTab(request.targetUrl);
                sendResponse({ success: injected > 0, injected, failed });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // Fetch cookies from endpoint URL, inject them, and open Flow
    if (request.action === 'FETCH_AND_INJECT') {
        const endpointUrl = request.endpointUrl;
        if (typeof endpointUrl !== 'string' || !/^https:\/\//i.test(endpointUrl)) {
            sendResponse({ success: false, error: 'Invalid endpoint URL' });
            return false;
        }
        console.log('[FlowAccess] Fetching cookies from endpoint');

        (async () => {
            try {
                if (!(await injectionAllowed())) {
                    sendResponse({ success: false, error: 'Watchdog missing — injection refused' });
                    return;
                }
                const resp = await fetch(endpointUrl);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();

                const cookies = parseEndpointCookies(data);
                console.log(`[FlowAccess] Got ${cookies.length} cookies from endpoint`);

                const { injected, failed } = await setCookieList(cookies);

                await openFlowTab(data.url || 'https://flow.google.com/?pli=1');

                sendResponse({ success: true, injected, failed, total: cookies.length });
            } catch (err) {
                console.error('[FlowAccess] FETCH_AND_INJECT error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();

        return true;
    }

    // Extension presence check (+ watchdog protection status for the dashboard)
    if (request.action === 'PING') {
        (async () => {
            try {
                const wd = await getWatchdogStatus();
                sendResponse({
                    installed: true,
                    version: chrome.runtime.getManifest().version,
                    watchdogExpected: wd.expected,
                    watchdogAlive: wd.alive
                });
            } catch (e) {
                sendResponse({ installed: true, version: chrome.runtime.getManifest().version, watchdogExpected: false, watchdogAlive: false });
            }
        })();
        return true;
    }

    // Wipe Flow/Google cookies (scoped — never touches other sites' cookies)
    if (request.action === 'WIPE_COOKIES') {
        wipeFlowCookies().then(() => sendResponse({ success: true }));
        return true;
    }

    // Close all Flow tabs (for pause/expire)
    if (request.action === 'CLOSE_FLOW_TAB') {
        closeFlowTabs();
        sendResponse({ success: true });
        return false;
    }

    // Stop Flow — wipe Flow cookies AND close Flow tabs
    if (request.action === 'STOP_FLOW') {
        (async () => {
            await wipeFlowCookies();
            closeFlowTabs();
            sendResponse({ success: true });
        })();
        return true;
    }

    sendResponse({ success: false, error: 'Unknown action' });
    return false;
});

function closeFlowTabs() {
    chrome.tabs.query({}, (tabs) => {
        if (!tabs) return;
        tabs.forEach(tab => {
            if (tab.url && tab.url.toLowerCase().includes('flow.google.com')) {
                chrome.tabs.remove(tab.id).catch(() => {});
            }
        });
    });
}

// ========================
// 3. TAB / URL BLOCKING
// ========================

const blockedDomains = [
    "www.google.com", "translate.google.com", "gemini.google.com",
    "mail.google.com", "drive.google.com", "docs.google.com",
    "sheets.google.com", "slides.google.com", "forms.google.com",
    "meet.google.com", "calendar.google.com", "keep.google.com",
    "contacts.google.com", "photos.google.com",
    "www.youtube.com", "music.youtube.com",
    "play.google.com", "maps.google.com", "earth.google.com",
    "flights.google.com", "ads.google.com", "analytics.google.com",
    "www.blogger.com", "sites.google.com", "search.google.com",
    "one.google.com", "cloud.google.com", "about.google",
    "chromewebstore.google.com", "chrome.google.com"
];

const blockedPrefixes = [
    "chrome://settings", "chrome://password-manager", "chrome://extensions",
    "edge://settings", "edge://password-manager", "edge://extensions",
    "https://chromewebstore.google.com", "http://chromewebstore.google.com",
    "https://chrome.google.com/webstore", "http://chrome.google.com/webstore"
];

function checkAndBlockTab(tabId, url) {
    if (!url) return;
    try {
        const lowerUrl = url.toLowerCase();

        for (const prefix of blockedPrefixes) {
            if (lowerUrl.startsWith(prefix)) {
                chrome.tabs.remove(tabId).catch(() => { });
                return;
            }
        }

        if (lowerUrl.includes("chromewebstore.google.com") || lowerUrl.includes("chrome.google.com/webstore")) {
            chrome.tabs.remove(tabId).catch(() => { });
            return;
        }

        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();

        if (hostname === "flow.google.com") return;

        if (blockedDomains.includes(hostname)) {
            chrome.tabs.remove(tabId).catch(() => { });
        }
    } catch (e) {
        // Ignore invalid URLs
    }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = (tab && (tab.url || tab.pendingUrl)) || (changeInfo && changeInfo.url);
    checkAndBlockTab(tabId, url);

    if (url && url.toLowerCase().includes('flow.google.com')) {
        enforceSingleFlowTab(tabId);
    }
});

chrome.tabs.onCreated.addListener((tab) => {
    if (tab) {
        const url = tab.url || tab.pendingUrl;
        checkAndBlockTab(tab.id, url);
    }
});

// ========================
// 4. SINGLE FLOW TAB
// ========================

function enforceSingleFlowTab(newTabId) {
    chrome.tabs.query({}, (tabs) => {
        const flowTabs = tabs.filter(t =>
            t.url && t.url.toLowerCase().includes('flow.google.com') && t.id !== newTabId
        );

        if (flowTabs.length > 0) {
            chrome.tabs.remove(newTabId).catch(() => { });
            chrome.tabs.update(flowTabs[0].id, { active: true });
            if (flowTabs[0].windowId) {
                chrome.windows.update(flowTabs[0].windowId, { focused: true }).catch(() => { });
            }
            console.log('[FlowAccess] Duplicate Flow tab blocked');
        }
    });
}

// ========================
// 5. SCOPED COOKIE WIPE (Session End)
// ========================
// Only removes Google/Flow cookies. Other sites' cookies and
// unrelated tabs are never touched.

const WIPE_DOMAIN_SUFFIXES = ['google.com', 'flow.google.com', 'gstatic.com'];

function isWipeableCookie(cookie) {
    const d = (cookie.domain || '').toLowerCase().replace(/^\./, '');
    return WIPE_DOMAIN_SUFFIXES.some(suffix => d === suffix || d.endsWith('.' + suffix));
}

function removeOneCookie(cookie) {
    return new Promise((resolve) => {
        try {
            const protocol = cookie.secure ? 'https:' : 'http:';
            const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
            const url = `${protocol}//${domain}${cookie.path || '/'}`;
            chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId }, () => resolve());
        } catch (e) {
            resolve();
        }
    });
}

async function wipeFlowCookies() {
    console.warn('[FlowAccess] Wiping Flow/Google cookies (scoped)...');
    try {
        const all = await chrome.cookies.getAll({});
        const targets = (all || []).filter(isWipeableCookie);
        await Promise.all(targets.map(removeOneCookie));
        console.log(`[FlowAccess] Removed ${targets.length} Flow/Google cookies.`);
    } catch (e) {
        console.warn('[FlowAccess] Scoped wipe error:', e);
    }
    // NOTE: unrelated tabs are intentionally NOT reloaded.
}

console.log('[FlowAccess] Background service worker initialized');

// ========================
// 6. EXTENSION ENFORCEMENT
// ========================
function enforceOnlyAllowedExtensions() {
    if (!chrome.management) return;

    const myId = chrome.runtime.id;

    chrome.management.getAll((extensions) => {
        if (!extensions) return;
        extensions.forEach(ext => {
            if (ext.id === myId) return;
            if (ext.type === 'theme') return;
            if (ext.name === WATCHDOG_NAME) return; // companion watchdog is allowed
            if (ext.enabled) {
                chrome.management.setEnabled(ext.id, false, () => {
                    if (chrome.runtime.lastError) {
                        console.log(`[FlowAccess] Could not disable: ${ext.name}`);
                    } else {
                        console.log(`[FlowAccess] Disabled extension: ${ext.name}`);
                    }
                });
            }
        });
    });
}

enforceOnlyAllowedExtensions();
setInterval(enforceOnlyAllowedExtensions, 30000);

if (chrome.management && chrome.management.onEnabled) {
    chrome.management.onEnabled.addListener((ext) => {
        if (ext.id !== chrome.runtime.id && ext.name !== WATCHDOG_NAME) {
            chrome.management.setEnabled(ext.id, false, () => {
                console.log(`[FlowAccess] Blocked re-enable of: ${ext.name}`);
            });
        }
    });
}

if (chrome.management && chrome.management.onInstalled) {
    chrome.management.onInstalled.addListener((ext) => {
        if (ext.id !== chrome.runtime.id && ext.name !== WATCHDOG_NAME) {
            setTimeout(() => {
                chrome.management.setEnabled(ext.id, false, () => {
                    console.log(`[FlowAccess] Blocked new extension: ${ext.name}`);
                });
            }, 500);
        }
    });
}

console.log('[FlowAccess] All protections initialized');

// ========================
// 7. WATCHDOG (mutual protection)
// ========================
// The watchdog is a tiny companion extension ("FlowAccess Watchdog").
// Chrome gives an extension no hook for its own uninstall, so the
// watchdog wipes our cookies when WE are removed. Symmetrically, we
// watch the watchdog: if it is ever removed/disabled, we wipe the
// session immediately. Either removal order ends wiped — no bypass.
//
// Once the watchdog has been seen, it is EXPECTED: cookie injection is
// refused while it is missing (see injectionAllowed), and the dashboard
// blocks Start/Resume until it is reinstalled.
let watchedWatchdogId = null;

async function findExtensionByName(name) {
    try {
        const all = await chrome.management.getAll();
        return (all || []).find(e => e.name === name) || null;
    } catch (e) { return null; }
}

async function discoverWatchdog() {
    const found = await findExtensionByName(WATCHDOG_NAME);
    if (found) {
        watchedWatchdogId = found.id;
        try { await chrome.storage.local.set({ faWatchdogId: found.id, faWatchdogExpected: true }); } catch (e) {}
        console.log('[FlowAccess] Watchdog present:', found.id);
    }
    return found;
}

async function getWatchdogStatus() {
    try {
        const s = await chrome.storage.local.get(['faWatchdogExpected', 'faWatchdogId']);
        if (!s.faWatchdogExpected) return { expected: false, alive: false };
        const id = watchedWatchdogId || s.faWatchdogId;
        if (id) {
            try {
                const info = await chrome.management.get(id);
                if (info && info.enabled) return { expected: true, alive: true };
            } catch (e) { /* id stale — fall through to name scan */ }
        }
        const found = await findExtensionByName(WATCHDOG_NAME);
        if (found && found.enabled) {
            watchedWatchdogId = found.id;
            try { await chrome.storage.local.set({ faWatchdogId: found.id }); } catch (e) {}
            return { expected: true, alive: true };
        }
        return { expected: true, alive: false };
    } catch (e) {
        return { expected: false, alive: false };
    }
}

async function injectionAllowed() {
    const wd = await getWatchdogStatus();
    return !(wd.expected && !wd.alive);
}

async function handleWatchdogGone(how) {
    console.warn(`[FlowAccess] Watchdog ${how} — wiping shared session now.`);
    try { await wipeFlowCookies(); } catch (e) {}
    try { closeFlowTabs(); } catch (e) {}
    // NOTE: faWatchdogExpected stays true — injection remains refused
    // and the dashboard keeps showing "Watchdog Required" until the
    // watchdog is reinstalled.
}

async function initWatchdogProtection() {
    try {
        const s = await chrome.storage.local.get(['faWatchdogId']);
        if (s.faWatchdogId) watchedWatchdogId = s.faWatchdogId;
    } catch (e) {}
    await discoverWatchdog();
}

if (chrome.management) {
    if (chrome.management.onInstalled) {
        chrome.management.onInstalled.addListener((info) => {
            if (info && info.name === WATCHDOG_NAME) {
                watchedWatchdogId = info.id;
                chrome.storage.local.set({ faWatchdogId: info.id, faWatchdogExpected: true }).catch(() => {});
                console.log('[FlowAccess] Watchdog installed:', info.id);
            }
        });
    }
    if (chrome.management.onEnabled) {
        chrome.management.onEnabled.addListener((info) => {
            if (info && info.name === WATCHDOG_NAME) {
                watchedWatchdogId = info.id;
                chrome.storage.local.set({ faWatchdogId: info.id, faWatchdogExpected: true }).catch(() => {});
                console.log('[FlowAccess] Watchdog enabled:', info.id);
            }
        });
    }
    // onUninstalled only passes the id (the extension is already gone),
    // so compare against the id we discovered earlier.
    if (chrome.management.onUninstalled) {
        chrome.management.onUninstalled.addListener((id) => {
            if (!id) return;
            const check = (storedId) => {
                if (id === watchedWatchdogId || id === storedId) handleWatchdogGone('removed');
            };
            try {
                chrome.storage.local.get(['faWatchdogId']).then(s => check(s.faWatchdogId)).catch(() => check(null));
            } catch (e) { check(null); }
        });
    }
    if (chrome.management.onDisabled) {
        chrome.management.onDisabled.addListener((info) => {
            if (!info) return;
            if (info.id === watchedWatchdogId || info.name === WATCHDOG_NAME) handleWatchdogGone('disabled');
        });
    }
}

initWatchdogProtection();
console.log('[FlowAccess] Watchdog protection initialized');
