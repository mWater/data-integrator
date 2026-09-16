# Secrets in the designer: making credentials seamless

Plan written 2026-09-16 and built the same day (all four phases, see the end). Prompted by the Tatirano weather-station case at the
UNICEF workshop: the designer declared `TATIRANO_API_KEY`, the cold run failed
with "Secret TATIRANO_API_KEY is not set", the session paused with a text
instruction to go elsewhere, and the elsewhere then said "not found".

## What happens today

1. The agent writes a definition that declares secret names. A valid draft
   materializes as a draft-status integration row so secrets have something to
   attach to (designer.ts, write_definition).
2. The agent runs the integration. `loadSecrets` fails before the job starts,
   or the job fails on `ctx.secrets`, and the agent gets an error string.
3. The prompt tells the agent to "tell the operator to set it under Credentials
   on this integration's page (definition tab)". The agent says so in chat and
   the session pauses. It cannot ask for the value in chat, and it should not:
   values must never enter the transcript, the model context, logs, or the
   definition.
4. The operator leaves the session, opens Integrations, finds the draft, opens
   the definition tab, and uses the Credentials panel (SecretsSection.tsx).
   Only admins can save. Editors have no path at all.
5. The operator returns to the session and tells the agent to try again.

Friction found in the workshop, in the order people hit it:

- The handoff is a sentence in chat. Nothing on screen leads to the form.
- The Credentials panel lives on a page the operator has never visited for a
  draft they did not knowingly create.
- The secrets route only accepted lowercase names; the designer writes
  environment-variable style names. Fixed 2026-09-16, ships with the next push.
- Editors cannot set secrets and have no way to hand the request to an admin.
- The agent does not know which credentials the deployment already holds, so
  it declares a new name where `cds_api_token` on GloFAS would have served.
- The credential is only tested by a full run, so a typo costs a download.
- The agent's own reasoning showed it looking for a workaround ("asking for
  credentials in chat isn't allowed, maybe contact the administrator").

## Principles

- Values never touch the transcript, the model, logs, or definitions. This is
  already the design and stays.
- The session is where credentials are requested, entered, and confirmed. The
  operator never leaves it.
- Saving stays admin-only. Editors get a clean handoff, not a silent wall.
- Names are the definition's contract; storage stays per integration, with
  copy-from for reuse.

## Phase 1: a credentials card in the session (about a day)

The core change. Everything else builds on it.

**Agent tool `request_secrets`.** Input: a list of `{ name, purpose, help }`
where purpose is one line ("API key for app.tatirano.org") and help is an
optional hint or URL for where to get it. The tool declares the names in the
draft definition (merging into `secrets`), records the request in session
state, and pauses the session exactly like `ask_user`. Result to the agent:
"Credentials requested; the session is paused until they are saved."

**Pre-run check.** `run_integration` already calls `loadSecrets` before
launching. When a name is missing, the error to the agent becomes "Secret X is
not set; call request_secrets" so no job is spent finding out.

**Prompt.** Replace the "tell the operator to go to the definition tab" rule
with: declare secrets by calling request_secrets, never ask for a value in
chat, and after the card reports them saved, run again.

**Session UI.** SessionView already detects a pending `ask_user` and renders a
QuestionCard. Add the same detection for `request_secrets` and render a
CredentialsCard: one row per name with the agent's purpose and help text, a
status chip (missing or set), and a value field with Save. It is
SecretsSection in compact form, pointed at the draft's id, reusing the existing
PUT route and `listIntegrationSecrets`. When every requested name is set, the
card resumes the session by sending a synthetic user message that carries
names only: "Credentials saved: tatirano_api_key". The agent continues from
there.

**Editors.** The card renders read-only with the same rows plus the sentence
"An admin needs to save these" and a copyable link to the draft's credentials
page. A Resume button lets the editor continue once an admin confirms.

**Files.** designer.ts (tool, prompt, loadSecrets message), SessionView.tsx
plus a new CredentialsCard.tsx, api.ts (no new endpoints), a designer test for
the tool and the pre-run message, a UI string extraction.

