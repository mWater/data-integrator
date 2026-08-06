# Data Integrator

Open-source, self-hosted platform that ingests multi-source water and climate data
(satellite rasters, gridded forecasts, sensor feeds, national databases), harmonizes it,
and stores it in PostgreSQL/PostGIS plus a file-backed raster store. Integrated data is
accessed through a documented REST API, a dashboard, and an optional AI assistant. An
agentic AI designs and tests the ingestion pipelines; pipeline code runs in sandboxed
containers (podman + gVisor).

Developed by [mWater](https://www.mwater.co) for the UNICEF WASH Innovation Hub, with
initial deployments in Angola and Madagascar.

## Status

Design phase. No runnable code yet.

- [Architecture.md](Architecture.md) - system design and core decisions
- [Agent Harness.md](Agent%20Harness.md) - agent loop design and harness decisions

## License

Apache 2.0
