// ============================================================
// FlowAccess Extension — Content Script (All URLs)
// Injected on every page at document_start
// Handles: Extension presence beacon, hardened website
//          communication bridge, keyboard/context menu blocking
// ============================================================

(() => {
    // ========================
    // 1. EXTENSION PRESENCE BEACON
    // ========================

    document.documentElement.dataset.flowAccessExtension = 'true';
    document.documentElement.dataset.flowAccessVersion = chrome.runtime.getManifest().version;

    window.dispatchEvent(new CustomEvent('FLOW_ACCESS_EXTENSION_READY', {
        detail: { version: chrome.runtime.getManifest().version }
    }));

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.dispatchEvent(new CustomEvent('FLOW_ACCESS_EXTENSION_READY', {
                detail: { version: chrome.runtime.getManifest().version }
            }));
        });
    }

    // ========================
    // 2. HARDENED WEBSITE BRIDGE
    // ========================
    // Only the configured FlowAccess dashboard origin may drive the
    // extension. Actions are allowlisted and payloads validated so a
    // malicious page cannot trigger privileged operations.

    const ALLOWED_ACTIONS = new Set([
        'PING',
        'INJECT_COOKIES',
        'FETCH_AND_INJECT',
        'WIPE_COOKIES',
        'CLOSE_FLOW_TAB',
        'STOP_FLOW'
    ]);

    const DEFAULT_ORIGINS = ['http://localhost:5500'];

    let allowedOrigins = null;
    function getAllowedOrigins() {
        if (allowedOrigins) return Promise.resolve(allowedOrigins);
        return new Promise((resolve) => {
            try {
                chrome.storage.local.get(['dashboardOrigins'], (r) => {
                    const list = Array.isArray(r.dashboardOrigins) && r.dashboardOrigins.length
                        ? r.dashboardOrigins
                        : DEFAULT_ORIGINS;
                    allowedOrigins = list;
                    resolve(list);
                });
            } catch (e) {
                allowedOrigins = DEFAULT_ORIGINS;
                resolve(allowedOrigins);
            }
        });
    }
    // Prime the cache early
    getAllowedOrigins();

    function isPlainObject(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    // Validate action + payload shape before forwarding to background
    function validateBridgeMessage(action, payload) {
        if (!ALLOWED_ACTIONS.has(action)) return 'Unknown action';
        if (!isPlainObject(payload)) return 'Invalid payload';

        if (action === 'INJECT_COOKIES') {
            if (!Array.isArray(payload.cookies) || payload.cookies.length === 0 || payload.cookies.length > 500)
                return 'cookies must be a non-empty array (max 500)';
            for (const c of payload.cookies) {
                if (!isPlainObject(c) || typeof c.name !== 'string' || typeof c.value !== 'string')
                    return 'each cookie needs name/value strings';
            }
            if (payload.targetUrl !== undefined && typeof payload.targetUrl !== 'string')
                return 'targetUrl must be a string';
        }

        if (action === 'FETCH_AND_INJECT') {
            if (typeof payload.endpointUrl !== 'string' || !/^https:\/\//i.test(payload.endpointUrl))
                return 'endpointUrl must be an https URL';
            if (payload.endpointUrl.length > 2048) return 'endpointUrl too long';
        }

        return null; // OK
    }

    window.addEventListener('message', async (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'FLOW_ACCESS_WEB') return;

        const reply = (response) => {
            window.postMessage({
                source: 'FLOW_ACCESS_EXTENSION_REPLY',
                id: event.data.id,
                response: response,
                payload: response
            }, event.origin || '*');
        };

        try {
            // 1. Origin must be a configured dashboard origin
            const origins = await getAllowedOrigins();
            if (!origins.includes(event.origin)) return; // silently drop

            const { action, payload } = event.data;

            // 2. Action allowlist + payload schema validation
            const err = validateBridgeMessage(action, payload || {});
            if (err) {
                reply({ success: false, error: err });
                return;
            }

            // 3. Forward to background service worker
            const response = await chrome.runtime.sendMessage({ action, ...payload });
            reply(response);
        } catch (err) {
            try {
                reply({ success: false, error: err && err.message ? err.message : 'Bridge error' });
            } catch (e) { /* ignore */ }
        }
    });

    // ========================
    // 3. KEYBOARD SHORTCUT BLOCKING
    // ========================

    document.addEventListener('keydown', (e) => {
        if (e.key === 'F12' || e.keyCode === 123) {
            e.preventDefault(); e.stopPropagation(); return false;
        }
        if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.keyCode === 73)) {
            e.preventDefault(); e.stopPropagation(); return false;
        }
        if (e.ctrlKey && e.shiftKey && (e.key === 'J' || e.key === 'j' || e.keyCode === 74)) {
            e.preventDefault(); e.stopPropagation(); return false;
        }
        if (e.ctrlKey && (e.key === 'U' || e.key === 'u' || e.keyCode === 85)) {
            e.preventDefault(); e.stopPropagation(); return false;
        }
        if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c' || e.keyCode === 67)) {
            e.preventDefault(); e.stopPropagation(); return false;
        }
    }, true);

    // ========================
    // 4. RIGHT-CLICK BLOCKING
    // ========================

    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
    }, true);

    // ========================
    // 5. EXTENSION CONTEXT CHECK
    // ========================

    setInterval(() => {
        try {
            if (!chrome.runtime || !chrome.runtime.id) {
                window.location.reload();
            }
        } catch (e) {
            window.location.reload();
        }
    }, 5000);

})();