## Phase 2: reuse and naming (half a day)

**Agent tool `list_secrets`.** Names and owning integrations, never values,
from the existing admin listing. The prompt tells the agent to check it before
declaring a new name and to prefer an existing one when the source matches
("GloFAS and this CDS request both use cds_api_token").

**Copy-from in the card.** `request_secrets` entries may carry
`copyFrom: { integrationId, name }`. The card shows "Copy from
glofas_river_discharge" beside the field, backed by the existing `copySecret`.

**Naming.** Adopt lowercase snake_case as the convention in the definitions
validator (accepting either case for stored data), document the shared names
the library already uses in a `credentials` skill, and have the library and
the prompt agree. This removes the class of bug fixed on 2026-09-16 for good.

## Phase 3: verify before the big run (half a day to a day)

`request_secrets` entries may carry a `check`: a short snippet the agent
writes that performs the cheapest authenticated call (one HTTP request) and
raises on failure. After Save, the card runs it through `run_snippet` with the
secret injected and shows Checking, Verified, or Rejected with the response
status. A rejected value can be replaced on the spot. `run_snippet` already
injects the draft's secrets, so the check needs no new plumbing, only a way
for the card to trigger one snippet outside the agent's turn.

## Phase 4: the admin handoff (half a day)

For editors, the read-only card is not enough on a busy deployment. Add a
"needs credentials" state to the home page problems list, distinct from
failures: every enabled or draft integration whose declared names are not all
stored. Admins see it on login and can save from there. When one is saved,
the owning session, if paused on a request, becomes resumable. No email; the
home page is the inbox.

## The Tatirano case with Phase 1

1. Susan asks for the weather-station endpoint. The agent reads the API doc,
   writes the definition, and calls `request_secrets` with
   `tatirano_api_key`, "Bearer token for app.tatirano.org", and the doc URL.
2. The session shows the card. Susan pastes the key and presses Save. The
   card reports it set and resumes the session.
3. The agent runs cold, certifies, finishes.

Nothing else on screen, no other page, no chat message containing a value.

## Open decisions

- Should editors be allowed to save secrets on drafts they own? Simpler flow,
  wider blast radius. The plan keeps admin-only until decided.
- Deployment-wide named credentials (one `cds_api_token` shared by every
  integration that asks for it) versus today's per-integration copies. Copy-from
  covers the workshop cases; shared credentials are a later schema change.
- Whether existing uppercase names on the demo boxes get renamed, or the
  validator simply accepts both forever.

## Order and effort

Phase 1 first, on its own push, since it removes the workshop pain. Phase 2
next, same week. Phases 3 and 4 as time allows. Roughly three days in total.

## Status

Built 2026-09-16, uncommitted at the time of writing:

- Phase 1: `request_secrets` tool, pre-run refusal pointing at it, prompt rule,
  CredentialsCard in SessionView (admin fields, editor handoff, auto-resume).
- Phase 2: `list_secrets` tool, `copyFrom` on requests with a one-click copy in
  the card, name validation in `validateDefinition` (either case accepted,
  lowercase recommended), the `credentials` skill documenting shared names.
- Phase 3: `check` snippets run through `POST /api/sessions/:id/secrets/:name/check`
  after a save; the card shows verified or rejected with the output tail.
- Phase 4: `credentialsNeeded` on the home summary, rendered as alerts linking
  to the paused session or the integration page.

Decisions taken: saving stays admin-only; storage stays per integration with
copy-from; existing uppercase names are accepted, not renamed.

Card behaviour, verified in the browser on 2026-09-16: Save is the admin's only
action and the session resumes on its own once every value saved from the card
is in place and no check was rejected. A rejected check shows the exception
message with Continue Anyway. Values that were already set when the card
opened (saved elsewhere, or seen after a reload) wait for a Continue click, so
a rejection is never skipped by a refresh. Editors see Continue plus a link to
the credentials page.
