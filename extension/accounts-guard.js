// ============================================================
// FlowAccess — Accounts Guard (accounts.google.com)
// Blocks: sign-out, account switching, account management
// User must NOT be able to see or change the logged-in account
// ============================================================

(() => {
    'use strict';

    // Block the page entirely — redirect back to Flow
    const url = window.location.href.toLowerCase();
    
    // If user is on sign-out or account chooser page, redirect to Flow
    if (url.includes('signout') || url.includes('logout') || 
        url.includes('accountchooser') || url.includes('addsession') ||
        url.includes('removelocalaccount') || url.includes('deauth')) {
        window.location.replace('https://flow.google.com');
        return;
    }

    // If on myaccount or account settings, redirect to Flow
    if (url.includes('myaccount.google.com') || url.includes('accounts.google.com/b/')) {
        window.location.replace('https://flow.google.com');
        return;
    }

    // Block the page visually — blur everything and show message
    const style = document.createElement('style');
    style.textContent = `
        /* Hide everything on accounts page */
        body {
            filter: blur(15px) !important;
            pointer-events: none !important;
            user-select: none !important;
        }
        body::after {
            content: "Access Restricted" !important;
            position: fixed !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            font-size: 24px !important;
            font-family: 'Google Sans', Arial, sans-serif !important;
            color: #fff !important;
            background: rgba(0,0,0,0.8) !important;
            padding: 20px 40px !important;
            border-radius: 12px !important;
            z-index: 999999 !important;
            filter: none !important;
            pointer-events: none !important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);

    // Block keyboard
    document.addEventListener('keydown', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        return false;
    }, true);

    // Block clicks
    document.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        return false;
    }, true);

    // Block forms
    document.addEventListener('submit', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        return false;
    }, true);

    // Redirect after 2 seconds
    setTimeout(() => {
        window.location.replace('https://flow.google.com');
    }, 2000);

    console.log('[FlowAccess] Accounts Guard — Access blocked, redirecting to Flow');
})();
