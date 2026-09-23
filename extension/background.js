// ============================================================
// FlowAccess Extension — Background Service Worker
// Handles: Cookie injection, tab management, session control
// ============================================================

// ========================
// 1. COOKIE INJECTION
// ========================

/**
 * Injects an array of cookies into the browser using chrome.cookies.set
 * @param {Array} cookies - Array of cookie objects
 * @param {string} targetUrl - URL to navigate after injection
 * @param {number|null} tabId - Optional specific tab to use
 */
async function injectCookies(cookies, targetUrl, tabId) {
    const successList = [];
    const failList = [];

    for (const c of cookies) {
        try {
            let cookieDomain = c.domain || '.google.com';
            if (!cookieDomain.startsWith('.')) cookieDomain = '.' + cookieDomain;

            const cookieUrl = 'https://flow.google.com';
            const details = {
                url: cookieUrl,
                name: c.name,
                value: c.value,
                domain: cookieDomain,
                path: c.path || '/',
                secure: !!c.secure,
                httpOnly: !!c.httpOnly,
                sameSite: (c.sameSite && ['no_restriction', 'lax', 'strict'].includes(String(c.sameSite).toLowerCase()))
                    ? String(c.sameSite).toLowerCase()
                    : 'lax'
            };

            if (c.expirationDate) {
                details.expirationDate = c.expirationDate;
            }

            await chrome.cookies.set(details);
            successList.push(c.name);
        } catch (err) {
            console.warn(`[FlowAccess] Cookie set error for ${c.name}:`, err);
            failList.push({ name: c.name, error: err.message });
        }
    }

    console.log(`[FlowAccess] Injected ${successList.length} cookies, ${failList.length} failed`);

    // Mark session in the tab
    const activeTabId = tabId || await getActiveTabId();
    if (activeTabId) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: activeTabId },
                func: () => {
                    sessionStorage.setItem('FLOW_ACCESS_SESSION', 'true');
                    console.log('[FlowAccess] Session marked active');
                }
            });
        } catch (e) { }

        // Navigate to target URL
        const finalUrl = targetUrl || 'https://flow.google.com/?pli=1';
        chrome.tabs.update(activeTabId, { url: finalUrl, active: true }, () => {
            setTimeout(() => {
                chrome.tabs.reload(activeTabId, { bypassCache: true });
            }, 600);
        });
    }

    return { success: successList.length > 0, injected: successList.length, failed: failList.length };
}

/**
 * Gets the active tab ID
 */
async function getActiveTabId() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            resolve(tabs && tabs.length > 0 ? tabs[0].id : null);
        });
    });
}

// ========================
// 2. MESSAGE HANDLING
// ========================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Cookie injection request from website (via content script)
    if (request.action === 'INJECT_COOKIES') {
        const cookies = request.cookies;
        const targetUrl = request.targetUrl || 'https://flow.google.com/?pli=1';
        const tabId = sender && sender.tab ? sender.tab.id : null;

        injectCookies(cookies, targetUrl, tabId)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ success: false, error: err.message }));

        return true; // Keep channel open for async response
    }

    // Fetch cookies from endpoint URL, inject them, and open Flow
    if (request.action === 'FETCH_AND_INJECT') {
        const endpointUrl = request.endpointUrl;
        console.log('[FlowAccess] Fetching cookies from:', endpointUrl);

        (async () => {
            try {
                // 1. Fetch from endpoint
                const resp = await fetch(endpointUrl);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();

                // 2. Parse cookies — handle double-encoded JSON
                let cookies;
                if (typeof data.cookies === 'string') {
                    cookies = JSON.parse(data.cookies); // Double-encoded
                } else if (Array.isArray(data.cookies)) {
                    cookies = data.cookies;
                } else if (Array.isArray(data)) {
                    cookies = data;
                } else {
                    throw new Error('Unknown cookie format in response');
                }

                console.log(`[FlowAccess] Got ${cookies.length} cookies from endpoint`);

                // 3. Inject all cookies
                let injected = 0;
                for (const c of cookies) {
                    try {
                        let domain = c.domain || '.google.com';
                        if (!domain.startsWith('.')) domain = '.' + domain;
                        
                        const details = {
                            url: `https://${domain.startsWith('.') ? domain.slice(1) : domain}${c.path || '/'}`,
                            name: c.name,
                            value: c.value,
                            domain: domain,
                            path: c.path || '/',
                            secure: c.secure !== false,
                            httpOnly: !!c.httpOnly,
                            sameSite: (['no_restriction','lax','strict'].includes(String(c.sameSite||'').toLowerCase()))
                                ? String(c.sameSite).toLowerCase() : 'lax'
                        };
                        if (c.expirationDate) details.expirationDate = c.expirationDate;
                        
                        await chrome.cookies.set(details);
                        injected++;
                    } catch (e) {
                        console.warn(`[FlowAccess] Cookie ${c.name} error:`, e.message);
                    }
                }

                console.log(`[FlowAccess] Injected ${injected}/${cookies.length} cookies`);

                // 4. Open Flow in new tab
                const targetUrl = data.url || 'https://flow.google.com/?pli=1';
                const tab = await chrome.tabs.create({ url: targetUrl, active: true });

                // 5. Reload after short delay for cookies to take effect
                setTimeout(() => {
                    chrome.tabs.reload(tab.id, { bypassCache: true });
                }, 800);

                sendResponse({ success: true, injected: injected, total: cookies.length });
            } catch (err) {
                console.error('[FlowAccess] FETCH_AND_INJECT error:', err);
                sendResponse({ success: false, error: err.message });
            }
        })();

        return true; // Keep channel open for async
    }

    // Extension presence check
    if (request.action === 'PING') {
        sendResponse({ installed: true, version: chrome.runtime.getManifest().version });
        return true;
    }

    // Wipe all cookies (for session end / logout)
    if (request.action === 'WIPE_COOKIES') {
        wipeAllCookies();
        sendResponse({ success: true });
        return true;
    }

    // Close all Flow tabs (for pause/expire)
    if (request.action === 'CLOSE_FLOW_TAB') {
        chrome.tabs.query({}, (tabs) => {
            if (!tabs) return;
            tabs.forEach(tab => {
                if (tab.url && tab.url.toLowerCase().includes('flow.google.com')) {
                    chrome.tabs.remove(tab.id).catch(() => {});
                }
            });
        });
        sendResponse({ success: true });
        return true;
    }

    // Stop Flow — wipe cookies AND close Flow tabs
    if (request.action === 'STOP_FLOW') {
        wipeAllCookies();
        chrome.tabs.query({}, (tabs) => {
            if (!tabs) return;
            tabs.forEach(tab => {
                if (tab.url && tab.url.toLowerCase().includes('flow.google.com')) {
                    chrome.tabs.remove(tab.id).catch(() => {});
                }
            });
        });
        sendResponse({ success: true });
        return true;
    }
});

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

        // Block browser internal pages
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

        // Allow flow.google.com
        if (hostname === "flow.google.com") return;

        // Block other Google services
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

    // Single Flow tab enforcement
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
            // Existing flow tab found — close the new one, focus the existing
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
// 5. COOKIE WIPE (Session End)
// ========================

