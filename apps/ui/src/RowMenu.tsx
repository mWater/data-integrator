/** Quiet ⋮ menu, portaled so overflow:hidden ancestors do not clip it. */

import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

/** Props for the overflow menu. */
interface Props {
  /** Accessible name of the trigger */
  label: string
  /** Menu items (buttons with role="menuitem") */
  children: ReactNode
}

/** A ⋮ trigger that opens a portaled menu below itself. */
export function RowMenu({ label, children }: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState({ top: 0, right: 0 })

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  function toggle(e: ReactMouseEvent) {
    e.stopPropagation()
    if (open) {
      setOpen(false)
      return
    }
    const r = triggerRef.current!.getBoundingClientRect()
    setCoords({ top: r.bottom + 4, right: window.innerWidth - r.right })
    setOpen(true)
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={toggle}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className="row-menu-list"
              role="menu"
              style={{ top: coords.top, right: coords.right }}
              onClick={e => {
                e.stopPropagation()
                setOpen(false)
              }}
            >
              {children}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
