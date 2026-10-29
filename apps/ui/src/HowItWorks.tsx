/**
 * Plain-language orientation: what the pieces are called, how data flows, and
 * the first three things a new user does. Linked from the home page.
 */

import type { ReactNode } from "react"
import { FlowDiagram } from "./FlowDiagram.js"

/** One term and its one-sentence definition. */
function Term({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="term">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** The How it works page. */
export function HowItWorks() {
  return (
    <main className="list-page how-page">
      <h1>{T`How it works`}</h1>
      <p className="dim">
        {T`mWater Data Integrator pulls public and partner data into one local database, keeps it current, and lets you question, map and chart it. Here is what the pieces are called and how they fit.`}
      </p>

      <FlowDiagram />

      <h2>{T`The words we use`}</h2>
      <dl className="terms">
        <Term name={T`Integration`}>
          {T`A recipe that fetches data from one place (a satellite product, a national dataset, a sensor feed), reshapes it, and loads it into your database on a schedule. Each integration owns the tables and layers it produces.`}
        </Term>
        <Term name={T`Source`}>
          {T`Where an integration's data originally comes from: the provider, the dataset, its license and its known limitations. Every table and layer records its source so you can judge the data.`}
        </Term>
        <Term name={T`Data table`}>
          {T`Rows and columns produced by an integration, such as sensor readings or river reaches. Tables can be queried, mapped when they have a geometry column, and joined with each other.`}
        </Term>
        <Term name={T`Raster layer`}>
          {T`Gridded data such as rainfall, elevation or population, stored as images of values over an area. A layer can be a single picture or a time series.`}
        </Term>
        <Term name={T`Snapshot`}>
          {T`One point in time of a raster layer, for example rainfall for one day or population for one year. Time-series layers are stacks of snapshots.`}
        </Term>
        <Term name={T`Area of interest`}>
          {T`The country or bounding box the deployment cares about. Integrations clip their data to it unless they declare an area of their own, so a country deployment stores that country, not the world.`}
        </Term>
        <Term name={T`Library`}>
          {T`Ready-made integrations shipped with the platform, installable in one click: WorldPop population, Copernicus flood and drought products, HydroSHEDS rivers and basins, and more.`}
        </Term>
        <Term name={T`Source notes`}>
          {T`Reference notes the designer agent reads while building an integration: how a provider publishes its files and the quirks to expect. Nothing to install; they live in the Library for transparency.`}
        </Term>
        <Term name={T`Designer agent`}>
          {T`The AI assistant that builds or repairs an integration from a plain-language request. It explores the source, writes and tests the code, and only installs it after a clean run from scratch.`}
        </Term>
        <Term name={T`Explore`}>
          {T`Plain-language questions answered from the data already installed, with the query that produced each answer and a download of the result. Explore only reads; it never fetches new data.`}
        </Term>
        <Term name={T`Dashboard`}>
          {T`A saved page of charts, tables and maps built by the dashboard agent from your data. Dashboards use frozen queries, so they can be shared publicly without exposing the rest of the system.`}
        </Term>
        <Term name={T`Run`}>
          {T`One execution of an integration: fetch, transform, load. Runs are scheduled, triggered by a webhook, or started by hand, and each keeps its log and statistics.`}
        </Term>
      </dl>

      <h2>{T`Getting started`}</h2>
      <ol className="steps">
        <li>
          <b>{T`Set the area of interest`}</b>
          <div className="dim">{T`Settings, then Default area of interest. Pick the country. Everything installed afterwards is clipped to it.`}</div>
        </li>
        <li>
          <b>{T`Install data from the Library`}</b>
          <div className="dim">{T`Choose an entry, confirm, and let the first run load the data. It appears under Data as soon as the run finishes.`}</div>
        </li>
        <li>
          <b>{T`Explore the data or build a dashboard`}</b>
          <div className="dim">{T`Explore answers one-off questions; the dashboard agent turns a description into a page you can share.`}</div>
        </li>
      </ol>
      <p className="dim">
        {T`Need a source that is not in the Library? New Integration on the Integrations page starts a design session where you describe it in plain language.`}
      </p>
    </main>
  )
}