function wipeAllCookies() {
    console.warn("[FlowAccess] Wiping all cookies...");

    try {
        chrome.browsingData.removeCookies({ "since": 0 }, () => {
            console.log("[FlowAccess] browsingData.removeCookies completed.");
        });
    } catch (e) { }

    try {
        chrome.browsingData.remove({ "since": 0 }, { "cookies": true }, () => {
            console.log("[FlowAccess] browsingData.remove cookies completed.");
        });
    } catch (e) { }

    try {
        chrome.cookies.getAll({}, (cookies) => {
            if (!cookies) return;
            cookies.forEach((c) => {
                const protocol = c.secure ? "https:" : "http:";
                const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
                const url = `${protocol}//${domain}${c.path}`;
                chrome.cookies.remove({ url: url, name: c.name, storeId: c.storeId }, () => { });
            });
            console.log(`[FlowAccess] Individual deletion of ${cookies.length} cookies triggered.`);
        });
    } catch (e) { }

    // Reload all open tabs
    try {
        chrome.tabs.query({}, (tabs) => {
            if (!tabs) return;
            tabs.forEach((tab) => {
                if (tab && tab.id && tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("edge://")) {
                    chrome.tabs.reload(tab.id).catch(() => { });
                }
            });
        });
    } catch (e) { }
}

console.log('[FlowAccess] Background service worker initialized');

// ========================
// 6. EXTENSION ENFORCEMENT
// ========================
// Disable ALL other extensions — only FlowAccess stays
function enforceOnlyAllowedExtensions() {
    if (!chrome.management) return;

    const myId = chrome.runtime.id;

    chrome.management.getAll((extensions) => {
        if (!extensions) return;
        extensions.forEach(ext => {
            // Skip self
            if (ext.id === myId) return;
            // Skip themes
            if (ext.type === 'theme') return;
            // Disable everything else
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

// Run on startup
enforceOnlyAllowedExtensions();

// Run periodically (every 30 seconds)
setInterval(enforceOnlyAllowedExtensions, 30000);

// Also run when any extension is installed/enabled
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

// ========================
// 7. KILL FLOW IF NO ACCESS
// ========================
function killFlowTabsIfNoAccess() {
    // Check if we have Flow cookies
    chrome.cookies.getAll({ domain: '.google.com' }, (cookies) => {
        if (!cookies || cookies.length === 0) {
            // No cookies = no access. Close Flow tabs
            chrome.tabs.query({}, (tabs) => {
                if (!tabs) return;
                tabs.forEach(tab => {
                    if (tab.url && tab.url.includes('flow.google.com')) {
                        chrome.tabs.remove(tab.id).catch(() => {});
                    }
                });
            });
        }
    });
}

// ========================
// 8. RELOAD ALL TABS
// ========================
function reloadAllTabs() {
    chrome.tabs.query({}, (tabs) => {
        if (!tabs) return;
        tabs.forEach(tab => {
            if (tab && tab.id && tab.url && 
                !tab.url.startsWith('chrome://') && 
                !tab.url.startsWith('edge://') &&
                !tab.url.startsWith('chrome-extension://')) {
                chrome.tabs.reload(tab.id).catch(() => {});
            }
        });
    });
}

console.log('[FlowAccess] All protections initialized');
