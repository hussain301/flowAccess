// ============================================================
// FlowAccess Extension — Content Script (All URLs)
// Injected on every page at document_start
// Handles: Extension presence beacon, website communication,
//          DevTools protection, keyboard/context menu blocking
// ============================================================

(() => {
    // ========================
    // 1. EXTENSION PRESENCE BEACON
    // ========================

    // Set data attribute so website can detect extension synchronously
    document.documentElement.dataset.flowAccessExtension = 'true';
    document.documentElement.dataset.flowAccessVersion = chrome.runtime.getManifest().version;

    // Dispatch custom event for async detection
    window.dispatchEvent(new CustomEvent('FLOW_ACCESS_EXTENSION_READY', {
        detail: { version: chrome.runtime.getManifest().version }
    }));

    // Re-dispatch after DOM is ready (for SPAs that load later)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.dispatchEvent(new CustomEvent('FLOW_ACCESS_EXTENSION_READY', {
                detail: { version: chrome.runtime.getManifest().version }
            }));
        });
    }

    // ========================
    // 2. WEBSITE COMMUNICATION BRIDGE
    // ========================

    // Listen for messages from the FlowAccess website
    window.addEventListener('message', async (event) => {
        // Only accept messages from our own window
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'FLOW_ACCESS_WEB') return;

        const { id, action, payload } = event.data;

        try {
            // Forward to background service worker
            const response = await chrome.runtime.sendMessage({
                action: action,
                ...payload
            });

            // Send reply back to webpage
            window.postMessage({
                source: 'FLOW_ACCESS_EXTENSION_REPLY',
                id: id,
                response: response,
                payload: response
            }, '*');
        } catch (err) {
            window.postMessage({
                source: 'FLOW_ACCESS_EXTENSION_REPLY',
                id: id,
                response: { success: false, error: err.message },
                payload: { success: false, error: err.message }
            }, '*');
        }
    });

    // ========================
    // 3. DEVTOOLS PROTECTION
    // ========================

    // Timing-based debugger detection
    setInterval(() => {
        const start = Date.now();
        debugger;
        const elapsed = Date.now() - start;
        if (elapsed > 100) {
            // DevTools detected — reload page
            window.location.reload();
        }
    }, 1000);

    // ========================
    // 4. KEYBOARD SHORTCUT BLOCKING
    // ========================

    document.addEventListener('keydown', (e) => {
        // Block F12
        if (e.key === 'F12' || e.keyCode === 123) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }

        // Block Ctrl+Shift+I (DevTools)
        if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.keyCode === 73)) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }

        // Block Ctrl+Shift+J (Console)
        if (e.ctrlKey && e.shiftKey && (e.key === 'J' || e.key === 'j' || e.keyCode === 74)) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }

        // Block Ctrl+U (View Source)
        if (e.ctrlKey && (e.key === 'U' || e.key === 'u' || e.keyCode === 85)) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }

        // Block Ctrl+Shift+C (Element Inspector)
        if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c' || e.keyCode === 67)) {
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    }, true);

    // ========================
    // 5. RIGHT-CLICK BLOCKING
    // ========================

    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
    }, true);

    // ========================
    // 6. EXTENSION CONTEXT CHECK
    // ========================

    // Periodically verify extension context is still valid
    setInterval(() => {
        try {
            if (!chrome.runtime || !chrome.runtime.id) {
                // Extension context lost — reload
                window.location.reload();
            }
        } catch (e) {
            window.location.reload();
        }
    }, 5000);

})();
