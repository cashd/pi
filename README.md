# Pi agent workspace

Personal Pi configuration tracked with Git. This repo is the active root workspace for global Pi code under `~/.pi/agent`.

<img width="1234" height="1305" alt="image" src="https://github.com/user-attachments/assets/df277dae-d5de-4a76-a14c-9617fc1bc4e5" />


## Structure

```text
.pi/agent/
├── AGENTS.md                 # Global agent guidance and workspace map
├── README.md                 # Restore and maintenance notes
├── package.json              # Root scripts for validating Pi code
├── tsconfig.json             # Shared TypeScript fixture
├── settings.json             # Pi defaults, packages, theme
├── extensions/               # User-authored Pi extensions
├── themes/                   # User-authored themes
├── scripts/                  # Restore/override helpers
└── state/, sessions/, npm/   # Runtime/generated state; ignored
```

## Active TypeScript workspace

Package-style global extensions remain in `extensions/` so Pi can auto-discover them from:

- `~/.pi/agent/extensions/*.ts`
- `~/.pi/agent/extensions/*/index.ts`

The root `package.json` provides common validation commands without requiring generated package state to be committed.

```bash
npm run check
npm run build:extensions
```

## Tracked intentionally

- `AGENTS.md` — global agent instructions and workspace map
- `README.md` — human-facing restore and maintenance docs
- `package.json` / `tsconfig.json` — active root code fixture for Pi TypeScript
- `settings.json` — default model/provider/theme and installed Pi packages
- `keybindings.json` — custom keybindings, when present
- `extensions/`, `skills/`, `prompts/`, `themes/` — user-authored Pi resources, when present
- `scripts/` — setup/restore helpers for package-level customizations

## Ignored intentionally

- `auth.json` and `.env*` — credentials/secrets
- `trust.json` — machine-local project trust decisions
- MCP caches/onboarding state and OAuth tokens
- generated binaries and package install output (`bin/`, `npm/`, `node-shim/`, `node_modules/`)
- runtime state (`state/`) and sessions / `*.jsonl`, which may contain conversation or code context

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

After changing extension code, reload Pi with `/reload` or restart the TUI.
