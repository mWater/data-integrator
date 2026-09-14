import { FormEvent, useRef, useState } from "react"
import { login, User } from "./api.js"

/** Props for the login screen. */
interface LoginProps {
  /** Called with the signed-in user */
  onLogin: (user: User) => void
}

/** Full-page email + password sign-in. */
export function Login({ onLogin }: LoginProps) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onLogin(await login(email.trim(), password))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
      // A rejected password is masked, so leaving it in place makes the next
      // attempt append to it
      setPassword("")
      passwordRef.current?.focus()
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>mWater Pathfinder</h1>
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
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? T`Signing in…` : T`Sign In`}</button>
      </form>
    </main>
  )
}
