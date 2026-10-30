import { useCallback, useEffect, useRef, useState } from "react"
import {
  FileSlotListing,
  FileSlotSpec,
  FileVersionListing,
  fileVersionUrl,
  listIntegrationFiles,
  startRun,
  uploadIntegrationFile
} from "./api.js"
import { formatDateTime, localizeData } from "./localization.js"
import type { LocalizedString } from "ez-localize"

/** Bytes as "4.8 MB", "512 KB", "120 B". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** "v3, inventory.xlsx, 4.8 MB, 12 Oct 2026 14:02" (the filename only when the viewer may see it). */
function versionLine(version: FileVersionListing): string {
  return [`v${version.version}`, version.filename, formatBytes(version.sizeBytes), formatDateTime(version.uploadedAt)]
    .filter(Boolean)
    .join(", ")
}

/** What happened to the run an upload or a version pick asked for. */
function runOutcome(run: { status: "running" | "queued" } | null, runError?: string): string {
  if (runError) return T`No run was started: ${runError}`
  if (!run) return ""
  return run.status === "running" ? T`A run reading it has started.` : T`A run reading it is queued behind the run in progress.`
}

/** Props for the files panel. */
interface FilesSectionProps {
  /** Integration whose files these are */
  integrationId: string
  /** Declared slots from the installed definition */
  declared: Record<string, FileSlotSpec>
  /** False for viewers: listing only, no uploads, downloads, or runs */
  canDesign: boolean
  /** Drafts cannot run yet, so replacing their files here is disabled */
  isDraft: boolean
  /** Changes whenever the run history does, so the listing (current versions, lineage) refreshes */
  runsKey: string
  /** Refetches the integration detail after an upload or run starts */
  onChanged: () => void
}

/**
 * The integration's uploaded files (docs/Integration Files.md): per slot, the
 * current version and its history. Replacing a file uploads a new version
 * and runs the integration against it; an older version can be run again
 * (a revert, which succeeds only if today's code still reads that format);
 * several slots can be replaced together in one run.
 */
