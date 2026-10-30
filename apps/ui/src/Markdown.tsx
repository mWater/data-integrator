import DOMPurify from "dompurify"
import { marked } from "marked"

/** Props for rendered markdown. */
interface MarkdownProps {
  /** Markdown source */
  text: string
  /** Optional extra class on the wrapper */
  className?: string
}

/**
 * Renders agent markdown. Always sanitized: agent output can embed content
 * fetched from arbitrary sources, so it is never trusted as HTML.
 */
export function Markdown({ text, className }: MarkdownProps) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }))
  return <div className={`markdown ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />
}
