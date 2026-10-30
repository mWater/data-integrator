import { useRef } from "react"
import { Definition, FileSlotSpec } from "./api.js"
import { formatBytes } from "./FilesSection.js"

/** Slot id rule, the same as the server's published-identifier rule. */
export const SLOT_PATTERN = /^[a-z][a-z0-9_]{0,62}$/

/** A file waiting in the composer to go out with the next message. */
export interface PendingAttachment {
  /** Local key */
  key: string
  /** The picked file */
  file: File
  /** File slot it will be uploaded to; editable until uploaded */
  slot: string
  /** Version it was uploaded as, when the message carrying it failed to send: a retry pins this instead of uploading again */
  versionId?: string
}

/** Lowercase extension with the dot, or "". */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot > 0 ? filename.slice(dot).toLowerCase() : ""
}

/** A filename's stem as a slot id: "Water Points 2026.xlsx" becomes "water_points_2026". */
function slotFromFilename(filename: string): string {
  const stem = filename.slice(0, filename.length - extensionOf(filename).length)
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  const id = /^[a-z]/.test(slug) ? slug : `file_${slug}`
  return id.replace(/_+$/, "").slice(0, 63) || "file"
}

/**
 * The slot a picked file goes to by default: the declared slot accepting its
 * extension, else the draft's only slot, else the filename in snake_case.
 */
export function defaultSlot(filename: string, definition: Definition | undefined): string {
  const declared = (definition?.files ?? {}) as Record<string, FileSlotSpec>
  const ids = Object.keys(declared)
  const ext = extensionOf(filename)
  const accepting = ids.find(id => declared[id].accept?.includes(ext))
  if (accepting) return accepting
  if (ids.length === 1) return ids[0]
  return slotFromFilename(filename)
}

/** Props for the attach button and the pending list. */
interface ComposerAttachmentsProps {
  /** Files waiting to be sent */
  attachments: PendingAttachment[]
  /** Replaces the list */
  onChange: (next: PendingAttachment[]) => void
  /** The draft, for default slots */
  definition: Definition | undefined
  /** False while the agent is mid-turn: attaching waits until it pauses */
  enabled: boolean
}

/**
 * Attach button plus the files waiting to go out, each with an editable slot.
 * Upload happens when the message is sent, so a slot can still be changed.
 */
export function ComposerAttachments({ attachments, onChange, definition, enabled }: ComposerAttachmentsProps) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="composer-attachments">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={event => {
          const picked = [...(event.target.files ?? [])]
          event.target.value = ""
          onChange([
            ...attachments,
            ...picked.map(file => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, slot: defaultSlot(file.name, definition) }))
          ])
        }}
      />
      <button
        type="button"
        className="secondary"
        onClick={() => input.current?.click()}
        disabled={!enabled}
        title={enabled ? T`Attach a file for the integration to read` : T`Attach files once the agent pauses`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
        </svg>
        {T`Attach File`}
      </button>
      {attachments.map(attachment => (
        <span key={attachment.key} className="composer-attachment">
          <span>
            {attachment.file.name} <span className="dim">({formatBytes(attachment.file.size)})</span>
          </span>
          <label>
            {T`slot`}{" "}
            <input
              value={attachment.slot}
              aria-invalid={!SLOT_PATTERN.test(attachment.slot)}
              disabled={attachment.versionId !== undefined}
              onChange={event =>
                onChange(attachments.map(a => (a.key === attachment.key ? { ...a, slot: event.target.value } : a)))
              }
              size={Math.max(8, attachment.slot.length)}
            />
          </label>
          <button
            type="button"
            className="quiet"
            aria-label={T`Remove ${attachment.file.name}`}
            onClick={() => onChange(attachments.filter(a => a.key !== attachment.key))}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