export function FilesSection({ integrationId, declared, canDesign, isDraft, runsKey, onChanged }: FilesSectionProps) {
  const [slots, setSlots] = useState<FileSlotListing[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [maxUploadMb, setMaxUploadMb] = useState<number | null>(null)

  const reload = useCallback(() => {
    listIntegrationFiles(integrationId).then(
      result => {
        setSlots(result.slots)
        setMaxUploadMb(result.maxUploadMb)
      },
      err => setError(err instanceof Error ? err.message : String(err))
    )
  }, [integrationId])

  useEffect(reload, [reload, runsKey])

  /** Refusal for a file over the server's limit, before any byte is sent; null when it fits. */
  function tooLarge(file: File): string | null {
    if (maxUploadMb === null || file.size <= maxUploadMb * 1024 * 1024) return null
    return T`${file.name} is ${formatBytes(file.size)}; this server accepts files up to ${maxUploadMb} MB.`
  }

  /** Uploads one replacement and runs the integration against it. */
  async function replace(slotId: string, file: File) {
    setError(tooLarge(file))
    setNotice(null)
    if (tooLarge(file)) return
    setBusy(T`Uploading ${file.name}…`)
    try {
      const result = await uploadIntegrationFile(integrationId, slotId, file, true, fraction =>
        setBusy(T`Uploading ${file.name}… ${Math.round(fraction * 100)}%`)
      )
      setNotice(`${T`Uploaded v${result.version.version} of ${slotId}.`} ${runOutcome(result.run, result.runError)}`)
      reload()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  /** Runs today's code against an older version; success makes it current. */
  async function runVersion(slotId: string, version: FileVersionListing) {
    if (busy !== null) return
    setError(null)
    setNotice(null)
    setBusy(T`Starting a run with v${version.version} of ${slotId}…`)
    try {
      const started = await startRun(integrationId, { [slotId]: version.id })
      setNotice(
        started.status === "running"
          ? T`A run reading v${version.version} of ${slotId} has started.`
          : T`A run reading v${version.version} of ${slotId} is queued behind the run in progress.`
      )
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const declaredIds = Object.keys(declared)
  if (declaredIds.length === 0 && (slots?.length ?? 0) === 0) return null
  const canChange = canDesign && !isDraft

  return (
    <section className="panel files-panel" aria-label={T`Files`}>
      <div className="files-head">
        <h2>{T`Files`}</h2>
        <span className="dim">
          {isDraft
            ? T`Finish the design session before replacing files here.`
            : T`Each upload is kept as a new version; uploading one runs the integration against it.`}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      {busy && <p className="dim" role="status">{busy}</p>}
      {notice && <p className="dim" role="status">{notice}</p>}
      {slots === null ? (
        <p className="dim">{T`Loading…`}</p>
      ) : (
        slots.map(slot => (
          <SlotRow
            key={slot.slotId}
            integrationId={integrationId}
            slot={slot}
            canDesign={canDesign}
            canChange={canChange && slot.declared}
            idle={busy === null}
            onReplace={file => void replace(slot.slotId, file)}
            onRunVersion={version => void runVersion(slot.slotId, version)}
          />
        ))
      )}
      {canChange && slots !== null && declaredIds.length > 1 && (
        <ReplaceSeveral
          integrationId={integrationId}
          slotIds={declaredIds}
          declared={declared}
          disabled={busy !== null}
          maxUploadMb={maxUploadMb}
          onBusy={setBusy}
          onDone={(message, failed) => {
            if (failed) setError(message)
            else setNotice(message)
            reload()
            onChanged()
          }}
        />
      )}
    </section>
  )
}

/** Props for one slot's row. */
interface SlotRowProps {
  /** Owning integration */
  integrationId: string
  /** The slot with its versions */
  slot: FileSlotListing
  /** Editors and admins see filenames and may download */
  canDesign: boolean
  /** Replace and run actions are available */
  canChange: boolean
  /** No upload or run request is in flight, so actions are enabled */
  idle: boolean
  /** Uploads a replacement */
  onReplace: (file: File) => void
  /** Runs an older version again */
  onRunVersion: (version: FileVersionListing) => void
}

/** One slot: what it expects, its current version, and its history. */
function SlotRow({ integrationId, slot, canDesign, canChange, idle, onReplace, onRunVersion }: SlotRowProps) {
  const input = useRef<HTMLInputElement>(null)
  const current = slot.versions.find(v => v.current) ?? null
  const description = slot.description ? localizeData(slot.description as LocalizedString) : null
  return (
    <div className="files-slot">
      <div className="files-slot-main">
        <div className="grow">
          <div>
            <b>{slot.slotId}</b>
            {!slot.declared && <span className="chip">{T`no longer declared`}</span>}
            {slot.accept && <span className="dim"> {slot.accept.join(", ")}</span>}
          </div>
          {description && <div className="dim">{description}</div>}
          <div>
            {current ? (
              <>
                {T`Current:`} {versionLine(current)}
              </>
            ) : slot.versions.length > 0 ? (
              T`No version has been read by a successful run yet.`
            ) : (
              T`Awaiting its first upload; runs wait until one arrives.`
            )}
          </div>
        </div>
        {canChange && (
          <>
            <input
              ref={input}
              type="file"
              hidden
              accept={slot.accept?.join(",")}
              onChange={event => {
                const file = event.target.files?.[0]
                event.target.value = ""
                if (file) onReplace(file)
              }}
            />
            <button onClick={() => input.current?.click()} disabled={!idle}>
              {current ? T`Replace…` : T`Upload…`}
            </button>
          </>
        )}
      </div>
      {slot.versions.length > 0 && (
        <details className="files-history">
          <summary>
            {T`History`}{" "}
            <span className="dim">
              (
              {slot.versions.length === 1
                ? T`1 version, ${formatBytes(slot.bytesStored)} stored`
                : T`${slot.versions.length} versions, ${formatBytes(slot.bytesStored)} stored`}
              )
            </span>
          </summary>
          <table className="sessions">
            <thead>
              <tr>
                <th>{T`Version`}</th>
                <th>{T`Uploaded`}</th>
                <th>{T`Size`}</th>
                {canDesign && <th>{T`File`}</th>}
                {canDesign && <th>{T`By`}</th>}
                <th>{T`Runs`}</th>
                {canDesign && <th />}
              </tr>
            </thead>
            <tbody>
              {slot.versions.map(version => (
                <tr key={version.id}>
                  <td>
                    v{version.version} {version.current && <span className="chip chip-succeeded">{T`current`}</span>}
                    {version.purgedAt && <span className="chip">{T`purged`}</span>}
                  </td>
                  <td>{formatDateTime(version.uploadedAt)}</td>
                  <td>{formatBytes(version.sizeBytes)}</td>
                  {canDesign && <td>{version.filename}</td>}
                  {canDesign && <td className="dim">{version.uploadedBy ?? ""}</td>}
                  <td>
                    {version.runs.length === 0
                      ? T`never run`
                      : version.runs.slice(0, 3).map(run => (
                          <span key={run.id} className={`chip chip-${run.status}`} title={run.finishedAt ? formatDateTime(run.finishedAt) : undefined}>
                            {run.status}
                          </span>
                        ))}
                  </td>
                  {canDesign && (
                    <td>
                      <div className="files-actions">
                        {!version.purgedAt && <a href={fileVersionUrl(integrationId, slot.slotId, version.id)}>{T`Download`}</a>}
                        {canChange && !version.purgedAt && !version.current && (
                          <button
                            className="secondary"
                            disabled={!idle}
                            onClick={() => onRunVersion(version)}
                            title={T`Runs today's code against this version; success makes it current`}
                          >
                            {T`Run with this version`}
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}

/** Props for the multi-slot replace form. */
interface ReplaceSeveralProps {
  /** Owning integration */
  integrationId: string
  /** Declared slots, in definition order */
  slotIds: string[]
  /** Declared slot specs, for accept lists */
  declared: Record<string, FileSlotSpec>
  /** Another upload is in flight */
  disabled: boolean
  /** The server's upload limit, once known */
  maxUploadMb: number | null
  /** Reports upload progress text, or null when done */
  onBusy: (message: string | null) => void
  /** Reports the outcome; failed marks an error */
  onDone: (message: string, failed: boolean) => void
}

/**
 * Replaces several slots in one run (a shapefile plus its lookup sheet):
 * each file is staged without running, then one run reads them all, so no
 * run ever sees half of the replacement.
 */
function ReplaceSeveral({ integrationId, slotIds, declared, disabled, maxUploadMb, onBusy, onDone }: ReplaceSeveralProps) {
  const [picked, setPicked] = useState<Record<string, File>>({})
  const chosen = Object.entries(picked)

  async function submit() {
    const oversize = chosen.find(([, file]) => maxUploadMb !== null && file.size > maxUploadMb * 1024 * 1024)
    if (oversize) {
      onDone(T`${oversize[1].name} is ${formatBytes(oversize[1].size)}; this server accepts files up to ${maxUploadMb ?? 0} MB.`, true)
      return
    }
    const pins: Record<string, string> = {}
    try {
      for (const [slotId, file] of chosen) {
        onBusy(T`Uploading ${file.name}…`)
        const result = await uploadIntegrationFile(integrationId, slotId, file, false, fraction =>
          onBusy(T`Uploading ${file.name}… ${Math.round(fraction * 100)}%`)
        )
        pins[slotId] = result.version.id
      }
      const started = await startRun(integrationId, pins)
      setPicked({})
      onDone(
        started.status === "running"
          ? T`Uploaded ${chosen.length} files; a run reading them has started.`
          : T`Uploaded ${chosen.length} files; a run reading them is queued behind the run in progress.`,
        false
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      onDone(
        Object.keys(pins).length > 0
          ? T`${message} The files uploaded so far are kept as versions but were not run.`
          : message,
        true
      )
    } finally {
      onBusy(null)
    }
  }

  return (
    <details className="files-several">
      <summary>{T`Replace several files in one run`}</summary>
      <fieldset disabled={disabled}>
        {slotIds.map(slotId => (
          <label key={slotId}>
            <span>{slotId}</span>
            <input
              type="file"
              accept={declared[slotId]?.accept?.join(",")}
              onChange={event => {
                const file = event.target.files?.[0]
                setPicked(prev => {
                  const next = { ...prev }
                  if (file) next[slotId] = file
                  else delete next[slotId]
                  return next
                })
              }}
            />
          </label>
        ))}
        <button onClick={() => void submit()} disabled={chosen.length === 0}>
          {T`Upload and Run`}
        </button>
        <span className="dim">{T`Slots left empty keep their current version.`}</span>
      </fieldset>
    </details>
  )
}
