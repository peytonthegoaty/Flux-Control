# Flux Control

Remote control app: Rust backend, Electron frontend, black and white theme.

## Setup app (this milestone)

`installer/` is a ~2 MB Rust exe that shows the setup wizard (WebView2) and downloads Node.js and Electron into `%LOCALAPPDATA%\FluxControl` on demand.

```
cd installer
cargo build --release          # target/release/flux-setup.exe
flux-setup.exe --simulate      # demo mode: fake dependency results, no downloads
```

- `FLUX_HOME` overrides the install folder.
- `flux-setup.exe --selftest` runs the real installers headlessly and writes `selftest.txt` in the install folder.
- Edit the wizard in `installer/ui/` and preview it in any browser (`python -m http.server` in that folder); the exe embeds those files at build time.
- `npm run check-ui` enforces the "nothing is default" rule from `CLAUDE.md`.

Built and in: the web client, the Rust streaming backend and the AI chats (Claude Code + custom AIs).

## Sharing and the PC client

- `host/` is the Rust sharing backend. `cd host && cargo build --release` builds `flux-host.exe`, which the installer embeds (build it first).
- `node tools/test-host.js` runs the host on loopback: wrong password refused, H.264 stream decodes, cursor shape, input injection.
- Run the client from source with any Electron: `electron app` (it finds `host/target/release/flux-host.exe`).
- Codes: `FLUX-...` (see `shared/code.js`). Web links will not use codes.
- AI chats: the Claude page and the Executor's AI mode list the Claude Code chats saved on this PC and can also talk to custom AIs (any OpenAI-compatible base URL + key, added with + AI). Custom-AI chats are kept in `ai-chats.json` in the Flux folder and show up in the same list; the web client uses the same chats through the host relay.

## Releases and updates

- `dist/FluxControl-Setup.exe` is the installer. Launching it checks GitHub (`peytonthegoaty/Flux-Control`, latest release) every time, even when Flux Control is already installed:
  - not installed: the setup wizard. Installed and current: a Launch button. Newer release: "Update now".
  - there is one install folder (`%LOCALAPPDATA%\FluxControl`), so running setup again never adds a second copy.
  - `FluxControlin` is added to the user PATH once (checked case-insensitively before adding), so `flux` starts the app from any terminal.
- Update payload = `flux-control-payload.zip` + `.sha256` on the release. Setup verifies the checksum before touching anything and restores the old app if the swap fails.
- Ship an update: bump `VERSION`, then `node tools/build.js` and `node tools/publish.js "what changed"`.
