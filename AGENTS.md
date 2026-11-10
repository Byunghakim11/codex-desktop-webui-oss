# Codex WebUI contributor guide

## Setup requests

When a user asks to install or set up this repository:

1. Verify Node.js 22.13+ and npm are available.
2. Run `npm install`.
3. Run `npm run setup` to verify Codex availability, initialize the local token store, and install the global `codex-webui` command.
4. Follow `docs/DESKTOP_BRIDGE.md`, install the Desktop bridge launcher with `pwsh -NoProfile -File scripts/install-desktop-bridge.ps1`, and run `npm test`.
5. Do not activate the launcher or restart Codex Desktop without user authorization. Once the launcher is active, Desktop bridge automatically starts one WebUI when its port is free and stops only the child it owns; do not launch a duplicate. Use `npm start` or `scripts/start-codex-webui.ps1 -Foreground` only for explicit manual operation or validation.
6. Generate the selected token's LAN QR code with the token manager, report the LAN URL privately, and tell the user to scan the QR code. Never commit or broadly repeat its token-bearing URL.
7. Report the absolute Codex WebUI repository path. Explicitly state that setup does not register a Codex local project, because the installation task may belong to another project. Tell the user to open the reported folder with `Ctrl+O` in the Codex desktop app.

Do not require an OpenAI API key. Codex WebUI uses the local `codex app-server` and its existing Codex sign-in.

## Runtime data

Secrets, usage statistics, uploads, inline images, logs, and PID files belong in `CODEX_WEBUI_DATA_DIR`. Never move them into tracked files. The default is `%LOCALAPPDATA%\CodexWebUI` on Windows and `$XDG_DATA_HOME/codex-webui` (or `~/.local/share/codex-webui`) elsewhere.

## Token tasks

Use the installed `codex-webui` command, or run `node scripts/token-manager.js` from this repository. Do not edit `tokens.json` directly and do not expose raw tokens unless the user explicitly requests a URL or QR code. This project does not bundle or install a Codex skill; token management is an ordinary local CLI operation.

## Validation

Run `npm test` after source changes. Run `npm run check` for syntax-only verification. For server changes, use a temporary `CODEX_WEBUI_DATA_DIR` and non-default `PORT` so validation cannot alter the user's live tokens or service.
