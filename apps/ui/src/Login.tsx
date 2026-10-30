import { FormEvent, useRef, useState } from "react"
import { login, PasswordExpiredError, User } from "./api.js"

/** Props for the login screen. */
interface LoginProps {
  /** Called with the signed-in user */
  onLogin: (user: User) => void
}

/**
 * Full-page email + password sign-in. When the deployment's account policy
 * reports the password expired, the form asks for a new one and signs in with
 * it.
 */
export function Login({ onLogin }: LoginProps) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [expired, setExpired] = useState(false)
  const [newPassword, setNewPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (expired) {
      if (newPassword.length < 8) {
        setError(T`Password must be at least 8 characters`)
        return
      }
      if (newPassword !== confirm) {
        setError(T`New passwords do not match`)
        return
      }
      if (newPassword === password) {
        setError(T`Choose a password different from the old one`)
        return
      }
    }
    setBusy(true)
    try {
      onLogin(await login(email.trim(), password, expired ? newPassword : undefined))
    } catch (err) {
      setBusy(false)
      if (err instanceof PasswordExpiredError) {
        setExpired(true)
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      if (expired) return
      // A rejected password is masked, so leaving it in place makes the next
      // attempt append to it
      setPassword("")
      passwordRef.current?.focus()
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>mWater Data Integrator</h1>
        {expired ? (
          <>
            <p>{T`Your password has expired. Choose a new one to sign in.`}</p>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder={T`New password`}
              aria-label={T`New password`}
              autoComplete="new-password"
              required
              autoFocus
            />
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder={T`Confirm new password`}
              aria-label={T`Confirm new password`}
              autoComplete="new-password"
              required
            />
          </>
        ) : (
          <>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={T`email`}
              autoComplete="username"
              required
              autoFocus
            />
            <input
              ref={passwordRef}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={T`password`}
              autoComplete="current-password"
              required
            />
          </>
        )}
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? T`Signing in…` : expired ? T`Change Password and Sign In` : T`Sign In`}
        </button>
      </form>
    </main>
  )
}
