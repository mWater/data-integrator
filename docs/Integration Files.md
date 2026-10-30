# Integration Files

Users upload files (spreadsheets, shapefiles, GeoPackages, CSVs, any document
the code can parse) that an integration reads at run time. Files are stored
with the integration, every version is kept, and uploading a new version
re-runs the integration against it. Once an integration is designed,
replacing its file needs no AI as long as the format is unchanged.

Not in scope: chatting with documents (files never go to the model as
attachments; the agent only sees what its snippets print), sharing one file
across integrations (consume the first integration's output tables via
`inputs` instead), S3 backends for the file store.

## Model

Files work like secrets: the definition declares names, the deployment holds
the contents.

- The definition declares **file slots**: `files: { [slotId]: FileSlotSpec }`,
  with an optional `description` and `accept` list of extensions (`[".xlsx"]`).
- Each slot holds immutable, numbered **versions** (v1, v2, ...), one per upload.
- The code reads the slot read-only at `/in/files/<slotId><ext>`, described in
  `/in/manifest.json` under `files` (path, versionId, version, filename,
  sha256, sizeBytes, uploadedAt).

Definitions stay deployment-independent: a library entry can declare "expects
a water point inventory spreadsheet" and each deployment uploads its own.

## Which version a run uses

Every run carries **pins** (`runs.file_pins`, `{ slotId: versionId }`) fixed
when it is created. For each declared slot, in order:

1. its pin;
2. else the slot's **current** version (`app.file_slots.current_version_id`);
3. else nothing: the run is refused ("Awaiting file upload for slot X"). Over
   HTTP that is a 400 before any run row exists; the scheduler and webhook
   receipts do not enqueue such an integration (webhook events stay buffered).

Pinned versions must match the slot's `accept` list, since they are often
staged with `run=false`, which skips the type check.

There is no "latest upload" fallback: it could silently pick up an abandoned
design-session upload or half of a multi-slot replace. Every path that
introduces a new version pins it.

A version becomes current only by being used in a successful production run:
the success commit sets `current_version_id` for every slot the run read, in
the same transaction that writes the data, so current always matches what
the tables hold. Failed runs commit nothing, so tables keep their last good
data and current does not move. Design-session runs are scratch runs and
never move current. `runs.inputs` (with `files`) is written before the job
starts, so a failed run still records which file it used.

### Pinned runs queue

A run that pins versions starts at once when the integration is idle and
otherwise waits its turn in the run queue. Only one run can be queued per
integration, so when one is already waiting (a cron run, say) the pins are
merged into it and its start time is pulled to now: it would have used the
old current version, and the person uploading wants the new one. The newer
pin for a slot replaces an older one. A plain manual run with no pins is
refused with a 409 while a run is going or waiting.

Operations:

- **Replace**: upload a version with `run=true`; a pinned run starts or
  queues. Other slots use current.
- **Replace several slots** (shapefile plus lookup sheet): upload each with
  `run=false`, then one run pinning all of them. The UI does this as one form.
- **Revert**: a run pinning an older version. Success makes it current.
  Revert means "run today's code on the old file", not a rollback: it fails if
  the code has since been adapted to a newer format, and it restores a table
  exactly because file-backed tables use `replace`.
- **Manual run**: no pins; uses current versions.

Identical re-uploads still create a version and run; the upload is an explicit
user action.

## Storage and retention

`app.file_versions` ([Database.md](Database.md)) holds one row per upload; bytes live in the
file store (`FILE_STORE_PATH`, default `./file-store`) at
`<versionId><ext>`. Paths are built only from the version id and an extension
validated against `^\.[a-z0-9]{1,10}$`; the uploaded filename is display data
only. Keying by version id means a session upload adopted by its integration
(below) never moves bytes.

Every version is kept, including uploads whose runs failed. The integration
page shows bytes stored per slot. For mistakes (a file with personal data
uploaded in error), an admin purges a version:

```
cli.js files list <integrationId>
cli.js files purge <versionId> --by <adminEmail>
```

Purge refuses the current version of any slot and any version a queued or
running run pins or uses, deletes the bytes, and keeps the row (with sha256)
so lineage still resolves. Purged versions cannot be pinned or downloaded.
Deleting an integration deletes its versions and their bytes.

Crash safety: uploads stream into `.tmp` and are renamed into place inside the
insert transaction. Jobs with files get their `/in` directory under `.jobs`,
so versions are hardlinked rather than copied. At boot the server removes
leftovers older than an hour, so another process sharing the store (a CLI
run, a second server) is not disturbed: `.tmp` and `.jobs` entries, and files
named like versions (`<uuid><ext>`) with no live row. It never touches other
names.

## API

See [API.md](API.md) and `/api/openapi.json`:

- `PUT /api/integrations/:id/files/:slot?filename=<name>&run=true|false`
- `PUT /api/sessions/:id/files/:slot?filename=<name>` (design-session staging)
- `GET /api/integrations/:id/files`
- `GET /api/integrations/:id/files/:slot/versions/:versionId/download`
- `POST /api/integrations/:id/run` with optional `{ files: { slotId: versionId } }`

Upload handling:

