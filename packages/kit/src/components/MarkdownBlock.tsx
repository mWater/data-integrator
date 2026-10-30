/** Markdown block: sanitized rich text for narrative sections. */

import { marked } from "marked"
import DOMPurify from "dompurify"

/** Props for the markdown block. */
export interface MarkdownBlockProps {
  /** Markdown source; output is sanitized before insertion. */
  children: string
}

/** Renders markdown, always sanitized. */
export function MarkdownBlock({ children }: MarkdownBlockProps) {
  const html = DOMPurify.sanitize(marked.parse(children, { async: false }))
  return <div className="prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: html }} />
}
