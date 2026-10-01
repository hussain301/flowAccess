// ============================================================
// FlowAccess Extension — Background Service Worker
// Handles: Cookie injection, tab management, session control
// ============================================================

// Peer-ID registry: both extensions publish their own chrome.runtime.id
// as an httpOnly cookie on http://localhost:5500/ and read the other's.
// Watching is done purely by extension ID — never by name.
const REGISTRY_URL = 'http://localhost:5500/';
const PEER_COOKIE_NAME = 'fa_watchdog_id'; // written by the watchdog, read by us
const OWN_COOKIE_NAME = 'fa_main_id';      // written by us, read by the watchdog
const EXT_ID_RE = /^[a-p]{32}$/;

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
    if (c.hostOnly) {
        // Host-only cookie: no leading dot, exact host match
        if (cookieDomain.startsWith('.')) cookieDomain = cookieDomain.slice(1);
    } else if (!cookieDomain.startsWith('.')) {
        cookieDomain = '.' + cookieDomain;
    }

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
        sameSite: (() => {
            const s = String(c.sameSite || '').toLowerCase();
            if (s === 'none') return 'no_restriction'; // chrome.cookies.set rejects 'none'
            return (['no_restriction', 'lax', 'strict'].includes(s)) ? s : 'lax';
        })()
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
            // chrome.cookies.set resolves to null (no throw) when the
            // browser refuses the cookie — only count truthy results.
            const setResult = await chrome.cookies.set(details);
            if (setResult) {
                injected++;
            } else {
                failed++;
                console.warn(`[FlowAccess] Cookie refused (null result): ${details.name} on ${details.domain}`);
            }
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
                console.log('[FlowAccess] DEBUG INJECT_COOKIES received cookies:', request.cookies);
                // No auto-open: the user opens Flow from the dashboard
                // (saved project / New Project button). Injection only.
                const tabId = null;
                if (injected === 0) {
                    sendResponse({ success: false, injected, failed, tabId,
                        error: `0 of ${(request.cookies || []).length} cookies injected — cookie data invalid or rejected by the browser` });
                } else {
                    sendResponse({ success: true, injected, failed, tabId });
                }
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
                console.log('[FlowAccess] DEBUG FETCH_AND_INJECT raw endpoint response:', data);
                console.log('[FlowAccess] DEBUG FETCH_AND_INJECT parsed cookies:', cookies);

                const { injected, failed } = await setCookieList(cookies);

                // No auto-open: the user opens Flow from the dashboard
                // (saved project / New Project button). Injection only.
                let tabId = null;

                if (injected === 0) {
                    sendResponse({ success: false, injected, failed, total: cookies.length, tabId,
                        debugCookies: cookies, debugRaw: data,
                        error: `0 of ${cookies.length} cookies injected — check the endpoint response format` });
                } else {
                    sendResponse({ success: true, injected, failed, total: cookies.length, tabId,
                        debugCookies: cookies, debugRaw: data });
                }
            } catch (err) {
                console.error('[FlowAccess] FETCH_AND_INJECT error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();

        return true;
    }

    // Forget the paired watchdog and return to single-extension mode
    // (used from the dashboard when the watchdog was removed on purpose).
    // The 10-year registry cookie must go too, otherwise syncPeerId would
    // re-pair instantly; the faPeerForgotten tombstone blocks adoption
    // until a genuine watchdog reinstall re-arms it (see onInstalled).
    if (request.action === 'UNPAIR_PEER') {
        peerWatchdogId = null;
        (async () => {
            try {
                await chrome.cookies.remove({ url: REGISTRY_URL, name: PEER_COOKIE_NAME });
            } catch (e) {
                console.warn('[FlowAccess] UNPAIR_PEER cookie remove failed:', e);
            }
            try {
                await chrome.storage.local.remove(['faPeerWatchdogId', 'faWatchdogId', 'faWatchdogExpected']);
                await chrome.storage.local.set({ faPeerForgotten: true });
                sendResponse({ success: true });
            } catch (e) {
                sendResponse({ success: false });
            }
        })();
        return true;
    }

    // Extension presence check (+ watchdog protection status for the dashboard)
    if (request.action === 'PING') {
        // MV3 setInterval is unreliable when the service worker is suspended;
        // the dashboard PINGs every ~10s, so use it as the enforcement heartbeat.
        enforceOnlyAllowedExtensions().catch(() => {});
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

    // ---- Project history (3 entries, deduped) ----
    if (request.action === 'PROJECT_SAVE') {
        (async () => {
            try {
                const url = request.url;
                if (typeof url !== 'string' || !/^https:\/\/flow\.google\.com\/project\//i.test(url)) {
                    sendResponse({ success: false, error: 'Not a Flow project URL' });
                    return;
                }
                sendResponse(await saveProjectToHistory(url, request.name));
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }
    if (request.action === 'PROJECT_LIST') {
        (async () => {
            try { sendResponse({ success: true, projects: await getProjectHistory() }); }
            catch (err) { sendResponse({ success: false, error: err.message }); }
        })();
        return true;
    }
    if (request.action === 'PROJECT_REMOVE') {
        (async () => {
            try { sendResponse(await removeProjectFromHistory(request.url)); }
            catch (err) { sendResponse({ success: false, error: err.message }); }
        })();
        return true;
    }
    if (request.action === 'PROJECT_CLEAR') {
        (async () => {
            try { sendResponse(await clearProjectHistory()); }
            catch (err) { sendResponse({ success: false, error: err.message }); }
        })();
        return true;
    }

    // Open the projects side panel (from the floating launcher on Flow pages)
    if (request.action === 'OPEN_SIDE_PANEL') {
        (async () => {
            try {
                let tabId = sender && sender.tab ? sender.tab.id : undefined;
                if (tabId === undefined) {
                    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tabs && tabs[0]) tabId = tabs[0].id;
                }
                if (tabId === undefined) throw new Error('No tab to open the panel on');
                await chrome.sidePanel.open({ tabId });
                sendResponse({ success: true });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    sendResponse({ success: false, error: 'Unknown action' });
    return false;
});

// Hostname-exact Flow URL matching — a substring check would also match
// lookalike hosts (e.g. flow.google.com.evil.com).
function isFlowUrl(u) {
    try { return new URL(u).hostname === 'flow.google.com'; }
    catch (e) { return false; }
}

function closeFlowTabs() {
    chrome.tabs.query({}, (tabs) => {
        if (!tabs) return;
        tabs.forEach(tab => {
            if (tab.url && isFlowUrl(tab.url)) {
                chrome.tabs.remove(tab.id).catch(() => {});
            }
        });
    });
}

// ========================
// 2b. PROJECT HISTORY (max 3, event-driven dedup)
// ========================
// Single source of truth for saved Flow projects. Every save is
// deduplicated by project ID: re-saving moves the entry to the front
// instead of creating a duplicate. Capped at 3 entries (newest first) —
// a 4th project cannot be saved until one is removed.
const PROJECT_HISTORY_KEY = 'faProjectHistory';
const PROJECT_HISTORY_MAX = 3;

function projectIdOf(url) {
    try {
        const m = String(url).match(/\/project\/([a-zA-Z0-9_\-]+)/i);
        return m ? m[1] : null;
    } catch (e) { return null; }
}

function cleanProjectUrl(url) {
    try {
        const p = new URL(url);
        const m = p.pathname.match(/\/project\/[a-zA-Z0-9_\-]+/i);
        return m ? `${p.origin}${m[0]}` : url;
    } catch (e) { return url; }
}

async function getProjectHistory() {
    let list = [];
    try {
        const r = await chrome.storage.local.get([PROJECT_HISTORY_KEY, 'faSavedProjects']);
        if (Array.isArray(r[PROJECT_HISTORY_KEY])) {
            list = r[PROJECT_HISTORY_KEY];
        } else if (Array.isArray(r.faSavedProjects) && r.faSavedProjects.length) {
            // One-time migration from the legacy max-3 URL list
            list = r.faSavedProjects
                .map(u => ({ url: cleanProjectUrl(u), name: projectIdOf(u) || String(u), savedAt: Date.now() }))
                .filter(p => projectIdOf(p.url));
            await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: list });
        }
    } catch (e) {}
    // Enforce the 3-project cap on read too (drops any pre-cap extras).
    return (Array.isArray(list) ? list : []).slice(0, PROJECT_HISTORY_MAX);
}

async function saveProjectToHistory(url, name) {
    const clean = cleanProjectUrl(url);
    const id = projectIdOf(clean);
    if (!id) return { success: false, error: 'Not a Flow project URL' };
    const list = await getProjectHistory();
    const already = list.some(p => projectIdOf(p.url) === id);
    const next = list.filter(p => projectIdOf(p.url) !== id);
    // Hard cap: a NEW project cannot be saved while 3 are already saved.
    // Re-saving an existing one (moves to front) is always allowed.
    if (!already && next.length >= PROJECT_HISTORY_MAX) {
        return { success: false, error: 'PROJECT_LIMIT_REACHED', projects: list };
    }
    const label = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 80) : id;
    next.unshift({ url: clean, name: label, savedAt: Date.now() });
    const trimmed = next.slice(0, PROJECT_HISTORY_MAX);
    await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: trimmed });
    return { success: true, projects: trimmed, added: !already };
}

async function removeProjectFromHistory(url) {
    const id = projectIdOf(url);
    const list = await getProjectHistory();
    const next = id ? list.filter(p => projectIdOf(p.url) !== id) : list.filter(p => p.url !== url);
    await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: next });
    return { success: true, projects: next };
}

