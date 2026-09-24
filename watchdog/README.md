# FlowAccess Watchdog

Companion extension for **FlowAccess Tool**. Chrome gives an extension no hook
for its own uninstall — once removed, zero of its code can run, so it can
never wipe its own cookies afterwards. This watchdog closes that hole.

## What it does

- Watches the main extension (**FlowAccess Tool**) via the `management` API.
- The moment the main extension is **uninstalled or disabled**, it:
  1. Wipes the shared session cookies (scoped: `google.com`, `flow.google.com`, `gstatic.com` only — nothing else is touched).
  2. Closes every `flow.google.com` tab.
- Mutual protection: the main extension exempts the watchdog from its
  block-other-extensions enforcement and watches it back — removing
  **either** extension wipes the session immediately, so there is no
  order of removal that bypasses the wipe.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `watchdog/` folder (do this before or together with the main `extension/` folder).
3. The main extension leaves the watchdog enabled (it is exempt from the enforcement sweep).
4. Click the watchdog's toolbar icon to verify: it should say **✅ Watching: FlowAccess Tool**.

## Important contract

- The watchdog finds the main extension **by name** (`FlowAccess Tool`).
  Do not rename either extension, or the watch breaks.
- If the watchdog was ever installed, the main extension treats it as
  **expected**: cookie injection is refused while the watchdog is missing,
  and the dashboard shows "🛡️ Watchdog Required" until it is reinstalled.
