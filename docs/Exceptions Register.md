# Exceptions Register

Every proprietary or vendor-operated dependency of the Data Integrator, with
its justification, as the contract requires (Statement of Work, Deliverable 4:
"declare and justify any proprietary dependency in the inception exceptions
register"; UAT case OS-3).

All code in this repository is Apache 2.0. Every Node.js production dependency
and every Python package in the runtime image carries an OSI-approved license,
checked in CI against an allowlist of SPDX identifiers, with a CycloneDX
software bill of materials produced on every build. The base images (Ubuntu
with GDAL, and Node.js) are open-source distributions. The
platform builds, installs and runs with no vendor account, licence or hosted
service.

| Dependency | Kind | Required? | Justification | Open alternative |
|---|---|---|---|---|
| Hosted AI model providers (Anthropic; models routed through OpenRouter) | Proprietary hosted service | No. Ingestion, storage, the API, dashboards, tiles and webhooks run with no model configured; only the AI designer, Explore and the dashboard builder need one | Commercial models currently give the most reliable results for agentic pipeline design (OS-3 permits this when declared). An admin chooses the provider in Settings; each user acknowledges the data notice before first use, and API usage costs are borne by the deploying organization | Any OpenAI-compatible endpoint, including a self-hosted open-weights model server, configured as the "custom" provider |

Services the platform can use that are not proprietary dependencies:

- **Basemap tiles**: proxied and cached from OpenFreeMap (open source, open
  data, no account) by default; `BASEMAP_UPSTREAM` points at any compatible
  tile server, including a local one, or turns the basemap off.
- **Public data sources**: integrations fetch from the publishers of the data
  they integrate (for example Copernicus, WorldPop, HydroSHEDS); some sources
  require a free account with the publisher, entered as an integration
  credential.
