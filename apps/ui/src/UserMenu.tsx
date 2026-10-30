import { useEffect, useRef, useState } from "react"
import { User } from "./api.js"

/** Topbar dropdown anchored on the signed-in email: Settings and Sign Out. */
export function UserMenu({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
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

  return (
    <div className="user-menu" ref={ref}>
      <button
        ref={triggerRef}
        className="user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {user.email}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="user-menu-list" role="menu">
          <a role="menuitem" href="#/sessions" onClick={() => setOpen(false)}>
            {T`Agent Activity`}
          </a>
          <a role="menuitem" href="#/settings" onClick={() => setOpen(false)}>
            {T`Settings`}
          </a>
          <button role="menuitem" onClick={onSignOut}>
            {T`Sign Out`}
          </button>
        </div>
      )}
    </div>
  )
}
