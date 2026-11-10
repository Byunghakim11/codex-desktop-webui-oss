# Codex Desktop WebUI

[한국어](README.md) · [MIT License](LICENSE)

A self-hosted Windows WebUI that connects a browser to the **same Codex Desktop engine and conversations**. Keep Desktop open and use its existing sign-in; the WebUI does not silently start a second Codex app-server.

This is an unofficial MIT derivative of [DusuWorks/codex-webui](https://github.com/DusuWorks/codex-webui) and its predecessors. It is not affiliated with or endorsed by OpenAI or the upstream authors. See [NOTICE](NOTICE.md).

## Features

- Shared conversations, streaming, model settings, supported approval decisions and structured question answers.
- Collapsible right-side file tree with read-only text, image and PDF preview and downloads.
- Loaded-conversation search, message/code copying, reviewed Markdown exports, bookmarks and an outline.
- In-tab per-conversation drafts, clear undo, command palette and keyboard help.
- Text search and line navigation, PDF page/zoom/fit controls, reading presets and numeric diagnostics.
- Directory-scoped device tokens and optional Cloudflare Tunnel + Access authentication.
- Optional user-configured companion links, with no preset destinations.

## Install

Requires Windows, Node.js 22.13+, PowerShell 7+ and a signed-in Codex Desktop installation. The native Desktop bridge is Windows-specific; Linux/macOS Desktop bridge compatibility is not claimed.

```powershell
git clone https://github.com/Byunghakim11/codex-desktop-webui-oss.git
cd codex-desktop-webui-oss
npm ci
npm run setup
npm run check
$env:CODEX_WEBUI_TEST_PWSH = (Get-Command pwsh).Source
npm test
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1
```

These steps install and validate the launcher. When other Desktop work is finished and you can quit Desktop, activate it:

```powershell
pwsh -NoProfile -File scripts/install-desktop-bridge.ps1 -Activate
# Fully quit and reopen Codex Desktop
codex-webui qr default
```

The bridge automatically owns one WebUI. Do not start a duplicate server. QR codes contain access tokens: never publish them. See the [Desktop bridge guide](docs/DESKTOP_BRIDGE.md) for installation and recovery.

## Connect and use

Use a separate directory-scoped token per device on a trusted LAN. For internet access, configure HTTPS and an independent identity layer using the [remote-access guide](docs/REMOTE_ACCESS.md). That guide uses reserved examples, not a ready-made hosted service.

Open Tools for conversation actions and the Files edge tab for the right drawer. Outside text inputs, Ctrl/Cmd+K opens the command palette and ? shows help. Configure or clear optional external links in the Apps menu; destinations are local browser preferences and require their own sign-in.

Drafts and bookmarks live in the current tab's memory and disappear on refresh or close. Search covers only currently loaded supported bodies. Native records without trusted classification may be excluded from the new derived tools. PDF preview uses print intent; some layers may differ from a normal viewer. Original downloads remain available.

## Security and release boundary

This public snapshot excludes personal deployment domains, email addresses, chat IDs, local profile paths, operational reports, real screenshots, tokens, uploads and private Git history. Each operator configures their own access. Do not expose the service anonymously or put credentials or authentication screenshots in issues. Read [SECURITY](SECURITY.md) and [architecture](docs/ARCHITECTURE.md).

Tests use temporary data and a fake engine. Passing tests do not certify every Codex version, network or device, or establish absence of all security defects.

## License and contributions

Project code is [MIT licensed](LICENSE). Upstream copyright notices and [dependency licenses](THIRD_PARTY_NOTICES.md) are retained. Codex binaries, models and accounts are not included. See [CONTRIBUTING](CONTRIBUTING.md).