# Flux Control

Remote control app. Rust backend, Electron frontend, black and white (dark) theme.
The installer is a tiny Rust exe (wry/WebView2) that downloads Node.js and Electron on first run, so it stays small.

## UI rule: nothing is default

Every control the user can see or touch must be our own design. No browser or OS default look, ever.

Forbidden (the `npm run check-ui` script fails on these):
- native scrollbars. Use `fx.scroll()` / `.fx-scroll`; the native bar stays hidden in all containers.
- `<select>`, `<option>`, `<datalist>`. Use `.fx-select`.
- `<input type=range|checkbox|radio|file|number|date|time|color>`. Use `.fx-slider`, `.fx-toggle`, `.fx-card`.
- `<textarea>`, and text/password inputs without class `fx-input` inside a `.fx-field`.
- `alert()`, `confirm()`, `prompt()`, `<dialog>`, native tooltips (`title=`). Use `fx.toast()` and our own modals.
- default focus rings, default `button` styling, default text selection colour, default cursors on custom controls.

Shared pieces live in `shared/controls.js` and `shared/style.css` (used by the installer and the PC client). Add new controls there first, then use them.

## Look
- Palette: near-black `#050505`, panels `#0c0c0c`, hairlines `#1f1f1f`, text `#f5f5f5`, muted `#8a8a8a`. White is the only accent.
- Rounded corners everywhere (12px controls, 20px+ cards and windows).
- Every state change animates (200-600ms, ease-out). Screens fade/slide, never snap.

## Layout
- `shared/`     design system (`style.css`, `controls.js`) and the connection code format (`code.js`)
- `installer/`  Rust setup app + its HTML UI (`installer/ui/`)
- `app/`        Electron PC client: connect, share, session view (`viewer.js` plays the stream and sends input), Claude chats (`claude-main.js` runs the Claude Code CLI; custom AIs speak any OpenAI-compatible API)
- `host/`       Rust sharing backend `flux-host.exe` (screen capture, H.264, WebSocket server, input, tunnels). Electron starts it
- Web client: `web/`, embedded in `flux-host.exe` and served by it — password, the session viewer and the Executor (with its AI mode) in a browser. The pillbar has an apps button: list of open apps on that PC with Close and Front (front moves the window onto the screen the viewer watches). A banner warns when the focused app is elevated (Windows blocks input into it) with a one-click restart of Flux Control as administrator (`apps:elev`, `--elev` argv makes the relaunch wait for the old instance's lock)
- `tools/check-ui.js`  enforces the rule above; `tools/test-code.js` tests the code format; `tools/test-host.js` runs the host end to end
