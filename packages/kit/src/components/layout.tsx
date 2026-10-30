/** Layout primitives: page scaffold, responsive grid, and card surface. */

import type { ReactNode } from "react"
import { useTheme } from "../hooks.js"

/** Props for the top-level page scaffold. */
export interface PageProps {
  /** Dashboard title rendered as the page h1. */
  title: string
  /** Optional subtitle under the title. */
  subtitle?: string
  /** Right-aligned header content, typically a FilterBar. */
  controls?: ReactNode
  /** Page body, typically Grid children. */
  children: ReactNode
}

/** Page scaffold: header with title and controls, then the content column. */
export function Page({ title, subtitle, controls, children }: PageProps) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-5">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-sm opacity-70">{subtitle}</p> : null}
        </div>
        {controls ? <div className="flex flex-wrap items-center gap-2">{controls}</div> : null}
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  )
}

/** Props for the responsive grid. */
export interface GridProps {
  /** Column count at desktop width; collapses to one column on narrow screens. */
  columns?: 2 | 3 | 4
  /** Grid cells, typically Cards. */
  children: ReactNode
}

/** Responsive card grid. */
export function Grid({ columns = 2, children }: GridProps) {
  const cls =
    columns === 4
      ? "grid gap-4 md:grid-cols-2 xl:grid-cols-4"
      : columns === 3
        ? "grid gap-4 md:grid-cols-3"
        : "grid gap-4 md:grid-cols-2"
  return <div className={cls}>{children}</div>
}

/** Props for a card surface. */
export interface CardProps {
  /** Card heading. */
  title?: string
  /** Spans all grid columns when set. */
  wide?: boolean
  /** Card content. */
  children: ReactNode
}

/** Card: the chart/content surface with hairline border. */
export function Card({ title, wide, children }: CardProps) {
  const theme = useTheme()
  return (
    <section
      className={"rounded-lg p-4" + (wide ? " md:col-span-full" : "")}
      style={{ background: theme.surface, border: `1px solid ${theme.border}` }}
    >
      {title ? <h2 className="mb-3 text-sm font-medium">{title}</h2> : null}
      {children}
    </section>
  )
}
