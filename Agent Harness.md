# Agent Harness

Decision: the agent loop is hand-rolled on the AI SDK, following the same pattern as the
mWater harness. No third-party harness. This document describes the existing mWater
harness, why we keep the approach, and what the new harness adds.

## The mWater harness today

Two layers in mwater-server:

- `AgentSessionController` (~900 lines, generic): owns the loop. One step = one
  `generateText` call via the AI SDK, then execution of any server tools, then
  serialization. Provider-agnostic (Anthropic direct or OpenRouter).
- `AgentImplementation` (interface, one per agent type): supplies the model, system
  prompt, tool definitions, tool execution, limits, and compaction context. The
  integrator agent is one implementation.

Properties that matter:

- Semi-stateless: the full session (messages, client state, usage) is serialized to
  Postgres after every step. Any node process resumes any session. No process affinity,
  no live kernel state.
- Tool contract: server tools return `{ result, summary, updatedClientState, finished,
  pauseSession?, asPendingToolCall? }`. Client state is immutable (immer) and synced to
  the browser UI each turn. `asPendingToolCall` implements ask-user flows: the session
  pauses until the user responds.
- Cost governance, enforced from stored sessions: max LLM calls and max cost per
  session, daily per-user cost and session caps (group-aware), and a global daily cost
  kill switch per agent type.
- Compaction: implemented, currently flagged off. Keeps the last N turns, replaces older
  turns with per-step summary lines, and re-injects the authoritative design JSON via
  `getCompactionContext` so the LLM never loses the design state.

## Why not a third-party harness

- The DB-serialized stateless model is load-bearing and no harness treats it as
  first-class; they assume a long-lived process owns the session.
- The hard 90% is ours regardless: tool semantics, client-state sync, cost governance,
  destination validation. A harness replaces only the loop and taxes everything else
  with its vocabulary.
- OS-3 requires swappable models down to self-hosted open weights. The AI SDK provider
  abstraction is the boring, credible answer. Anthropic- or OpenAI-centric harnesses
  work against it.
- This is a DPG handed to national IT teams under warranty. Minimalist harnesses are
  young and mostly single-maintainer; a few hundred lines of owned loop is the smaller
  liability, and the OS-5 dependency audit stays small.
- Both apps sharing the hand-rolled pattern keeps the portability seam cheap: tool
  definitions move between the OSS chassis and mwater-server nearly verbatim.

Evaluated pi (pi.dev, badlogic/pi-mono) as the closest minimalist harness. Not adopted;
four ideas taken, below.

## Adopted from pi

- Token-budget compaction. Trigger when context exceeds the window minus a reserve; cut
  by walking back until a recent-token budget is kept. Invariant: never separate a tool
  call from its result. An oversized single turn gets its own prefix summary.
- Structured compaction summaries: fixed skeleton (goal, constraints, progress, key
  decisions, next steps, critical context), fed iteratively into later compactions.
  Authoritative state (current definition, last run status) is still re-injected
  directly, never summarized.
- Steering: `steer()` queues a user message for injection after the current tool
  finishes; `followUp()` queues for after the agent stops. Required once jobs take
  minutes; users must be able to redirect without killing a run.
- Event vocabulary for the UI: `tool_execution_start/update/end`, turn lifecycle, and
  auto-retry events. This is the channel that streams job logs into the design session.

Rejected from pi: tree/branching sessions (built for exploratory CLI coding; snapshot
serialization is simpler and proven), its unified LLM layer (AI SDK stays), skills and
extension system (our equivalent is the integration library and prompts), and its
no-permission stance needed no adopting because it already matches ours: isolation is
the job runner's problem, not the harness's.

## The new harness

Fresh Apache 2.0 implementation of the controller/implementation pattern, plus:

- Async job tools as first-class: `run_snippet` (blocks briefly, falls back to polling)
  and `run_integration` (always async), with job log streaming over the event channel.
- The cold-run gate on `finish` built into the tool contract, not bolted on.
- Steering and token-budget compaction from day one.
- Governance kept, configured by the deployer (they pay the inference bill): per-session
  caps, per-user daily caps, global kill switch.

Improvements proven here back-port to mwater-server when it moves to the runner; the
chassis itself stays app-local on both sides.
