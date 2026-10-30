---
name: Credentials
description: How integrations obtain API keys and tokens - request_secrets in the session, names the library already uses, reuse via copyFrom, check snippets
verified: 2026-09-16
---

# Credentials

Secret values live per integration, encrypted in the app database, and reach
code only as `ctx.secrets[name]` (Python) or `secrets[name]` (Node). They
never appear in a definition, a log, or this conversation.

## Getting a value from the operator

Call `request_secrets` with one entry per name: a one-line `purpose` ("API
key for api.weather.example.org"), a `help` URL or hint on where to obtain it, and a
`check` snippet when one cheap authenticated call can prove the value works.
The session shows a form and pauses; the operator saves the values there and
the session resumes with a names-only message. Then run again.

Do not ask for a value in chat, and do not send the operator to another page.
Before a run, `run_integration` refuses with "Secret X is not set" when a
declared name has no value: that is the moment to call `request_secrets`.

## Names

Lowercase snake_case, ending in what the thing is: `_api_key`, `_token`,
`_credentials` (a JSON object with several fields), `_password`.

Call `list_secrets` before inventing a name. When the deployment already holds
a credential for the same service, request that exact name and pass
`copyFrom` with the integration that holds it, so the operator reuses it with
one click instead of pasting it again.

Names the library entries use, so reuse lines up:

| Name | Service | Held by |
| --- | --- | --- |
| `cds_api_token` | Copernicus Climate / Early Warning Data Stores (CDS, EWDS) | glofas_river_discharge |
| `cdse_s3_credentials` | Copernicus Data Space Ecosystem S3 (JSON: access key, secret key) | clms_fpar_10daily |

## Check snippets

A check runs in the same sandbox as a run, with `ctx.secrets` populated, right
after the operator saves. Keep it to one request and raise on anything but
success, for example:

```python
import requests
r = requests.get("https://api.weather.example.org/v1/stations",
                 headers={"Authorization": f"Bearer {ctx.secrets['weather_api_key']}"}, timeout=30)
r.raise_for_status()
print("ok", r.status_code)
```

A rejected value is shown to the operator with the last lines of output, and
they can replace it on the spot.
