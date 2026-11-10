# Notice

Codex WebUI is an unofficial derivative project based on the MIT-licensed Codex Mobile / Codex WebUI repository:

- Source: https://github.com/wuluwululang/codex-webui
- Base revision: `a36c4767b829cf54b3a6a7971d9129c4093c3a8e`
- Original copyright: Copyright (c) 2026 Codex Mobile contributors
- License: MIT

The original referenced revision starts an independent `codex app-server` from its WebUI backend. This project replaces that ownership model with a native Windows bridge: Codex Desktop owns the only app-server, while Desktop and WebUI coexist on the same service and authoritative notification stream. Major changes also include bidirectional conversation synchronization, Desktop-bound lifecycle management, workspace browsing and creation, send/guide/queue/stop actions, image-aware steering, rate-limit monitoring, directory-scoped access control, and optional Cloudflare Access integration.

The original and current copyright notices are preserved in `LICENSE`. This repository does not include or redistribute the Codex executable, OpenAI credentials, model weights, conversation data, or internal deployment records.

This project is not officially affiliated with, sponsored by, or endorsed by the original project authors or OpenAI. OpenAI and Codex are trademarks of their respective owners.

## Immediate upstream

This public distribution also derives from the MIT-licensed DusuWorks/codex-webui project: https://github.com/DusuWorks/codex-webui. Its Codex WebUI contributor copyright notice is retained in LICENSE. Private deployment history is not part of this distribution.
