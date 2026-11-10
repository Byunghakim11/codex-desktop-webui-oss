# Contributing

Thanks for helping improve Codex WebUI. The project already provides a usable native Windows path; contributions that make the experience more reliable, polished, accessible, and easier to maintain are welcome.

## Good areas to contribute

- Mobile layout, touch interactions, accessibility, and visual consistency.
- Compatibility with new Codex Desktop and app-server protocol versions.
- Conversation synchronization, reconnect behavior, guidance, queue, and interruption edge cases.
- Bridge lifecycle, duplicate prevention, diagnostics, and safe recovery.
- Token scope, upload, workspace, Cloudflare Access, and other security boundaries.
- Focused automated tests, documentation, translations, and reproducible bug reports.

For significant UI or architecture changes, open an Issue first and explain the user-visible problem, proposed direction, and compatibility impact. Small, well-scoped fixes may go directly to a Pull Request.

## Development rules

1. Use Node.js 22.13 or newer and PowerShell 7 or newer on Windows.
2. Run `npm install`, `npm run check`, and `npm test` before submitting changes.
3. Keep Pull Requests focused. Explain the problem, the observable result, and how it was validated.
4. Add focused tests for protocol, access-control, synchronization, or lifecycle changes.
5. Never commit tokens, access URLs, uploads, logs, PID files, conversation data, Cloudflare assertions, tunnel credentials, OpenAI credentials, local paths, or internal deployment records.

## Architectural boundary

Preserve the single-writer coexistence design: WebUI shares the Desktop-owned app-server through the authenticated local bridge. It must not silently start a competing app-server, patch the Codex executable, or expose raw app-server traffic to the LAN or internet.

Contributions are provided under the repository's MIT License. Contributors must have the right to submit their changes.
