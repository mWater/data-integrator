# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Email **problems@mwater.co** with a description, the affected component, and
steps to reproduce. If you have a proof of concept, attach it. We acknowledge
reports within 5 working days and aim to ship a fix or a documented mitigation
within 90 days, sooner for anything actively exploitable.

You may also report privately through GitHub Security Advisories on this
repository.

## Supported versions

Security fixes land on `main` and in the latest release. Deployments should
run the latest release and update with `deploy/update.sh`.

## Scope

Deployments are self-hosted, so the operator owns the host, the network, and
the Postgres instance. Reports about the code in this repository are in scope,
in particular:

- **Sandbox escape.** Integration code runs in rootless podman + gVisor with an
  egress policy that permits public destinations only. Anything that reaches
  the host, another container, or a private network address from inside a job
  is the highest-severity class here.
- **Agent-driven code execution outside the sandbox.** The designer agent
  writes and runs integration code. Any path where agent output executes in the
  server process rather than in a job container.
- **SQL execution boundaries.** Dashboards run frozen, parameterized SQL;
  Explore (the query assistant) runs SQL the model writes for each question.
  Both run as the read-only `sql_engine` role with statement timeouts and row
  caps. Escapes from that role, the parameterization, or those limits are in
  scope.
- **Authentication and authorization.** Session handling, personal access
  tokens, and the admin/editor/viewer role checks.
- **Secret handling.** Integration secrets are AES-256-GCM encrypted at rest
  under `INTEGRATOR_SECRET_KEY`, and their values are masked in stored run
  output. Disclosure of plaintext secrets to logs, the API, job containers
  that did not declare them, or the agent transcript.
- **Unauthorized data exposure** through the query API, raster tiles, or COG
  downloads.

Out of scope:

- Findings that require an operator to have already misconfigured the
  deployment against the documented guidance, such as running the server as
  root, exposing Postgres publicly, or reusing `INTEGRATOR_SECRET_KEY` across
  deployments.
- Denial of service from a legitimately authorized user's own job hitting its
  configured resource limits.
- Vulnerabilities in third-party dependencies with no exploitable path through
  this code. Report those upstream; tell us if you want the pin bumped.

## Disclosure

We prefer coordinated disclosure. Tell us when you intend to publish and we
will work to have a fix out first. We credit reporters in the advisory unless
you ask us not to.