- Raw body, not multipart: curl-friendly, no multipart parser dependency.
- Every check runs before the body is read, and `Expect: 100-continue` is only
  answered after them, so a refused upload is never sent by a client talking
  to the server directly: role, slot id, and for `run=true` that the
  integration is installed, declares the slot, and accepts the extension.
  Uploads with `run=false` (multi-slot staging) and session uploads skip the
  type check, since a design session may be changing the accepted format; the
  check protects users, not the host.
- The body streams to disk while hashing, cut off past the cap
  (`FILE_UPLOAD_MAX_MB`, default 100) with a 413 and the partial file removed.
  `Content-Length` is not trusted. A client abort and a disk-full write (507)
  also remove the partial file; the upload completes only once its bytes are
  flushed.
- The answer is `201 { version, run }`, where `run` is `{ id, status:
  "running" | "queued" }` or null, with `runError` saying why no run could be
  created (another slot still awaiting its first upload).
- The whole-request deadline for uploads is one hour (the default five minutes
  would cut off large uploads on slow links), with a two minute socket idle
  timeout. Every other request keeps the five minute default.
- A reverse proxy in front of the server must allow the body size. The
  default cap of 100 MB matches the request body limit of common CDN free
  tiers. Some proxies buffer request bodies and answer `100 Continue`
  themselves, so behind them the early refusal saves the server, not the
  sender's bandwidth. The UI says so when a proxy answers 413.

Downloads send `application/octet-stream`, `nosniff`, `Content-Security-Policy:
sandbox`, `Cache-Control: private, no-store`, and an attachment disposition
with an ASCII fallback plus RFC 5987 filename, so uploaded HTML or SVG never
renders on the app's origin.

## Permissions

- Upload, replace, revert, run with pins: editor and admin (cookie or token).
- Download: editor and admin only.
- Viewers see slot descriptions, version numbers, dates, sizes, and which runs
  used each version, but not original filenames or uploader emails, since both
  can carry personal data.
- Design sessions (list, detail, live events) are editor and admin only:
  transcripts carry what the agent saw, including file names and whatever its
  snippets printed of file contents.
- Purge: admin, CLI only.

## Design sessions

The only AI part: building a file-based integration, or adapting one when the
format changes.

- `DesignerState.files` pins the session's file versions. A session on an
  installed integration starts with the versions its latest run used: after a
  failed replacement, the session works with the file that failed.
- The composer attaches files: each uploads to the session staging route, to a
  slot shown in an editable field (defaulting to the declared slot that accepts
  the extension, else the draft's only slot, else the filename in snake_case),
  and the message carries `files: [{ slot, versionId }]`. The server records
  them as session pins and prefixes the message with a note the agent reads,
  e.g. `[Uploaded inventory.xlsx (v2, 4870 bytes) to file slot "inventory";
  snippets and runs see it at /in/files/inventory.xlsx]`. The first message of
  a seeded session gets the same note for the seeded files. Sessions seed only
  live versions; a pin purged later is dropped with a note rather than
  blocking the session, and snippets fall back to the slot's current version.
- Attaching is refused while the agent is mid-turn (the loop owns the session
  state until it pauses); the composer disables it until then.
- **Uploads before the draft exists.** A new session has no integration row
  until the agent's first valid `write_definition`, and the first message is
  often "here is my spreadsheet". Session uploads are therefore owned by the
  session (`file_versions.session_id`, `integration_id` null) and adopted by
  the integration when its draft row is created. Once a row exists, session
  uploads belong to the integration directly.
- Snippets, `run_integration`, and cold runs use the session pins (current for
  other slots). Snippets also see pinned slots the definition does not declare
  yet, so the agent can explore before declaring.
- The cold-run certificate records the file versions the run used; `finish`
  requires them to match what the session would use now. Without this the
  agent could adapt code to a new file but certify against the old one.
- Designer runs are scratch runs (draft schema, never the installed tables),
  so they never make a version current. `finish` therefore installs and then
  starts a production run pinning the certified versions, whenever the
  integration is fresh or any certified version differs from current; if a
  run is in progress it queues, per the rule above. Without this, a fresh
  install would be refused for want of a file, and an adapted integration
  would run its new code against the old file.
- `get_definition` lists the session's files; `write_definition` reports
  session files no slot declares and declared slots with no file.

The designer prompt's Files section tells the agent to check structure first
and fail with a plain-language message naming what was expected and found
(the message a user sees when a replacement has drifted), to use `replace` for
file-backed tables (`merge` never deletes, so rows removed from the file would
persist), to do file work in Python, to read zipped shapefiles in place via
`/vsizip/`, and to reproject to EPSG:4326.

## Runtime image

The Python image carries pinned `openpyxl` (xlsx), `xlrd` (legacy xls), and
`odfpy` (LibreOffice ods) alongside pandas. GDAL covers shapefile, GeoPackage,
KML, CSV, and zip access via `/vsizip/`.

## Security notes

- The host never parses uploaded content: hash, store, materialize. All parsing
  happens in the sandbox, from a read-only `/in`.
- Decompression bombs are bounded by job limits: `/tmp` is a per-job directory
  on disk under the work root, removed after the job and held to its quota
  (`limits.tmpDiskMb`, capped by `TMP_QUOTA_MB`, default 20480 MB); memory is capped,
  `/work` is polled against `workDiskMb`, and `/vsizip/` avoids extraction.
- When the designer uses a cloud model, whatever snippets print leaves the
  deployment.
