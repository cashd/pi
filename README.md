# Pi agent config

Personal Pi configuration tracked with Git.

Tracked intentionally:

- `settings.json` — default model/provider/theme and installed Pi packages
- `keybindings.json` — custom keybindings, when present
- `extensions/`, `skills/`, `prompts/`, `themes/` — user-authored Pi resources, when present
- `scripts/` — setup/restore helpers for package-level customizations

Ignored intentionally:

- `auth.json` and `.env*` — credentials/secrets
- `trust.json` — machine-local project trust decisions
- MCP caches/onboarding state and OAuth tokens
- generated binaries and package install output (`bin/`, `npm/`)
- sessions / `*.jsonl`, which may contain conversation or code context

## Restore

```bash
pi update
node ~/.pi/agent/scripts/apply-powerline-overrides.mjs
```

The override script reapplies local `pi-powerline-footer` tweaks that live inside the generated
`npm/` install directory:

- removes the subscription `(sub)`/cost segment from the default preset
- uses provider-specific model icons (`✻` Claude, `◎` ChatGPT/OpenAI, `⌘` Codex)
- changes the context icon to `ctx`
