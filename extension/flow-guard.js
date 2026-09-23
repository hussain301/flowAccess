// ============================================================
// FlowAccess — Flow Guard v5 (flow.google.com)
// Features: Fake credits badge, projects blur, save project,
//           sign-out block, account hide, keyboard block
// ============================================================

(() => {
    'use strict';

    let fakeBalance = 45000;
    let lastDeductTime = 0;
    let fakeModelName = '';
    let savedProjectUrl = null;

    const creditMap = {
        'Gemini 2.0 Flash': 30, 'Gemini 1.5 Pro': 80,
        'Gemini 1.5 Flash': 20, 'Gemini 2.5 Pro': 150,
        'Imagen 3': 100, 'Veo 2': 200, 'default': 50
    };

    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(['fakeBalance', 'savedProjectUrl'], r => {
            if (r.fakeBalance !== undefined) fakeBalance = r.fakeBalance;
            if (r.savedProjectUrl) savedProjectUrl = r.savedProjectUrl;
        });
    }

    // ============================
    // CSS
    // ============================
    const style = document.createElement('style');
    style.textContent = `
        /* --- Fake Credit Badge --- */
        #fa-credit-badge {
            position: fixed !important;
            top: 10px !important;
            right: 180px !important;
            background: linear-gradient(135deg, #1a1a2e, #16213e) !important;
            color: #4ade80 !important;
            padding: 6px 16px !important;
            border-radius: 20px !important;
            font-family: 'Google Sans', Roboto, sans-serif !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            z-index: 999999 !important;
            border: 1px solid rgba(74,222,128,0.3) !important;
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
            user-select: none !important;
            pointer-events: none !important;
        }

        /* --- Blurred Project Card --- */
        [data-fa-blur="true"] {
            filter: blur(12px) saturate(0.3) !important;
            pointer-events: none !important;
            user-select: none !important;
            opacity: 0.5 !important;
            position: relative !important;
            overflow: hidden !important;
        }
        [data-fa-blur="true"]::after {
            content: "🔒" !important;
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            font-size: 32px !important;
            z-index: 10 !important;
            filter: none !important;
            opacity: 1 !important;
            pointer-events: none !important;
        }

        /* --- Save Button --- */
        #fa-save-btn {
            position: fixed !important;
            bottom: 20px !important;
            right: 20px !important;
            background: #1a73e8 !important;
            color: #fff !important;
            border: none !important;
            padding: 10px 20px !important;
            border-radius: 24px !important;
            font-family: 'Google Sans', sans-serif !important;
            font-size: 14px !important;
            font-weight: 500 !important;
            cursor: pointer !important;
            z-index: 999999 !important;
            box-shadow: 0 4px 12px rgba(26,115,232,0.4) !important;
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
        }
        #fa-save-btn:hover { background: #1557b0 !important; transform: translateY(-2px) !important; }
        #fa-save-btn.saved { background: #0d9488 !important; }

        /* --- Hide Sign-out --- */
        [data-fa-hidden] { display:none!important; pointer-events:none!important; height:0!important; overflow:hidden!important; }

        /* --- Hide Account Switcher / Google Apps --- */
        a.switch-account-link,
        a[href*="AccountChooser"], a[href*="AddSession"],
        a[href*="accounts.google.com"], a[href*="myaccount.google"],
        [aria-label="Google apps"], [aria-label="Google Account"] { display:none!important; }

        /* --- Hide Credit Banner (original) --- */
        flow-credit-banner, .credit-banner { display:none!important; }

        /* --- Upsell Link Fake --- */
        a.upsell-link { pointer-events:none!important; }
        a.upsell-link span.mdc-button__label { font-size:0!important; }
        a.upsell-link span.mdc-button__label::after {
            content:'Google Ultra Plan 20x'!important; font-size:14px!important; color:#000!important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);

    // ============================
    // 1. FAKE CREDIT BADGE
    // ============================
    function showCreditBadge() {
        let badge = document.getElementById('fa-credit-badge');
        if (!badge && document.body) {
            badge = document.createElement('div');
            badge.id = 'fa-credit-badge';
            document.body.appendChild(badge);
        }
        if (badge) badge.innerHTML = `💎 <span>${fakeBalance.toLocaleString()}</span> credits`;
    }

    function deductCredits() {
        const now = Date.now();
        if (now - lastDeductTime < 3000) return;
        const cost = creditMap[fakeModelName] || creditMap['default'];
        fakeBalance = Math.max(0, fakeBalance - cost);
        lastDeductTime = now;
        showCreditBadge();
        if (typeof chrome !== 'undefined' && chrome.storage) chrome.storage.local.set({ fakeBalance });
    }

    // ============================
    // 2. BLUR OTHER PROJECTS (ONLY on home page https://flow.google.com/)
    // ============================
    function blurOtherProjects() {
        const path = window.location.pathname;
        
        // ONLY blur on home page — nowhere else
        if (path !== '/' && path !== '') {
            // Remove any blur that might exist
            document.querySelectorAll('[data-fa-blur]').forEach(el => el.removeAttribute('data-fa-blur'));
            return;
        }

        // Find all project links/cards on home gallery
        const projectLinks = document.querySelectorAll('a[href*="/project/"]');
        
        projectLinks.forEach(link => {
            const href = link.getAttribute('href') || '';
            // Find the visual card container (walk up a few levels)
            let card = link;
            for (let i = 0; i < 4; i++) {
                if (card.parentElement && card.parentElement !== document.body) {
                    card = card.parentElement;
                } else break;
            }

            // Don't blur "New project" card
            const text = (card.textContent || '').toLowerCase();
            if (text.includes('new project')) {
                card.removeAttribute('data-fa-blur');
                return;
            }

            // Don't blur our saved project
            if (savedProjectUrl) {
                const projectId = savedProjectUrl.split('/project/')[1];
                if (projectId && href.includes(projectId)) {
                    card.removeAttribute('data-fa-blur');
                    return;
                }
            }

            // Blur this project
            card.setAttribute('data-fa-blur', 'true');
        });
    }

    // ============================
    // 3. SAVE PROJECT BUTTON
    // ============================
    function showSaveButton() {
        if (document.getElementById('fa-save-btn')) return;
        const url = window.location.href;
        if (!/\/project\/[a-zA-Z0-9_\-]+/i.test(url)) return;
        if (!document.body) return;

        const cleanUrl = getCleanUrl(url);
        const btn = document.createElement('button');
        btn.id = 'fa-save-btn';

        if (savedProjectUrl === cleanUrl) {
            btn.innerHTML = '✅ Project Saved';
            btn.classList.add('saved');
        } else {
            btn.innerHTML = '💾 Save Project';
        }

        btn.onclick = () => {
            savedProjectUrl = cleanUrl;
            if (typeof chrome !== 'undefined' && chrome.storage) chrome.storage.local.set({ savedProjectUrl: cleanUrl });
            navigator.clipboard.writeText(cleanUrl).catch(() => {});
            btn.innerHTML = '✅ Saved & Copied!';
            btn.classList.add('saved');
            setTimeout(() => { btn.innerHTML = '✅ Project Saved'; }, 2000);
        };
        document.body.appendChild(btn);
    }

    function getCleanUrl(url) {
        try {
            const p = new URL(url);
            const m = p.pathname.match(/\/project\/[a-zA-Z0-9_\-]+/i);
            return m ? `${p.origin}${m[0]}` : url;
        } catch(e) { return url; }
    }

    // ============================
    // 4. SIGN-OUT PURGE
    // ============================
    function purgeSignout() {
        document.querySelectorAll('button, a, span, div, p, [role="menuitem"]').forEach(el => {
            if (el.children.length > 5) return;
            const t = (el.textContent || '').trim().toLowerCase();
            if (t === 'sign out' || t === 'log out' || t === 'switch account' || 
                t === 'add another account' || t === 'manage your google account' ||
                t.includes('sign out')) {
                el.setAttribute('data-fa-hidden', '1');
                const mi = el.closest('[role="menuitem"]') || el.closest('flow-menu-item');
                if (mi) mi.setAttribute('data-fa-hidden', '1');
            }
        });
    }

    // ============================
    // 5. HIDE ACCOUNT INFO
    // ============================
    function hideAccount() {
        document.querySelectorAll('img').forEach(img => {
            if ((img.src || '').includes('googleusercontent.com')) {
                img.style.visibility = 'hidden';
                img.style.opacity = '0';
            }
        });
        document.querySelectorAll('div, span').forEach(el => {
            if (el.children.length > 2) return;
            const t = (el.textContent || '').trim();
            if (t.match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/) && el.tagName !== 'INPUT') {
                el.style.color = 'transparent';
                el.style.fontSize = '0';
            }
        });
    }

    // ============================
    // 6. KEYBOARD BLOCK
    // ============================
    document.addEventListener('keydown', e => {
        if (e.key === 'F12' || e.keyCode === 123 ||
            (e.ctrlKey && e.shiftKey && [73,74,67].includes(e.keyCode)) ||
            (e.ctrlKey && e.keyCode === 85)) {
            e.preventDefault(); e.stopImmediatePropagation(); return false;
        }
    }, true);
    document.addEventListener('contextmenu', e => { e.preventDefault(); }, true);

    // ============================
    // 7. CLICK INTERCEPT
    // ============================
    document.addEventListener('click', e => {
        const t = e.target.closest('a, button, [role="menuitem"]');
        if (!t) return;
        const href = (t.getAttribute('href') || '').toLowerCase();
        const txt = (t.textContent || '').toLowerCase();
        if (href.includes('logout') || href.includes('signout') || href.includes('accounts.google.com') ||
            txt.includes('sign out') || txt.includes('switch account')) {
            e.preventDefault(); e.stopImmediatePropagation(); return false;
        }
        deductCredits();
    }, true);

    // ============================
    // 8. PERIODIC ENFORCEMENT
    // ============================
    setInterval(() => {
        showCreditBadge();
        purgeSignout();
        hideAccount();
        blurOtherProjects();

        // Auto-detect model
        document.querySelectorAll('button').forEach(b => {
            const t = (b.textContent || '').trim();
            if (t.match(/^(Gemini|Imagen|Veo)\s/) && t.length < 40) fakeModelName = t;
        });
    }, 2000);

    // ============================
    // 9. DEVTOOLS DETECTION
    // ============================
    setInterval(() => {
        const t = Date.now(); debugger;
        if (Date.now() - t > 100) { try { window.location.href = 'about:blank'; } catch(e) {} }
    }, 2000);

    // ============================
    // INIT
    // ============================
    function init() {
        showCreditBadge();
        showSaveButton();
        purgeSignout();
        hideAccount();
        blurOtherProjects();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else init();
    window.addEventListener('load', () => setTimeout(init, 1500));

    // SPA navigation
    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            const old = document.getElementById('fa-save-btn');
            if (old) old.remove();
            setTimeout(init, 1000);
        }
    }, 500);

    console.log('[FlowAccess] Flow Guard v5 active');
})();
