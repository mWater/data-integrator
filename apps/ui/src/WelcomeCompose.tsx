/**
 * Compose-first welcome card: a blank chat screen intimidates, so new agent
 * conversations start from a centered card with a big prompt box, teaching
 * placeholder, and example hints. The typed text becomes the first message.
 * Reusable by any session kind (assistant now; integration/dashboard starts
 * can adopt it).
 */

import { FormEvent, ReactNode, useState } from "react"

/** Props for the welcome compose card. */
interface WelcomeComposeProps {
  /** Icon shown above the title */
  icon?: ReactNode
  /** Card title */
  title: string
  /** One-line description under the title */
  blurb: string
  /** Teaching placeholder for the prompt box (multi-line reads as a checklist) */
  placeholder: string
  /** Example prompts; clicking one fills the box */
  hints?: string[]
  /** Submit button label */
  submitLabel: string
  /** Starts the conversation with the typed text as its first message */
  onSubmit: (text: string) => Promise<void>
}

/** Centered card with a large prompt box; submit starts the conversation. */
export function WelcomeCompose({ icon, title, blurb, placeholder, hints, submitLabel, onSubmit }: WelcomeComposeProps) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      // A submit can finish without navigating (e.g. the AI notice was
      // declined); on success the hash change has already unmounted this card
      setBusy(false)
    }
  }

  return (
    <form className="welcome-card" onSubmit={submit}>
      {icon && <div className="welcome-icon">{icon}</div>}
      <h1>{title}</h1>
      <p className="welcome-blurb">{blurb}</p>
      <textarea
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            e.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder={placeholder}
        rows={5}
      />
      {hints && hints.length > 0 && (
        <div className="welcome-hints">
          {hints.map(hint => (
            <button key={hint} type="button" className="welcome-hint" onClick={() => setText(hint)}>
              {hint}
            </button>
          ))}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <button type="submit" className="welcome-submit" disabled={busy || !text.trim()}>
        {busy ? T`Starting…` : submitLabel}
      </button>
    </form>
  )
}
