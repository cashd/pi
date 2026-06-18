# Global agent instructions

- `ffgrep` and `fffind` path constraints must be relative to the current workspace/repo. Never pass absolute paths to their `path` argument.
- When searching absolute paths outside the workspace, use `bash` with `grep`, `rg`, or `find` instead.
- Pi documentation paths under `/Users/cashd/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent` are outside the default `~/.pi/agent` workspace; read known files with `read`, and search them with `bash`/`grep` rather than `ffgrep`.
