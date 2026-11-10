# Security Policy

Security fixes target the current default branch.

Use GitHub private vulnerability reporting when available. Otherwise contact the maintainer through the private contact method listed on the repository profile. Never publish WebUI tokens, access URLs, Cloudflare assertions, tunnel credentials, OpenAI credentials, conversation content, or local files in an issue.

Codex WebUI is a remote-control surface for a locally signed-in Codex Desktop runtime. Anyone holding a valid WebUI token can act within that token's allowed folders. Use a separate directory-scoped token per device, rotate lost tokens, and keep LAN access on trusted networks.

Internet exposure must use TLS plus an independent identity layer. The supported public route is Cloudflare Tunnel protected by Cloudflare Access and an explicit allowed-email policy. Configure the same allowed email in WebUI with `scripts/configure-cloudflare-access.ps1`; the server validates the signed Access assertion and rejects any email outside its allowlist. Do not use an anonymous, Bypass, or Everyone policy. See `docs/REMOTE_ACCESS.md`.

The project does not provide multi-tenant isolation and must not be exposed as an anonymous public service.
