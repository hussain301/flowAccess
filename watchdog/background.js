// ============================================================
// FlowAccess Watchdog — background service worker
//
// Chrome gives an extension NO hook for its own uninstall: once it is
// removed, zero of its code can run, so it can never wipe its own
// cookies afterwards. This tiny companion extension is the fix: it
// watches the main FlowAccess extension and, the moment that extension
// is uninstalled OR disabled, wipes the shared Google/Flow session
// cookies and closes every Flow tab.
//
// Watching is by extension ID only (never by name). Pairing is
// automatic: each side publishes its chrome.runtime.id as an httpOnly
// registry cookie on http://localhost:5500/ and reads the other's.
// The ID is persisted in storage so a cleared cookie jar does not
// break the pairing.
// ============================================================

const REGISTRY_URL = 'http://localhost:5500/';
const PEER_COOKIE_NAME = 'fa_main_id';     // written by main, read by us
const OWN_COOKIE_NAME = 'fa_watchdog_id'; // written by us, read by main
const EXT_ID_RE = /^[a-p]{32}$/;
const WIPE_DOMAIN_SUFFIXES = ['google.com', 'flow.google.com', 'gstatic.com'];

let peerMainId = null;

// ---------- ID pairing ----------
async function publishOwnId() {
    try {
        await chrome.cookies.set({
            url: REGISTRY_URL,
            name: OWN_COOKIE_NAME,
            value: chrome.runtime.id,
            httpOnly: true,
            expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600
        });
    } catch (e) {}
}

async function syncPeerId() {
    try {
        const c = await chrome.cookies.get({ url: REGISTRY_URL, name: PEER_COOKIE_NAME });
        if (c && c.value && EXT_ID_RE.test(c.value)) {
            peerMainId = c.value;
            try { await chrome.storage.local.set({ faPeerMainId: c.value }); } catch (e) {}
            return peerMainId;
        }
    } catch (e) {}
    try {
        const s = await chrome.storage.local.get(['faPeerMainId']);
        if (s.faPeerMainId) peerMainId = s.faPeerMainId;
    } catch (e) {}
    return peerMainId;
}

// ---------- scoped cookie wipe (mirrors the main extension) ----------
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
        } catch (e) { resolve(); }
    });
}

async function wipeFlowCookies() {
    console.warn('[Watchdog] Wiping Flow/Google cookies (scoped)...');
    try {
        const all = await chrome.cookies.getAll({});
        const targets = (all || []).filter(isWipeableCookie);
        await Promise.all(targets.map(removeOneCookie));
        console.log(`[Watchdog] Removed ${targets.length} Flow/Google cookies.`);
    } catch (e) {
        console.warn('[Watchdog] Scoped wipe error:', e);
    }
}

async function closeFlowTabs() {
    try {
        const tabs = await chrome.tabs.query({ url: '*://flow.google.com/*' });
        for (const t of tabs) {
            try { await chrome.tabs.remove(t.id); } catch (e) {}
        }
        console.log(`[Watchdog] Closed ${(tabs || []).length} Flow tab(s).`);
    } catch (e) {}
}

// ---------- the actual protection ----------
async function handleMainGone(how) {
    console.warn(`[Watchdog] Main extension ${how} — wiping shared session now.`);
    await wipeFlowCookies();
    await closeFlowTabs();
}

// ---------- wiring ----------
async function init() {
    await publishOwnId();
    await syncPeerId();
    console.log('[Watchdog] FlowAccess Watchdog initialized, peer:', peerMainId || '(not paired yet)');
}

if (chrome.management) {
    // onUninstalled only passes the id (the extension is already gone),
    // so compare against the stored peer ID — never by name.
    if (chrome.management.onUninstalled) {
        chrome.management.onUninstalled.addListener((id) => {
            if (!id) return;
            const check = (storedId) => {
                if (id === peerMainId || id === storedId) handleMainGone('uninstalled');
            };
            try {
                chrome.storage.local.get(['faPeerMainId']).then(s => check(s.faPeerMainId)).catch(() => check(null));
            } catch (e) { check(null); }
        });
    }
    if (chrome.management.onDisabled) {
        chrome.management.onDisabled.addListener((info) => {
            if (!info) return;
            const check = (storedId) => {
                if (info.id === peerMainId || info.id === storedId) handleMainGone('disabled');
            };
            try {
                chrome.storage.local.get(['faPeerMainId']).then(s => check(s.faPeerMainId)).catch(() => check(null));
            } catch (e) { check(null); }
        });
    }
    // Re-pair if the main extension is reinstalled (possibly a new ID)
    if (chrome.management.onInstalled) {
        chrome.management.onInstalled.addListener(() => { syncPeerId().catch(() => {}); });
    }
    if (chrome.management.onEnabled) {
        chrome.management.onEnabled.addListener(() => { syncPeerId().catch(() => {}); });
    }
}

init().catch(() => {});
