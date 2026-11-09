# Integration behavior

This repository owns the exporter, its Dagu schedule, its secret names and its panel tile. The framework provides extension slots (D30), `run-ext.sh` (decrypted secrets for the declared names only), Dagu and OMB.

## Why OMB traces, not engine hooks

Langfuse's own Claude Code and Codex integrations are per-engine Stop hooks that read session transcripts. In a Fyso project they would need a hook in a template-owned `.claude/settings.json`, Langfuse keys in every bot's environment, a pinned Python SDK, and a different mechanism per engine. OMB already records one engine-neutral trace per conversation — the same source the framework's observability uses (D26) — so one exporter covers every engine with no change to bots.

Trade-off: Langfuse shows structure, timing, tokens and cost, not prompt/response content. That matches D26's privacy rule (no message bodies leave native stores).

## Sources (OpenMausBot 0.1.141)

- `GET /api/usage/traces?from&to&limit&offset` — root summaries (`id`, `title`, `source`, `startedAt`, `endedAt`, `running`, `bots`, `steps`, `tools`…), newest first.
- `GET /api/usage/traces/<id>?at=<startedAt>` — `{root, turns:[turn]}` where a turn holds `step`, `tool`, `group` and child `turn` items (`usage-trace/build.js: traceTurn`).

Span lines keep names, times, token counts and one clipped, redacted detail; never arguments, outputs, prompts or replies (`usage-trace/spans.js`). One exception was found with real data: Codex shell calls are **named** by their raw command line. The exporter replaces any tool name that is not an identifier with `shell`.

## Configuration

None at install time. The extension reads Langfuse's standard variables from the project's encrypted secrets: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and the optional `LANGFUSE_BASE_URL` (empty means Langfuse Cloud EU). Titles and tool details are never sent, so there is no privacy switch.

## Mapping

- Trace id = 32 hex of `sha256("fyso:<project>:trace:<root id>")`; span ids = 16 hex of the root, item kind and OMB item id. Re-exports reuse them, and two projects never collide.
- Trace attributes are set on every span (`langfuse.trace.name`, `langfuse.session.id`, `langfuse.trace.tags`, `langfuse.trace.metadata.*`) as Langfuse recommends for filtering.
- `turn` → `agent`; `step` → `generation` with `langfuse.observation.model.name` (the turn's model), `usage_details` and `cost_details.total` only when OMB has a cost; `tool` → `tool`; `group` is flattened into its items.
- OMB counts cached input and cache writes inside `input`; the exporter sends the uncached remainder as `input` so nothing is counted twice, and an explicit `total`.
- Error turns and tools set OTLP status `ERROR` with OMB's reason as the message.

## Delivery

- Roots are due when finished for 60 s and not exported, or when their end time or item count changed.
- Batches of 20 roots per OTLP request. State is written after every accepted batch (0600, `.data/ext/langfuse/`), so a failure never re-sends an accepted batch nor marks a rejected one.
- Requests time out after 15 s, refuse redirects (Basic credentials never follow one) and cap responses at 1 MiB. `LANGFUSE_BASE_URL` (default Langfuse Cloud EU) must be HTTPS, or HTTP on loopback.
- Keys are `LANGFUSE_*`, not `BOT_*`: `run-omb.sh` never passes them to bots.

## Verification

- `tests/langfuse.test.cjs`: URL rules, usage split, full mapping (agents, generations, tools, groups, delegation, errors, deterministic ids, no titles/details/command lines), sync against fake OMB/Langfuse HTTP servers (settle window, running roots, idempotency, re-export on growth, failure retry, refused redirects), check.
- `tests/test_packaging.py`: the pinned Copier consumer installs only the slots, renders answers, asks no questions and upgrades between tags.
- Recorded once by hand (see the framework's evidence): a project generated from the framework, the extension installed with `ext:add` from a tag, keys through sops, `mise run doctor` green, and the scheduled Dagu workflow exporting real OMB 0.1.141 traces to a local recording server. Acceptance by a real Langfuse instance is still to be recorded.
