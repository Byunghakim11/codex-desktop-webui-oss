# WebUI 0.2.0 verification checklist

Use a disposable conversation and synthetic files for destructive or state-changing checks.
The WebUI connects to the existing Desktop broker and engine. Catalog availability depends
on the installed Codex version, account and native services. A catalog error is not a
successful action. Native approval pending is not completion.

1. Check the visible version/build in the header. Choose English or 한국어 without a reload.
2. Open a conversation, type a draft, change language and verify the draft remains unchanged.
3. Right-click a conversation; test favorites, native pin/unpin and read/unread. Favorites
   are browser state; native pinning is a separate action in Codex.
4. Right-click a message; test copy and its bookmark controls. Confirm the bookmark list
   points back to the correct message in this conversation.
5. Use the `+` beside a project. Confirm the new draft uses that project's directory.
6. Open and hide the right Files drawer using its edge handle and header button.
7. Create a folder, select it, upload a synthetic file, then drop another file on the folder.
8. Upload the same filename again. Confirm the original bytes remain unchanged.
9. Open/download a generated file. Check the browser's downloaded bytes and filename.
10. Edit a UTF-8 Markdown file and explicitly save, including Ctrl/Cmd+S. Confirm the
    original BOM/newline style is preserved where supported.
11. Modify the same file outside the editor. Save must report a conflict and retain the
    unsaved buffer. A confirmed Reload must read fresh native content. Cancel a dirty
    close; after an interruption, use the retained-buffer download when offered.
12. Upload a synthetic XLSX/PDF/text file in the composer and ask Codex to read a value
    from it. Download the sent attachment from the conversation and compare original bytes.
13. Type `/` and `@`; choose a command or project file with mouse/keyboard. Selection must
    not automatically send a chat message. Email addresses/code fences must not trigger `@`.
14. On the disposable conversation, test native Goal controls and native Loop creation,
    pause/resume and removal. Loops are scheduled by Codex; the list explicitly covers only
    known loops. Unknown delivery must retain its original intent, never automatically retry.
15. Test native conversation fork, project membership, archive/unarchive and an immutable
    share snapshot. Review full-history privacy before confirming share. Permanent deletion
    includes child conversations and may still require approval in Codex Desktop.
16. Inspect plan modes, conversation memory, MCP, skills and plugins in Codex tools. Plan
    changes preserve the current model/effort and use the selected mode's built-in instructions.
    Memory changes, inline code review and history compaction require explicit confirmation;
    they must refuse a busy conversation. Account-dependent unavailable catalogs must report
    that condition rather than showing successful results.

## Verification boundaries

Automated tests use temporary data and isolated fake chat engines. Windows native file tests
exercise the real filesystem helper. Browser tests exercise rendered controls and original-byte
downloads. These do not replace a real remote/company-network trial or manual native mutation
checks in Desktop. No test should delete, share, fork or change a real user's conversation.

## Runtime adoption

Record the adopted source build, WebUI PID, existing broker/engine PIDs and authenticated health
before/after deployment. Stop only the verified WebUI process. Keep rollback source and existing
runtime data. `restart-webui-only.ps1` supports an explicitly verified file-token/default-pipe
environment; it does not recover an arbitrary old process's environment. Do not pass its
`-FileConfigurationVerified` switch without proving those preconditions.
