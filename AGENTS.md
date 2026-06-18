# PI AGENT WORKSPACE

**Updated:** 2026-06-18

Personal Pi agent workspace at `~/.pi/agent`. Keep this file concise: it is loaded as global context for every Pi session.

## Structure

```text
.pi/agent/
├── AGENTS.md                 # Global agent guidance and workspace map
├── README.md                 # Human-facing restore and maintenance notes
├── package.json              # Active root scripts for Pi code validation
├── tsconfig.json             # Shared TypeScript fixture for Pi code
├── settings.json             # Pi settings; edit only when explicitly requested
├── extensions/               # User-authored Pi extensions
│   ├── cashd-powerline-footer/ # Package-style extension
│   ├── baller-header.ts        # Header/title customization
│   └── quick-actions.ts        # Shortcut commands
├── themes/                   # User-authored Pi themes
├── scripts/                  # Restore/override helper scripts
└── state/, sessions/, npm/, bin/, node-shim/ # Runtime/generated; ignored
```

## Where to look

| Task | Location |
|------|----------|
| Global agent guidance | `AGENTS.md` |
| Restore/setup notes | `README.md` |
| Validate Pi TypeScript code | `package.json` scripts |
| Shared TS compiler assumptions | `tsconfig.json` |
| Pi defaults/packages/theme | `settings.json` |
| Header/title customization | `extensions/baller-header.ts` |
| Footer/editor/bash mode UI | `extensions/cashd-powerline-footer/` |
| Theme colors | `themes/` and `extensions/cashd-powerline-footer/theme.ts` |
| Package override helpers | `scripts/` |

## Commands

```bash
npm run check                 # Run tracked validation suite
npm run build:extensions      # Bundle extension entry points to /tmp
pi update                     # Update Pi and configured packages
node scripts/apply-powerline-overrides.mjs
```

## Conventions

- Treat this directory as the active root workspace for Pi code.
- Keep detailed docs near the relevant code; keep global `AGENTS.md` short and navigational.
- TypeScript is ESM-only. Prefer strict, explicit types for extension APIs and autocomplete providers.
- Use `bun build --external=@earendil-works/...` for quick extension bundle checks.
- Do not edit `settings.json`, `extensions/`, or tracked themes unless the user asks for that specific area.
- Do not modify runtime state, credentials, sessions, generated package installs, or machine-local trust files.
- Never hardcode secrets, private model IDs, tokens, or machine-local paths into tracked docs, tests, fixtures, or source comments.

## Search and Pi docs rules

- `ffgrep` and `fffind` path constraints must be relative to the current workspace/repo. Never pass absolute paths to their `path` argument.
- When searching absolute paths outside the workspace, use `bash` with `grep`, `rg`, or `find` instead.
- Pi documentation paths under `/Users/cashd/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent` are outside this workspace; read known files with `read`, and search them with `bash`/`grep` or `rg` rather than `ffgrep`.

## Anti-patterns

- Installing dependencies just to inspect code when `rg`, `read`, or `bun build --external` is enough.
- Committing `node_modules/`, `npm/`, `bin/`, `node-shim/`, `state/`, `sessions/`, auth files, MCP caches, or OAuth tokens.
- Large generated outputs in global context files.
- Copying another Pi setup verbatim; adapt paths and commands to this active root workspace.
