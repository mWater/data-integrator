/**
 * The platform in one picture: integrations write, everything else reads. The
 * full variant also shows the two optional ways to get an integration, which is
 * the part newcomers get wrong (the library looks like a source of data, and is
 * not). Drawn in currentColor plus the accent so it themes with the page.
 */

/** Which of the two drawings to render. */
interface FlowDiagramProps {
  /**
   * "full" teaches the model on a page with room for it; "compact" is a
   * single-line reminder for pages that have already made their point.
   */
  variant?: "full" | "compact"
}

/** Arrowhead defs, id-suffixed so two diagrams on one page cannot collide. */
function Arrows({ suffix }: { suffix: string }) {
  return (
    <defs>
      <marker
        id={`flow-arrow-${suffix}`}
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
      </marker>
      <marker
        id={`flow-arrow-accent-${suffix}`}
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
      </marker>
    </defs>
  )
}

/** The single teal line: integrations write, the rest read. */
function Compact() {
  return (
    <svg
      className="flow-svg flow-compact"
      viewBox="0 0 660 62"
      role="img"
      aria-label={T`Integrations write to Data. Dashboards, Explore, and the Map and API read from Data.`}
    >
      <Arrows suffix="c" />
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1" y="16" width="140" height="34" rx="7" />
        <rect x="470" y="16" width="189" height="34" rx="7" />
      </g>
      <rect x="253" y="16" width="112" height="34" rx="7" fill="var(--tint)" stroke="var(--accent)" strokeWidth="1.75" />

      <g fontFamily="inherit" textAnchor="middle" fill="currentColor">
        <text x="71" y="38" fontSize="12.5">{T`Integrations`}</text>
        <text x="309" y="38" fontSize="12.5" fontWeight="600" fill="var(--accent)">{T`Data`}</text>
        <text x="564" y="38" fontSize="12.5">{T`Dashboards, Explore, Map`}</text>
      </g>

      <g stroke="var(--accent)" strokeWidth="1.75" fill="none">
        <line x1="141" y1="33" x2="245" y2="33" markerEnd="url(#flow-arrow-accent-c)" />
        <line x1="365" y1="33" x2="462" y2="33" markerEnd="url(#flow-arrow-accent-c)" />
      </g>

      <g fontFamily="var(--font-mono)" fontSize="9.5" letterSpacing="1" textAnchor="middle" fill="var(--accent)">
        <text x="193" y="26">{T`WRITES`}</text>
        <text x="413" y="26">{T`READ`}</text>
      </g>
    </svg>
  )
}

/** The whole model, entry points included. */
function Full() {
  return (
    <svg
      className="flow-svg flow-full"
      viewBox="0 0 880 180"
      role="img"
      aria-label={T`Two optional ways to add an integration, describing it to the agent or installing a ready-made one from the library, both feed into Integrations. Integrations write to Data. Dashboards, Explore, and the Map and API all read from Data.`}
    >
      <Arrows suffix="f" />

      <g fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".62">
        <rect x="10" y="26" width="160" height="44" rx="8" />
        <rect x="10" y="108" width="160" height="44" rx="8" strokeDasharray="5 4" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="214" y="62" width="160" height="56" rx="8" />
        <rect x="660" y="16" width="200" height="40" rx="8" />
        <rect x="660" y="70" width="200" height="40" rx="8" />
        <rect x="660" y="124" width="200" height="40" rx="8" />
      </g>
      <rect x="446" y="62" width="140" height="56" rx="8" fill="var(--tint)" stroke="var(--accent)" strokeWidth="2" />

      <g fontFamily="inherit" fill="currentColor" textAnchor="middle">
        <g opacity=".72">
          <text x="90" y="45" fontSize="12.5">{T`Describe what you need`}</text>
          <text x="90" y="60" fontSize="11" opacity=".8">{T`the agent builds and tests it`}</text>
          <text x="90" y="127" fontSize="12.5">{T`Install a ready-made one`}</text>
          <text x="90" y="142" fontSize="11" opacity=".8">{T`from the library`}</text>
        </g>
        <text x="294" y="86" fontSize="14" fontWeight="600">{T`Integrations`}</text>
        <text x="294" y="104" fontSize="11.5" opacity=".72">{T`fetch on a schedule`}</text>
        <text x="516" y="86" fontSize="14" fontWeight="600" fill="var(--accent)">{T`Data`}</text>
        <text x="516" y="104" fontSize="11.5" fill="var(--accent)" opacity=".85">{T`tables + raster layers`}</text>
        <text x="760" y="41" fontSize="13">{T`Dashboards`}</text>
        <text x="760" y="95" fontSize="13">{T`Explore`}</text>
        <text x="760" y="149" fontSize="13">{T`Map and API`}</text>
      </g>

      <g stroke="currentColor" strokeWidth="1.5" fill="none" opacity=".62">
        <path d="M170 48 L186 48 L186 90" />
        <path d="M170 130 L186 130 L186 90" />
        <line x1="186" y1="90" x2="206" y2="90" markerEnd="url(#flow-arrow-f)" />
      </g>
      <g stroke="var(--accent)" strokeWidth="2" fill="none">
        <line x1="374" y1="90" x2="438" y2="90" markerEnd="url(#flow-arrow-accent-f)" />
        <line x1="586" y1="90" x2="638" y2="90" />
        <line x1="638" y1="36" x2="638" y2="144" />
        <line x1="638" y1="36" x2="652" y2="36" markerEnd="url(#flow-arrow-accent-f)" />
        <line x1="638" y1="90" x2="652" y2="90" markerEnd="url(#flow-arrow-accent-f)" />
        <line x1="638" y1="144" x2="652" y2="144" markerEnd="url(#flow-arrow-accent-f)" />
      </g>

      <g fontFamily="var(--font-mono)" fontSize="10.5" letterSpacing="1" textAnchor="middle">
        <text x="90" y="16" fill="currentColor" opacity=".55">{T`EITHER WAY, OPTIONAL`}</text>
        <text x="406" y="80" fill="var(--accent)">{T`WRITES`}</text>
        <text x="612" y="80" fill="var(--accent)">{T`READ`}</text>
      </g>
    </svg>
  )
}

/** The data-flow diagram, in the size the page has room for. */
export function FlowDiagram({ variant = "full" }: FlowDiagramProps) {
  return <figure className="flow">{variant === "compact" ? <Compact /> : <Full />}</figure>
}
