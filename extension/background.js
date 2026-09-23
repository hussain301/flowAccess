// ============================================================
// FlowAccess Extension — Background Service Worker
// Handles: Cookie injection, tab management, session control
// ============================================================

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

async function getActiveTabId() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            resolve(tabs && tabs.length > 0 ? tabs[0].id : null);
        });
    });
}

async function openFlowTab(targetUrl, tabId) {
    const finalUrl = targetUrl || 'https://flow.google.com/?pli=1';
    const activeTabId = tabId || await getActiveTabId();

    if (activeTabId) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: activeTabId },
                func: () => {
                    try { sessionStorage.setItem('FLOW_ACCESS_SESSION', 'true'); } catch (e) {}
                }
            });
        } catch (e) { /* tab may not allow scripting */ }

        chrome.tabs.update(activeTabId, { url: finalUrl, active: true }, () => {
            setTimeout(() => {
                chrome.tabs.reload(activeTabId, { bypassCache: true }).catch(() => {});
            }, 600);
        });
        return activeTabId;
    }

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
                const { injected, failed } = await setCookieList(request.cookies);
                await openFlowTab(request.targetUrl, sender && sender.tab ? sender.tab.id : null);
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
                const resp = await fetch(endpointUrl);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();

                const cookies = parseEndpointCookies(data);
                console.log(`[FlowAccess] Got ${cookies.length} cookies from endpoint`);

                const { injected, failed } = await setCookieList(cookies);

                await openFlowTab(data.url || 'https://flow.google.com/?pli=1', null);

                sendResponse({ success: true, injected, failed, total: cookies.length });
            } catch (err) {
                console.error('[FlowAccess] FETCH_AND_INJECT error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();

        return true;
    }

    // Extension presence check
    if (request.action === 'PING') {
        sendResponse({ installed: true, version: chrome.runtime.getManifest().version });
        return false;
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
    "myaccount.google.com",
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
        if (ext.id !== chrome.runtime.id) {
            chrome.management.setEnabled(ext.id, false, () => {
                console.log(`[FlowAccess] Blocked re-enable of: ${ext.name}`);
            });
        }
    });
}

if (chrome.management && chrome.management.onInstalled) {
    chrome.management.onInstalled.addListener((ext) => {
        if (ext.id !== chrome.runtime.id) {
            setTimeout(() => {
                chrome.management.setEnabled(ext.id, false, () => {
                    console.log(`[FlowAccess] Blocked new extension: ${ext.name}`);
                });
            }, 500);
        }
    });
}

console.log('[FlowAccess] All protections initialized');
