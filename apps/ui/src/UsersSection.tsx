import { FormEvent, useEffect, useRef, useState } from "react"
import {
  AdminUser,
  createUser,
  listUsers,
  resetUserPassword,
  setUserDisabled,
  setUserRole,
  User
} from "./api.js"

/** Assignable roles, least privilege first. */
const ROLES: AdminUser["role"][] = ["viewer", "editor", "admin"]

/** A role's display label, translated at call time. */
function roleLabel(role: AdminUser["role"]): string {
  switch (role) {
    case "admin":
      return T`admin`
    case "editor":
      return T`editor`
    default:
      return T`viewer`
  }
}

/** A pending confirmation for a user action. */
interface PendingConfirm {
  /** Dialog heading */
  title: string
  /** Explanation of what happens */
  body: string
  /** Label on the confirming button */
  actionLabel: string
  /** Style the confirming button as destructive */
  danger?: boolean
  /** Runs the confirmed action */
  run: () => void
}

/** Light confirmation dialog for reversible user actions. */
function ConfirmAction({ confirm, onCancel }: { confirm: PendingConfirm; onCancel: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onCancel])

  return (
    <>
      <div className="modal-backdrop" onClick={onCancel} />
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={confirm.title}>
        <h2>{confirm.title}</h2>
        <p>{confirm.body}</p>
        <div className="confirm-actions">
          <button className="secondary" onClick={onCancel}>
            {T`Cancel`}
          </button>
          <button className={confirm.danger ? "danger" : undefined} autoFocus onClick={confirm.run}>
            {confirm.actionLabel}
          </button>
        </div>
      </div>
    </>
  )
}

/** Shows a freshly generated password exactly once, with a copy button. */
function PasswordRevealDialog({ email, password, onClose }: { email: string; password: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(password)
      setCopied(true)
    } catch {
      // Clipboard API is unavailable off secure origins; fall back to selection
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }

  return (
    <>
      <div className="modal-backdrop" />
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={T`New password`}>
        <h2>{T`New password`}</h2>
        <p>
          {T`Password for ${<b key="email">{email}</b>} — shown once, copy it now and hand it over securely.`}
        </p>
        <div className="password-box">
          <input
            ref={inputRef}
            className="password-value"
            readOnly
            value={password}
            onFocus={e => e.target.select()}
          />
          <button className="secondary" onClick={copy}>
            {copied ? T`Copied` : T`Copy`}
          </button>
        </div>
        <div className="confirm-actions">
          <button onClick={onClose}>{T`Done`}</button>
        </div>
      </div>
    </>
  )
}

/** Admin management of the deployment's users: add, reset, role, disable. */
export function UsersSection({ currentUser }: { currentUser: User }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<AdminUser["role"]>("viewer")
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [reveal, setReveal] = useState<{ email: string; password: string } | null>(null)

  function reload() {
    listUsers().then(
      result => setUsers(result.users),
      err => setError(err instanceof Error ? err.message : String(err))
    )
  }

  useEffect(reload, [])

  /** Runs a mutation with shared error handling, then refreshes the list. */
  async function mutate(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      reload()
    }
  }

  function addUser(e: FormEvent) {
    e.preventDefault()
    void mutate(async () => {
      const created = await createUser(email.trim(), role)
      setReveal({ email: created.user.email, password: created.password })
      setEmail("")
      setRole("viewer")
    })
  }

  function confirmReset(u: AdminUser) {
    setConfirm({
      title: T`Reset password`,
      body: T`Generate a new password for ${u.email}? Their current password stops working immediately.`,
      actionLabel: T`Reset Password`,
      run: () => {
        setConfirm(null)
        void mutate(async () => {
          const result = await resetUserPassword(u.id)
          setReveal({ email: u.email, password: result.password })
        })
      }
    })
  }

  function confirmDisable(u: AdminUser) {
    setConfirm({
      title: T`Disable user`,
      body: T`Disable ${u.email}? Their sessions end immediately and sign-in is blocked until re-enabled.`,
      actionLabel: T`Disable`,
      danger: true,
      run: () => {
        setConfirm(null)
        void mutate(() => setUserDisabled(u.id, true))
      }
    })
  }

  return (
    <section className="users-section">
      <p className="dim">
        {T`New and reset passwords are generated and shown once. Disabling a user keeps their history but blocks sign-in; there is no delete.`}
      </p>
      {error && <div className="error">{error}</div>}
      <form className="user-add-form" onSubmit={addUser}>
        <input
          type="email"
          placeholder="email@example.org"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <select value={role} onChange={e => setRole(e.target.value as AdminUser["role"])} aria-label={T`Role`}>
          {ROLES.map(r => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        <button disabled={busy || !email.trim()}>{T`Add User`}</button>
      </form>
      {users === null ? (
        <p>{T`Loading…`}</p>
      ) : (
        <table className="sessions users">
          <thead>
            <tr>
              <th>{T`Email`}</th>
              <th>{T`Role`}</th>
              <th>{T`Status`}</th>
              <th>{T`Created`}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const isSelf = u.email === currentUser.email
              return (
                <tr key={u.id}>
                  <td>
                    {u.email} {isSelf && <span className="dim">{T`(you)`}</span>}
                  </td>
                  <td>
                    <select
                      value={u.role}
                      aria-label={T`Role of ${u.email}`}
                      disabled={busy}
                      onChange={e => void mutate(() => setUserRole(u.id, e.target.value as AdminUser["role"]))}
                    >
                      {ROLES.map(r => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={u.disabled ? "chip chip-paused" : "chip chip-active"}>
                      {u.disabled ? T`disabled` : T`active`}
                    </span>
                  </td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div className="row-actions">
                      <button className="secondary" disabled={busy} onClick={() => confirmReset(u)}>
                        {T`Reset Password`}
                      </button>
                      {u.disabled ? (
                        <button className="secondary" disabled={busy} onClick={() => void mutate(() => setUserDisabled(u.id, false))}>
                          {T`Enable`}
                        </button>
                      ) : (
                        !isSelf && (
                          <button className="danger" disabled={busy} onClick={() => confirmDisable(u)}>
                            {T`Disable`}
                          </button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {confirm && <ConfirmAction confirm={confirm} onCancel={() => setConfirm(null)} />}
      {reveal && (
        <PasswordRevealDialog email={reveal.email} password={reveal.password} onClose={() => setReveal(null)} />
      )}
    </section>
  )
}
