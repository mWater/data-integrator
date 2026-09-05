import { useEffect, useState } from "react"
import { createSession } from "./api.js"
import { ensureAiAck } from "./aiAck.js"

/** Props for the design-session starter. */
interface DesignStartProps {
  /** Request text to pre-write into the new session's composer */
  prompt: string
  /** False for viewers, who cannot run design sessions */
  canDesign: boolean
}

/**
 * Target of the agents' "design it" links (#/design?prompt=...): opens a new
 * design session and lands in it with the request already typed, so a missing
 * source is one click from being built rather than a note to go find one.
 */
export function DesignStart({ prompt, canDesign }: DesignStartProps) {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!canDesign) return
    let cancelled = false
    ;(async () => {
      if (!(await ensureAiAck())) {
        window.location.hash = "#/integrations"
        return
      }
      try {
        const { sessionId } = await createSession()
        if (cancelled) return
        window.location.replace(`#/session/${sessionId}${prompt ? `?prompt=${encodeURIComponent(prompt)}` : ""}`)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [prompt, canDesign])

  return (
    <main className="list-page">
      {!canDesign ? (
        <>
          <h1>{T`Design an integration`}</h1>
          <p>{T`Viewers cannot run design sessions. Ask an editor to build this request:`}</p>
          <blockquote>{prompt}</blockquote>
        </>
      ) : error ? (
        <div className="error">{error}</div>
      ) : (
        <p>{T`Starting a design session…`}</p>
      )}
    </main>
  )
}
