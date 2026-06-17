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

The customized powerline footer is tracked directly under `extensions/cashd-powerline-footer/`.
The override script is still safe to rerun after package updates; it reapplies generated `npm/`
package tweaks when those packages are present:

- keeps legacy `pi-powerline-footer` installs aligned with the local footer styling
- shortens MCP connection status text
