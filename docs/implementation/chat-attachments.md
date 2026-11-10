# General chat attachments

The composer accepts ordinary files as well as images. Images keep the existing
native `localImage` route. Other formats are stored byte-for-byte in the private
runtime data directory and supplied to the shared Desktop engine as managed file
references in a normal text input. The installed native protocol has no generic
`file` or `localFile` input variant.

Uploading a file and reading its contents are separate operations. The WebUI does
not execute Office macros, unpack archives, convert documents, or synthesize a
file analysis. Codex uses its existing tools and permission profile to read the
original file. A format may need a compatible tool; suffix-sensitive readers can
open the managed blob through a binary file handle, using the original filename
to determine the format.

## Limits and authorization

- 25 MiB per file, 20 files and 100 MiB per draft.
- 256 MiB per principal and 1 GiB total runtime storage.
- At most two concurrent uploads globally and one per draft.
- Unsent uploads expire after 24 hours; sent uploads are retained for seven days.
  Expired, unleased files are reclaimed before a subsequent upload.
- Owner, token scope, canonical workspace, draft and actual chat bindings are
  checked again before native dispatch. Browser input cannot choose a stored path.
- Uploads use opaque server filenames and never replace project files.
- Authenticated mutations require a non-simple request header; no cross-origin
  CORS or preflight grant is provided.

The existing native permission profile remains authoritative. A managed file
reference does not grant filesystem permissions. Runtime files trust the local
operating-system account; this is not isolation against a hostile process already
able to write the same private data directory.

## Delivery and recovery

Ordinary sends, guidance to an active turn and queued submissions use the same
server-side attachment expansion. Failed uploads retain the selection and provide
retry/removal. Uncertain native delivery is retained and never automatically sent
again. The delivery-status control can reconcile a recorded acknowledgement.
Native acceptance and response delivery are not an exactly-once guarantee.

Internal managed-reference blocks are stripped from WebUI transcripts, clipboard
copies and exports. Safe original names and authenticated download buttons remain visible. The native Desktop chat
itself receives the local reference needed by its tools.

The store is single-writer. Do not run multiple production WebUI instances against
one runtime data directory. Pending file selections belong to the current tab;
restoring an unsent selection after closing/reloading that tab is not implemented.

## Verification boundaries

Unit and integration tests cover byte preservation, quotas, cancellation,
cross-scope/draft/chat rejection, tampering, restart recovery, normal/guidance/queue
serialization, uncertain delivery and display redaction. Browser validation uses
synthetic files and a fake shared bridge, including original-byte XLSX downloads.
A separate native read gate delivered synthetic managed XLSX/PDF/text references
to an existing Desktop chat and read their actual contents with the existing tools,
including binary handles for managed `.blob` files. That gate verifies the native
reference/read path; it does not independently prove every browser upload or remote
company-network operation. Production adoption and remote validation remain distinct.
