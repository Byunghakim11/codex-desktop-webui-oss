# Reliability and responsiveness review

The 0.2.0 implementation was reviewed through three separate read-only requests
whose returned model was `gpt-6-astra`. The initial review identified ten control-flow
and performance findings. A second pass identified five remaining boundary cases;
the final focused pass found no new or unresolved P1/P2 in those five fixes.
This is code-review evidence, not a formal security certification or a production
availability guarantee.

## Changes

- Browser connections have bounded upgrade and heartbeat deadlines, one reconnect
  owner, jittered backoff and foreground/online recovery. Transient transport failure
  preserves credentials; confirmed authentication failure stops automatic attempts.
- RPCs have bounded pending counts and deadlines. Sent mutations and answers with
  lost acknowledgements are reported as unconfirmed and are never replayed by reconnect.
- The local bridge has a bounded handshake, cleanup for rejected/old connections,
  request limits and negotiated reply-route abandonment. Unknown late replies are
  discarded rather than forwarded into Desktop's response channel.
- Broker stream failures remain local to their request or peer. Producer/drain flow
  control and per-pipe output limits prevent a stalled consumer from accumulating
  unlimited output. Large valid frames have a bounded drain grace period.
- Native settings are read again after reconnect. Navigation revision, native bridge
  epoch and task identity prevent an earlier refresh from replacing current settings.
  Passive resume pagination is bounded and does not grant caller model/permission overrides.
- Conversation creation completes independently of the slower sidebar manifest.
  Metadata-only scoped reads reuse the same fresh authorization result; authorization
  is not replaced by a time-based cache.
- Canceled file requests stop dependent work after any uncancelable native read
  finishes. Handles, leases, directory iterators and active slots retain explicit owners.
- Late editor-open results and errors cannot replace a newer editor. Save/Reload
  responses cannot discard text entered while the request was pending.

## Verification

The Windows candidate's complete automated run contained 636 tests: 634 passed,
two were conditionally skipped, and none failed. Focused regressions exercise
half-open sockets, handshake hangs, late routing, abandoned replies, output budgets,
stale settings, cancellation, and typed uncertain delivery.

An isolated real-browser test restarted only its temporary WebUI three times while
keeping the same fake native engine. It retained the selected conversation, composer
draft, uploaded pending file and typed question answer. A native permission change
during the outage was read back; the final answer reached the fake engine once and
no chat submission was replayed. Observed recovery was about 1.2–1.5 seconds with a
deliberately delayed sidebar manifest. These are local isolated measurements, not
company-network or remote-service latency claims.

Windows filesystem/browser checks also cover late successful and failed editor opens,
version conflicts, a fresh confirmed Reload, UTF-8/BOM/newline preservation, folder
creation, original-byte upload/download and collision preservation. The native writer
uses a durable recovery copy but does not promise power-failure atomic replacement.

## Adoption and limits

Copying source is insufficient to prove the running build adopted it. Bridge process
changes require a controlled Desktop restart after other work has finished. Preserve
runtime data and verify the authenticated bridge, build and expected processes afterward.
Never stop an unrelated broker, engine, tunnel or companion service to pass a test.

Actual native catalog availability depends on the installed version and account.
Native pending approval is not completion. Network policy, Access expiration, provider
authentication and external MCP failures require their own evidence and cannot be
fixed by claiming reconnect is infallible. See [the manual checklist](release-checklist.md).
