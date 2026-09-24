// ============================================================
// FlowAccess Watchdog — background service worker
//
// Chrome gives an extension NO hook for its own uninstall: once it is
// removed, zero of its code can run, so it can never wipe its own
// cookies afterwards. This tiny companion extension is the fix: it
// watches the main "FlowAccess Tool" extension via the management API
// and, the moment that extension is uninstalled OR disabled, wipes the
// shared Google/Flow session cookies and closes every Flow tab.
//
// Install order: install the watchdog BEFORE (or together with) the
// main extension. The main extension exempts "FlowAccess Watchdog" from
// its block-other-extensions enforcement, and watches the watchdog
// back — so removing either one wipes the session immediately.
// ============================================================

const MAIN_NAME = 'FlowAccess Tool';
const WIPE_DOMAIN_SUFFIXES = ['google.com', 'flow.google.com', 'gstatic.com'];

let watchedMainId = null;

// ---------- extension discovery ----------
async function findExtensionByName(name) {
    try {
        const all = await chrome.management.getAll();
        return (all || []).find(e => e.name === name) || null;
    } catch (e) { return null; }
}

async function discoverMain() {
    const found = await findExtensionByName(MAIN_NAME);
    if (found) {
        watchedMainId = found.id;
        try { await chrome.storage.local.set({ faMainId: found.id }); } catch (e) {}
        console.log('[Watchdog] Watching main extension:', found.id);
    } else {
        console.log('[Watchdog] Main extension not installed (yet).');
    }
    return found;
}

function rememberMain(info) {
    if (info && info.name === MAIN_NAME) {
        watchedMainId = info.id;
        chrome.storage.local.set({ faMainId: info.id }).catch(() => {});
        console.log('[Watchdog] Watching main extension:', info.id);
    }
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
    try {
        const s = await chrome.storage.local.get(['faMainId']);
        if (s.faMainId) watchedMainId = s.faMainId;
    } catch (e) {}
    await discoverMain();
}

if (chrome.management) {
    if (chrome.management.onInstalled) {
        chrome.management.onInstalled.addListener((info) => rememberMain(info));
    }
    if (chrome.management.onEnabled) {
        chrome.management.onEnabled.addListener((info) => rememberMain(info));
    }
    // onUninstalled only passes the id (the extension is already gone),
    // so we compare against the id we discovered earlier.
    if (chrome.management.onUninstalled) {
        chrome.management.onUninstalled.addListener((id) => {
            if (!id) return;
            Promise.resolve()
                .then(() => chrome.storage.local.get(['faMainId']))
                .then(s => {
                    if (id === watchedMainId || id === s.faMainId) handleMainGone('uninstalled');
                })
                .catch(() => {});
        });
    }
    if (chrome.management.onDisabled) {
        chrome.management.onDisabled.addListener((info) => {
            if (!info) return;
            if (info.id === watchedMainId || info.name === MAIN_NAME) handleMainGone('disabled');
        });
    }
}

init();
console.log('[Watchdog] FlowAccess Watchdog initialized');
