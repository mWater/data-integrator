/** Shared chrome for assistant result blocks: title, meta, actions, SQL on expand. */

import { ReactNode, useState } from "react"

/** Props for the block shell. */
interface BlockShellProps {
  /** Title row text; absent for plain table blocks */
  title?: string
  /** Small meta text beside the title (e.g. row count) */
  meta?: string
  /** SQL shown on expand ("every block carries its SQL") */
  sql?: string
  /** When set, renders a CSV action invoking it */
  onDownloadCsv?: () => void
  /** Block content */
  children: ReactNode
}

/** One result block: content card with title, actions, and expandable SQL. */
export function BlockShell({ title, meta, sql, onDownloadCsv, children }: BlockShellProps) {
  const [showSql, setShowSql] = useState(false)
  return (
    <div className="block">
      <div className="block-head">
        {title && <span className="block-title">{title}</span>}
        {meta && <span className="block-meta">{meta}</span>}
        <span className="spacer" />
        {onDownloadCsv && (
          <button type="button" className="block-action" onClick={onDownloadCsv}>
            {T`CSV`}
          </button>
        )}
        {sql && (
          <button type="button" className="block-action" onClick={() => setShowSql(v => !v)}>
            {showSql ? T`Hide SQL` : T`SQL`}
          </button>
        )}
      </div>
      {showSql && sql && <pre className="block-sql">{sql}</pre>}
      {children}
    </div>
  )
}
