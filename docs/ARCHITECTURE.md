# Architecture

## Core route

```text
Codex Desktop
    | stdio JSON-RPC
Desktop bridge launcher and broker
    | authenticated local named pipe
Codex WebUI server
    | authenticated HTTP and WebSocket
Owner-controlled browser
```

The broker launches the real `codex app-server` once and multiplexes request IDs and notifications between Desktop and WebUI. Both surfaces therefore share one authoritative conversation service. WebUI fails closed when the Desktop bridge is unavailable instead of starting a competing app-server.

## Relationship to the original repository

The referenced original revision starts its own `codex app-server` over stdio from the WebUI backend. This project intentionally removes that independent-owner model. Codex Desktop owns the only app-server process; the bridge multiplexes Desktop and WebUI traffic, and both clients consume the same authoritative notifications. The change is architectural, not only visual: every synchronized conversation, turn, approval, setting, queue, interruption, and rate-limit value comes from the Desktop-owned service.

## Responsibilities

- Desktop and app-server own Codex authentication, conversations, turns, approvals, queues, settings, and rate-limit state.
- The bridge owns local request routing, notification fan-out, duplicate prevention, and Desktop-bound WebUI lifecycle.
- The WebUI server owns browser authentication, method allowlisting, workspace scoping, uploads, and local-file access checks.
- The frontend owns responsive presentation, optimistic rendering, authoritative reconciliation, caching, and mobile send/guide/queue/stop interactions.

Runtime secrets, uploads, usage data, logs, and PID files live under `CODEX_WEBUI_DATA_DIR`, outside the source tree. The browser receives a project token, not an OpenAI credential.

## Compatibility boundary

The app-server protocol is the Codex integration surface. The Windows launcher uses the user-level `CODEX_CLI_PATH` setting to place the broker in Desktop's launch path and then delegates to the real Codex executable. It does not patch the AppX installation, inject code, modify the Codex executable, or redistribute it. This startup adapter is maintained by this project and may require updates after Desktop changes.
