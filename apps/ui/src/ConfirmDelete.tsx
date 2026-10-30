/** Shared irreversible-delete confirmation dialog. */

import { ReactNode, useState } from "react"

/** Props for the confirmation dialog. */
interface ConfirmDeleteProps {
  /** Dialog heading, e.g. Delete "Rainfall"? */
  title: string
  /** Consequence explanation rendered above the confirmation input */
  children: ReactNode
  /** Exact text the user must type to arm the delete button; omit to arm it
   * immediately, for cheap objects where typing is friction without safety */
  confirmToken?: string
  /** Label of the armed button (default "Delete Forever") */
  confirmLabel?: string
  /** Dismisses without deleting */
  onCancel: () => void
  /** Proceeds with the delete */
  onConfirm: () => void
}

/**
 * Delete confirmation: names the consequences and requires typing an exact
 * token, so an irreversible delete cannot happen on a stray click.
 */
export function ConfirmDelete({ title, children, confirmToken, confirmLabel, onCancel, onConfirm }: ConfirmDeleteProps) {
  const [typed, setTyped] = useState("")
  const armed = confirmToken === undefined || typed.trim() === confirmToken
  return (
    <>
      <div className="drawer-backdrop" onClick={onCancel} />
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {confirmToken !== undefined && (
          <label>
            <span>
              {T`Type this to confirm:`} <code>{confirmToken}</code>
            </span>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && armed) onConfirm()
                if (e.key === "Escape") onCancel()
              }}
            />
          </label>
        )}
        <div className="confirm-actions">
          <button className="secondary" onClick={onCancel}>
            {T`Cancel`}
          </button>
          <button className="danger" disabled={!armed} onClick={onConfirm}>
            {confirmLabel ?? T`Delete Forever`}
          </button>
        </div>
      </div>
    </>
  )
}
