/** Shared loading and recoverable read-error feedback. */
export function LoadState({ error, onRetry }: { error?: string | null; onRetry: () => void }) {
  return error ? <div className="load-state" role="alert">
    <p>{T`Unable to load this content.`}</p><p className="dim">{error}</p>
    <button className="secondary" onClick={onRetry}>{T`Retry`}</button>
  </div> : <p className="load-state" role="status">{T`Loading…`}</p>
}
