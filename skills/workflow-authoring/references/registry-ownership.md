# Dynamic registry ownership

Model routes and agent types are dynamic references. Their shape and owner are documented, but available names depend on active user/project configuration and are intentionally absent from static skill files.

## Model routes

The model-tier configuration (`.pi/workflows/model-tiers.json`, edited via `/workflows-models`) owns route names. Standard routes are `small`, `medium`, and `big`; use another route only when its name and purpose are supplied in context. A route is selected with `tier`; an exact user-requested model is selected with `model`. A tier whose configured entry is the `inherit:main` sentinel resolves to the active chat session model instead of a fixed provider spec (model-tier-config.ts), so a `big` tier can track whatever model the user is currently on.

## Agent types

The agent registry owns agent-type names and their bound instructions, tools, model, and isolation policy. Use `agentType` only when context supplies both its name and purpose. Do not infer an agent type from a role-like label.

## Provider pool

The workflow-settings editor owns a `providerPool` setting — user-level `.pi/workflows/settings.json` or the per-project settings file (`.pi/workflows/projects/<key>/settings.json`), field type `providerPool` (workflow-settings-fields.ts); the headless JSON override is `PI_WORKFLOW_PROVIDER_POOL`. It adds no route names: routing names still come from model-tiers.json, and the pool only maps each resolved logical model id to per-provider rate/concurrency entries. The visual editor writes four scalars — `enabled`, `whenSaturated` (`"wait"` or `"fail"`), `saturationWaitTimeoutMs`, `defaultTpmWindowMs` — plus a `models` map of logical model id → per-provider rows carrying `concurrency`, `weight`, `tpm`, and `cooldownMs`. It is edited as form rows, never as a raw JSON blob.

## Priority

Routing priority is explicit `model` > `agentType` model > `tier` > phase model > metadata model > implicit `medium` > session default. Higher priority means selection, not "try this then fall back to the next selector." Avoid specifying competing selectors unless deliberately overriding a lower-priority default.

Unavailability is asymmetric by design. An explicit `model`, `agentType` model, `tier`, or phase model that resolves to a model the registry doesn't have throws — it never silently runs a different model instead. A tier failure names its source (for example: `tier "big" from model-tiers.json resolves to "deadprov/x", which is not available`), so the mistake is traceable back to the config that caused it. Only the implicit default `medium` tier — the route an UNTAGGED agent gets routed through when the script requested no `model`, `tier`, `agentType`, or phase model — degrades to the session default when it is unavailable, since that agent never asked for that specific model; the degrade still logs a one-time warning into the run so it stays discoverable instead of silent.
