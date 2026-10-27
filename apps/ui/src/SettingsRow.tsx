import { ReactNode } from "react"

/** Shared layout keeps descriptions and controls aligned across settings. */
export function SettingsRow({ id, title, description, children }: {
  id: string; title: string; description: string; children: ReactNode
}) {
  return (
    <section className="settings-row" id={id} aria-labelledby={`${id}-heading`}>
      <div className="settings-row-heading">
        <h3 id={`${id}-heading`}>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="settings-row-content">{children}</div>
    </section>
  )
}