async function clearProjectHistory() {
    await chrome.storage.local.set({ [PROJECT_HISTORY_KEY]: [] });
    return { success: true, projects: [] };
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

// TEMP DEBUG (filhal): true = chrome://extensions wala tab band NAHI hoga,
// taake service worker ke DevTools (Inspect views) khole ja saken.
// Dobara block karne ke liye false kar do.
const FA_ALLOW_EXTENSIONS_PAGE = true;

function checkAndBlockTab(tabId, url) {
    if (!url) return;
    if (FA_ALLOW_EXTENSIONS_PAGE && url.toLowerCase().startsWith('chrome://extensions')) return;
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

    if (url && isFlowUrl(url)) {
        enforceSingleFlowTab();
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

// Race-safe: instead of removing the tab that triggered the check,
// keep the newest Flow tab (highest tab id) and remove the older
// duplicates — deterministic no matter which update fired first.
function enforceSingleFlowTab() {
    chrome.tabs.query({}, (tabs) => {
        const flowTabs = (tabs || []).filter(t => t.url && isFlowUrl(t.url));

        if (flowTabs.length <= 1) return;

        flowTabs.sort((a, b) => b.id - a.id);
        const keep = flowTabs[0];
        for (let i = 1; i < flowTabs.length; i++) {
            chrome.tabs.remove(flowTabs[i].id).catch(() => {});
        }
        chrome.tabs.update(keep.id, { active: true }).catch(() => {});
        if (keep.windowId) {
            chrome.windows.update(keep.windowId, { focused: true }).catch(() => {});
        }
        console.log('[FlowAccess] Duplicate Flow tabs closed, kept newest');
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
// The paired watchdog (matched by its extension ID, never by name) is
// exempt. Everything else gets disabled — but NOT instantly: a freshly
// installed watchdog needs time to publish its ID to the registry
// cookie, so unknown extensions get a grace period first. And a disable
// performed BY this enforcement is never treated as tampering (see the
// self-disable guard in section 7) — otherwise our own enforcement
// would look like an attack and nuke the session.
const ENFORCE_GRACE_MS = 90000; // 90s for a new watchdog to publish its ID
const SELF_DISABLE_GUARD_MS = 15000;

// IDs we disabled ourselves, persisted in chrome.storage.local under
// 'faSelfDisabled' as { id: timestamp }. The peer-gone handlers must
// ignore these — a disable performed by our own enforcement is not
// tampering and must never nuke the session. Persisted (not in-memory)
// so a service-worker restart between our disable and the management
// event cannot lose the guard.
const SELF_DISABLED_KEY = 'faSelfDisabled';

async function markSelfDisabled(id) {
    try {
        const r = await chrome.storage.local.get([SELF_DISABLED_KEY]);
        const map = (r[SELF_DISABLED_KEY] && typeof r[SELF_DISABLED_KEY] === 'object') ? r[SELF_DISABLED_KEY] : {};
        map[id] = Date.now();
        await chrome.storage.local.set({ [SELF_DISABLED_KEY]: map });
    } catch (e) {}
}

async function clearSelfDisabled(id) {
    try {
        const r = await chrome.storage.local.get([SELF_DISABLED_KEY]);
        const map = (r[SELF_DISABLED_KEY] && typeof r[SELF_DISABLED_KEY] === 'object') ? r[SELF_DISABLED_KEY] : {};
        if (map[id]) { delete map[id]; await chrome.storage.local.set({ [SELF_DISABLED_KEY]: map }); }
    } catch (e) {}
}

// Reads the persisted guard; prunes entries older than SELF_DISABLE_GUARD_MS.
async function wasSelfDisabled(id) {
    try {
        const r = await chrome.storage.local.get([SELF_DISABLED_KEY]);
        const map = (r[SELF_DISABLED_KEY] && typeof r[SELF_DISABLED_KEY] === 'object') ? r[SELF_DISABLED_KEY] : {};
        const t = map[id];
        if (!t) return false;
        if (Date.now() - t > SELF_DISABLE_GUARD_MS) {
            delete map[id];
            try { await chrome.storage.local.set({ [SELF_DISABLED_KEY]: map }); } catch (e) {}
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

// The guard record is written BEFORE setEnabled runs, so the onDisabled
// event — which may fire before the callback — is already covered.
async function disableExtension(id, reason) {
    await markSelfDisabled(id);
    return new Promise((resolve) => {
        chrome.management.setEnabled(id, false, () => {
            if (chrome.runtime.lastError) {
                console.log(`[FlowAccess] Could not disable (${reason}):`, chrome.runtime.lastError.message);
                clearSelfDisabled(id).then(() => resolve(false)); // didn't happen — don't guard it
            } else {
                console.log(`[FlowAccess] Disabled extension (${reason}): ${id}`);
                resolve(true);
            }
        });
    });
}

// firstSeen registry: extension id -> timestamp of first sighting.
// Persisted so a service-worker restart doesn't reset the grace period.
// Returns null when the storage read itself fails — callers must skip
// their write in that case (fail-closed).
async function getFirstSeenMap() {
    try {
        const r = await chrome.storage.local.get(['faFirstSeen']);
        return (r.faFirstSeen && typeof r.faFirstSeen === 'object') ? r.faFirstSeen : {};
    } catch (e) {
        console.warn('[FlowAccess] faFirstSeen read failed:', e);
        return null;
    }
}
async function noteFirstSeen(id) {
    let map;
    try {
        map = await getFirstSeenMap();
    } catch (e) {
        console.warn('[FlowAccess] noteFirstSeen read failed:', e);
        return 0;
    }
    if (map === null) return 0; // sentinel: read failed — fail closed, no write
    try {
        if (!map[id]) {
            map[id] = Date.now();
            await chrome.storage.local.set({ faFirstSeen: map });
        }
        return map[id];
    } catch (e) {
        console.warn('[FlowAccess] noteFirstSeen write failed:', e);
        return 0;
    }
}
async function forgetFirstSeen(id) {
    let map;
    try {
        map = await getFirstSeenMap();
    } catch (e) { return; }
    if (map === null) return; // read failed — skip the write
    if (map[id]) {
        delete map[id];
        try { await chrome.storage.local.set({ faFirstSeen: map }); } catch (e) {}
    }
}

async function enforceOnlyAllowedExtensions() {
    if (!chrome.management) return;

    const myId = chrome.runtime.id;
    await syncPeerId().catch(() => {});

    // Read the firstSeen map ONCE per run; mutate in memory; write once
    // at the end — no per-extension read-modify-write races.
    const map = await getFirstSeenMap();
    if (map === null) return; // storage unreadable — do nothing this run

    const extensions = await new Promise((resolve) => {
        try { chrome.management.getAll((list) => resolve(list || [])); }
        catch (e) { resolve([]); }
    });

    const seen = new Set();
    for (const ext of extensions) {
        if (!ext || ext.id === myId) continue;
        if (ext.type === 'theme') continue;
        if (ext.id === peerWatchdogId) {
            if (map[ext.id]) delete map[ext.id]; // paired: exempt, drop stale entry
            continue;
        }
        seen.add(ext.id);
        // Record the sighting for enabled AND disabled extensions alike,
        // so a disabled-then-re-enabled extension keeps its original
        // firstSeen instead of getting a fresh grace period.
        if (!map[ext.id]) map[ext.id] = Date.now();
        if (!ext.enabled) continue;
        const age = Date.now() - map[ext.id];
        if (age < ENFORCE_GRACE_MS) {
            console.log(`[FlowAccess] Enforcement grace for ${ext.id} (${Math.round((ENFORCE_GRACE_MS - age) / 1000)}s left)`);
            continue;
        }
        await disableExtension(ext.id, 'not allowlisted');
    }
    // Prune entries for extensions that are gone
    for (const id of Object.keys(map)) {
        if (!seen.has(id) && id !== peerWatchdogId) delete map[id];
    }
    try {
        await chrome.storage.local.set({ faFirstSeen: map });
    } catch (e) {
        console.warn('[FlowAccess] faFirstSeen write failed:', e);
    }
}

enforceOnlyAllowedExtensions().catch(() => {});
setInterval(() => enforceOnlyAllowedExtensions().catch(() => {}), 30000);

if (chrome.management && chrome.management.onEnabled) {
    chrome.management.onEnabled.addListener((ext) => {
        (async () => {
            if (!ext || ext.id === chrome.runtime.id) return;
            await syncPeerId().catch(() => {});
            if (ext.id === peerWatchdogId) return; // paired watchdog is allowed
            // Re-enabled by the user inside its grace period: leave it alone,
            // the periodic enforcement decides once the grace expires.
            // (noteFirstSeen is fail-closed: 0 on storage error → enforced.)
            const firstSeen = await noteFirstSeen(ext.id);
            if (Date.now() - firstSeen < ENFORCE_GRACE_MS) return;
            await disableExtension(ext.id, 're-enable blocked');
        })();
    });
}

if (chrome.management && chrome.management.onInstalled) {
    chrome.management.onInstalled.addListener((ext) => {
        if (!ext || ext.id === chrome.runtime.id) return;
        // Just record the sighting — the periodic enforcement gives it
        // ENFORCE_GRACE_MS to publish its registry ID before deciding.
        noteFirstSeen(ext.id).catch(() => {});
        (async () => {
            // Selective tombstone clear (with retries): the watchdog's service
            // worker publishes its ID asynchronously after install, so the
            // registry cookie may not exist on the first read. Only a valid
            // EXT_ID_RE registry ID re-arms pairing — random extensions don't.
            for (let i = 0; i < 10; i++) {
                let regId = null;
                try { regId = await readPeerIdFromRegistry(); } catch (e) {}
                if (regId && EXT_ID_RE.test(regId)) {
                    try {
                        const t = await chrome.storage.local.get(['faPeerForgotten']);
                        if (t.faPeerForgotten) {
                            await chrome.storage.local.remove(['faPeerForgotten']);
                            console.log('[FlowAccess] Watchdog reinstall detected — pairing re-armed');
                        }
                    } catch (e) {}
                    break;
                }
                await new Promise(r => setTimeout(r, 500));
            }
            // Pair eagerly so a watchdog is exempt ASAP.
            try {
                await syncPeerIdWithRetry(6, 400);
                if (ext.id === peerWatchdogId) {
                    console.log('[FlowAccess] Watchdog paired:', ext.id);
                    forgetFirstSeen(ext.id).catch(() => {});
                }
            } catch (e) {}
        })();
    });
}

console.log('[FlowAccess] All protections initialized');

// ========================
// 7. WATCHDOG (mutual protection) — ID-BASED
// ========================
// The watchdog is a tiny companion extension. Chrome gives an extension
// no hook for its own uninstall, so the watchdog wipes our cookies when
// WE are removed. Symmetrically, we watch the watchdog: if it is ever
// removed/disabled, we wipe the session immediately. Either removal
// order ends wiped — no bypass.
//
// Pairing is by extension ID only (never by name): each side publishes
// its chrome.runtime.id as an httpOnly registry cookie and reads the
// other's. The ID is persisted in storage so a cleared cookie jar does
// not break the pairing.
//
// Once a watchdog ID is known it is EXPECTED: cookie injection is
// refused while it is missing (see injectionAllowed), and the dashboard
// blocks Start/Resume until it is reinstalled. UNPAIR_PEER (from the
// dashboard) forgets it and returns to single-extension mode.
let peerWatchdogId = null;

async function publishOwnId() {
    try {
        await chrome.cookies.set({
            url: REGISTRY_URL,
            name: OWN_COOKIE_NAME,
            value: chrome.runtime.id,
            httpOnly: true,
            expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600
        });
    } catch (e) {
        console.warn('[FlowAccess] publishOwnId failed:', e);
    }
}

async function readPeerIdFromRegistry() {
    try {
        const c = await chrome.cookies.get({ url: REGISTRY_URL, name: PEER_COOKIE_NAME });
        if (c && c.value && EXT_ID_RE.test(c.value)) return c.value;
    } catch (e) {
        console.warn('[FlowAccess] readPeerIdFromRegistry failed:', e);
    }
    return null;
}

// Adopt a peer ID: persist it and rescue the watchdog if it is disabled
// (e.g. it was installed while we had not paired yet).
async function adoptPeerId(id) {
    peerWatchdogId = id;
    try { await chrome.storage.local.set({ faPeerWatchdogId: id, faWatchdogExpected: true }); } catch (e) {}
    try {
        const info = await chrome.management.get(id);
        if (info && !info.enabled) {
            await chrome.management.setEnabled(id, true);
            console.log('[FlowAccess] Watchdog rescued (re-enabled):', id);
        }
    } catch (e) {}
}

// Persisted self-disable record (storage key `faSelfDisabled`, written by
// enforcement): ids we disabled ourselves. Shape-tolerant: object map
// id->timestamp/true, or an array of ids. Numeric timestamps must be
// recent (5 min) — a stale record must never resurrect a watchdog the
// user disabled deliberately long ago.
const SELF_DISABLE_RECORD_MAX_AGE_MS = 5 * 60 * 1000;
async function selfDisableRecordExists(id) {
    if (await wasSelfDisabled(id)) return true; // persisted guard (survives SW restarts)
    try {
        const r = await chrome.storage.local.get(['faSelfDisabled']);
        const rec = r.faSelfDisabled;
        if (!rec || !id) return false;
        if (Array.isArray(rec)) return rec.includes(id);
        if (typeof rec === 'object') {
            const v = rec[id];
            if (v === undefined || v === null || v === false) return false;
            if (typeof v === 'number') return (Date.now() - v) < SELF_DISABLE_RECORD_MAX_AGE_MS;
            return true;
        }
    } catch (e) {}
    return false;
}

async function clearSelfDisableRecord(id) {
    try {
        const r = await chrome.storage.local.get(['faSelfDisabled']);
        const rec = r.faSelfDisabled;
        if (Array.isArray(rec)) {
            const next = rec.filter(x => x !== id);
            if (next.length !== rec.length) await chrome.storage.local.set({ faSelfDisabled: next });
        } else if (rec && typeof rec === 'object' && rec[id] !== undefined) {
            delete rec[id];
            await chrome.storage.local.set({ faSelfDisabled: rec });
        }
    } catch (e) {}
}

// Rescue decoupled from adoption: runs on every syncPeerId() when a valid
// registry ID exists. Re-enables the watchdog ONLY when it is disabled
// because OUR enforcement disabled it (self-disable record present) —
// the registry cookie is ground truth that this ID is the genuine
// watchdog, so the earlier disable was a pairing-race mistake. A watchdog
// disabled by anyone else is left alone (the tamper path handles it).
async function ensurePeerEnabled(id) {
    if (!id || !EXT_ID_RE.test(id)) return;
    try {
        const info = await chrome.management.get(id);
        if (!info || info.enabled) return;
        const selfDisabled = await selfDisableRecordExists(id);
        if (!selfDisabled) return;
        await chrome.management.setEnabled(id, true);
        console.log('[FlowAccess] Watchdog re-enabled (was self-disabled):', id);
        await clearSelfDisableRecord(id);
    } catch (e) {
        console.warn('[FlowAccess] ensurePeerEnabled failed:', e);
    }
}

async function syncPeerId() {
    // Tombstone: the user chose single-extension mode — never re-pair.
    try {
        const t = await chrome.storage.local.get(['faPeerForgotten']);
        if (t.faPeerForgotten) { peerWatchdogId = null; return null; }
    } catch (e) {}
    const fromRegistry = await readPeerIdFromRegistry();
    if (fromRegistry) {
        if (fromRegistry !== peerWatchdogId) {
            await adoptPeerId(fromRegistry);
        } else {
            // Already paired: still verify it wasn't wrongly disabled by us.
            await ensurePeerEnabled(fromRegistry).catch(() => {});
        }
        return peerWatchdogId;
    }
    // Registry cookie missing (e.g. cleared cookies) — fall back to storage,
    // but only for a well-formed ID of an extension that still exists.
    try {
        const s = await chrome.storage.local.get(['faPeerWatchdogId', 'faWatchdogId']);
        const stored = s.faPeerWatchdogId || s.faWatchdogId || null;
        if (stored && EXT_ID_RE.test(stored)) {
            try {
                await chrome.management.get(stored); // throws when the extension is gone
                peerWatchdogId = stored;
                if (!s.faPeerWatchdogId) {
                    try { await chrome.storage.local.set({ faPeerWatchdogId: stored }); } catch (e) {}
                }
            } catch (e) {
                // Ghost ID: the extension is no longer installed — drop the pairing.
                console.warn('[FlowAccess] Dropping ghost watchdog ID:', stored);
                peerWatchdogId = null;
                try { await chrome.storage.local.remove(['faPeerWatchdogId', 'faWatchdogId', 'faWatchdogExpected']); } catch (e2) {}
            }
        } else if (stored) {
            // Malformed stored ID — drop it too.
            console.warn('[FlowAccess] Dropping malformed stored watchdog ID');
            peerWatchdogId = null;
            try { await chrome.storage.local.remove(['faPeerWatchdogId', 'faWatchdogId', 'faWatchdogExpected']); } catch (e2) {}
        }
    } catch (e) {}
    return peerWatchdogId;
}

async function syncPeerIdWithRetry(tries, delayMs) {
    for (let i = 0; i < tries; i++) {
        const fromRegistry = await readPeerIdFromRegistry();
        if (fromRegistry) { await adoptPeerId(fromRegistry); return peerWatchdogId; }
        await new Promise(r => setTimeout(r, delayMs));
    }
    return syncPeerId();
}

async function getWatchdogStatus() {
    try {
        // Unconditional sync: PING must never report a stale in-memory ID.
        const id = await syncPeerId();
        if (!id) return { expected: false, alive: false };
        try {
            const info = await chrome.management.get(id);
            if (info && info.enabled) return { expected: true, alive: true };
        } catch (e) { /* peer gone from management */ }
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
    // NOTE: the peer ID stays stored (EXPECTED) — injection remains
    // refused and the dashboard keeps showing "Watchdog Required" until
    // the watchdog is reinstalled (or UNPAIR_PEER is used).
}

async function initWatchdogProtection() {
    await publishOwnId().catch(() => {});
    await syncPeerId().catch(() => {});
}

async function getStoredPeerId() {
    try {
        const s = await chrome.storage.local.get(['faPeerWatchdogId']);
        return s.faPeerWatchdogId || null;
    } catch (e) { return null; }
}

// Peer-gone handling is DEBOUNCED: a legitimate extension reload fires
// onDisabled/onUninstalled transiently, so we never wipe immediately.
// Instead we schedule a re-check alarm; only if the peer is STILL gone
// when the alarm fires do we wipe the session.
const PEER_RECHECK_ALARM = 'fa-peer-recheck';
const PEER_EVENT_KEY = 'faPeerGoneEvent'; // { id, kind, at } persisted for the alarm

async function schedulePeerRecheck(id, kind) {
    try {
        await chrome.storage.local.set({ [PEER_EVENT_KEY]: { id, kind, at: Date.now() } });
        await chrome.alarms.create(PEER_RECHECK_ALARM, { delayInMinutes: 0.1 });
        console.log(`[FlowAccess] Peer ${kind} — re-check scheduled`);
    } catch (e) {
        console.warn('[FlowAccess] Could not schedule peer re-check:', e);
    }
}

if (chrome.management) {
    // onUninstalled only passes the id (the extension is already gone),
    // so compare against the stored peer ID.
    if (chrome.management.onUninstalled) {
        chrome.management.onUninstalled.addListener((id) => {
            if (!id) return;
            (async () => {
                const storedId = await getStoredPeerId();
                if (id !== peerWatchdogId && id !== storedId) return;
                // Ignore events caused by our own enforcement (section 6).
                if (await wasSelfDisabled(id)) {
                    console.log('[FlowAccess] Ignoring self-inflicted peer event:', id);
                    return;
                }
                schedulePeerRecheck(id, 'removed');
            })();
        });
    }
    if (chrome.management.onDisabled) {
        chrome.management.onDisabled.addListener((info) => {
            if (!info) return;
            (async () => {
                const storedId = await getStoredPeerId();
                if (info.id !== peerWatchdogId && info.id !== storedId) return;
                // Ignore disables performed by our own enforcement (section 6) —
                // those are not tampering and must not nuke the session.
                if (await wasSelfDisabled(info.id)) {
                    console.log('[FlowAccess] Ignoring self-inflicted disable:', info.id);
                    return;
                }
                schedulePeerRecheck(info.id, 'disabled');
            })();
        });
    }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || alarm.name !== PEER_RECHECK_ALARM) return;
        (async () => {
            let evt = null;
            try {
                const s = await chrome.storage.local.get([PEER_EVENT_KEY]);
                evt = s[PEER_EVENT_KEY] || null;
                await chrome.storage.local.remove([PEER_EVENT_KEY]);
            } catch (e) {}
            if (!evt || !evt.id) return;
            // Our own enforcement disabled it in the meantime — not tampering.
            if (await wasSelfDisabled(evt.id)) {
                console.log('[FlowAccess] Peer re-check: self-disable, skipping wipe:', evt.id);
                return;
            }
            // Still the expected peer? (It may have been unpaired since.)
            const stillPeer = (evt.id === peerWatchdogId) || (evt.id === await getStoredPeerId());
            if (!stillPeer) return;
            try {
                const info = await chrome.management.get(evt.id);
                if (info && info.enabled) {
                    console.log('[FlowAccess] Peer re-check: peer is back/enabled, no wipe.');
                    return;
                }
            } catch (e) {
                // management.get throws when the extension is uninstalled —
                // fall through to the wipe.
            }
            await handleWatchdogGone(evt.kind === 'removed' ? 'removed' : 'disabled');
        })();
    });
}

initWatchdogProtection().catch(() => {});
console.log('[FlowAccess] Watchdog protection initialized');
