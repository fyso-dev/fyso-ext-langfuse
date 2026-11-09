# Langfuse extension

Independent Copier extension for the Fyso Agentic Framework: exports every finished bot conversation from the project's OpenMausBot to [Langfuse](https://langfuse.com) — one trace per conversation root, with each bot turn (including delegations), AI step (model, tokens, cost) and tool call.

It reads OMB's native trace API and sends Langfuse's native OTLP/HTTP ingestion (`/api/public/otel/v1/traces`). It needs no SDK, changes no bot, and works for every engine OMB runs (Claude, Codex, API engines).

## Requirements

- A generated Fyso project with extension slots (D30) and `framework/scripts/run-ext.sh`. Guided setup in the panel needs a framework with D50/D51; older ones use `mise run secrets`.
- A [Langfuse Cloud](https://cloud.langfuse.com) project and its API keys (**Settings → API Keys**).

## Install

Install it from the panel's Marketplace (or `mise run ext:add langfuse`). Then the panel's **Setup** shows a **Connect Langfuse** step: **Open cloud.langfuse.com** goes straight to your project's API keys page; create a key, copy the block Langfuse shows in the new key's dialog, paste it and select **Save and verify**. The step is done when the key authenticates. From a terminal instead:

```sh
mise run ext:add langfuse
mise run secrets          # set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY
mise run langfuse:check   # authenticates and names the Langfuse project
```

The install asks nothing. The whole configuration is Langfuse's own variables, kept encrypted with the project secrets:

| Secret | Required | Meaning |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | yes | `pk-lf-…` |
| `LANGFUSE_SECRET_KEY` | yes | `sk-lf-…` |
| `LANGFUSE_BASE_URL` | no | Empty = Langfuse Cloud EU. `https://us.cloud.langfuse.com` for US; a self-hosted v3.22+ URL also works |

The Dagu workflow `ext-langfuse-sync` exports every 5 minutes; `mise run langfuse:sync` exports now. `mise run doctor` checks the keys. The panel shows a **Langfuse** tile that opens Langfuse Cloud.

## What is sent

| Langfuse | From OMB |
|---|---|
| Trace (session = OMB thread) | One conversation root, tagged `fyso`, `project:<slug>`, `source:<person/routine/bot…>`, `bot:<name>` |
| Agent observation | Each bot turn; a delegated turn nests under the turn that delegated it. Failed turns are `ERROR` |
| Generation | Each AI step: model, tokens (`input`, `output`, `input_cache_read`, `input_cache_creation`) and cost when OMB knows it |
| Tool observation | Each tool call: name, timing, error. Shell commands are named `shell` |

**Never sent:** prompts, replies, tool arguments or outputs (OMB does not keep them in traces), conversation titles and tool details. Cost is sent only when OMB reports one; Langfuse may then estimate the rest from its model prices, so subscription-engine costs in Langfuse are equivalents, not invoices.

Only finished conversations are exported, a minute after they end, from the last two days. A root that later grows (a late delegation) is sent again with the same ids. Exported root ids are kept in `.data/ext/langfuse/state.json` for 30 days. If Langfuse fails, nothing is marked exported and the next run retries.

## Updates and removal

```sh
mise run ext:update langfuse -- --defaults
mise run ext:remove langfuse
```

Removal stops the export and keeps `.data/ext/langfuse/` and the encrypted keys; delete them yourself if wanted. Traces already in Langfuse stay there.

## Development

```sh
mise run test        # mapping and sync against fake OMB/Langfuse servers
mise run packaging   # the real Copier consumer: slots, validation, tagged upgrades
```

[Integration details](docs/integration.md).
