import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  createBashTool,
  keyHint,
  type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component
} from '@earendil-works/pi-tui'

const PREVIEW_LINES = 8
const ANSI_RESET = '\x1b[0m'
const COLOR_ALIASES_ENABLED = process.env.PI_MINI_TERMINAL_COLOR_ALIASES !== '0'

const COLOR_ALIAS_PRELUDE = `
# pi mini-terminal: rich color hints for common command output.
shopt -s expand_aliases 2>/dev/null || true
setopt aliases 2>/dev/null || true
rg() { command rg --color=always "$@"; }
grep() { command grep --color=always "$@"; }
egrep() { command egrep --color=always "$@"; }
fgrep() { command fgrep --color=always "$@"; }
fd() { command fd --color=always "$@"; }
tree() { command tree -C "$@"; }
eza() { command eza --color=always "$@"; }
ls() {
  if command ls --color=always -d . >/dev/null 2>&1; then
    command ls --color=always "$@"
  else
    command ls -G "$@"
  fi
}
`

type MiniTerminalState = {
  startedAt?: number
  endedAt?: number
  interval?: ReturnType<typeof setInterval>
}

type TextBlock = { type: 'text'; text?: string }
type ToolResultLike = { content?: Array<TextBlock | { type: string }> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function commandFromArgs(args: unknown) {
  if (!isRecord(args)) return ''
  const command = args.command
  return typeof command === 'string' ? command : ''
}

function outputFromResult(result: ToolResultLike | undefined) {
  return (result?.content ?? [])
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
}

function shortenPath(path: string | undefined) {
  if (!path) return ''
  const home = homedir()
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
  return path
}

function configuredShellPath() {
  const candidate = process.env.PI_MINI_TERMINAL_SHELL || process.env.SHELL
  return candidate && existsSync(candidate) ? candidate : undefined
}

function shellTitle(shellPath: string | undefined) {
  const rawName = shellPath ? basename(shellPath) : 'bash'
  const name = rawName.replace(/^-/, '').replace(/\.exe$/i, '')
  return name || 'shell'
}

function formatDuration(startedAt: number | undefined, endedAt: number | undefined) {
  if (!startedAt) return ''
  const micros = Math.max(0, Math.round(((endedAt ?? performance.now()) - startedAt) * 1000))
  return `${micros.toLocaleString()}µs`
}

function colorEnv(env: NodeJS.ProcessEnv | undefined) {
  const next: NodeJS.ProcessEnv = { ...(env ?? process.env) }

  delete next.NO_COLOR
  next.FORCE_COLOR = next.FORCE_COLOR ?? '3'
  next.CLICOLOR = next.CLICOLOR ?? '1'
  next.CLICOLOR_FORCE = next.CLICOLOR_FORCE ?? '1'
  next.COLORTERM = next.COLORTERM ?? 'truecolor'
  next.TERM = next.TERM && next.TERM !== 'dumb' ? next.TERM : 'xterm-256color'
  next.NPM_CONFIG_COLOR = next.NPM_CONFIG_COLOR ?? 'always'
  next.PY_COLORS = next.PY_COLORS ?? '1'
  next.YARN_ENABLE_COLORS = next.YARN_ENABLE_COLORS ?? '1'
  next.GREP_COLORS = next.GREP_COLORS ?? 'ms=01;31:mc=01;31:sl=:cx=:fn=35:ln=32:bn=32:se=36'
  next.LSCOLORS = next.LSCOLORS ?? 'ExGxBxDxCxEgEdxbxgxcxd'
  next.LS_COLORS = next.LS_COLORS ?? 'di=1;36:ln=35:so=32:pi=33:ex=1;32:bd=34;46:cd=34;43:su=37;41:sg=30;43:tw=30;42:ow=34;42'

  const gitConfigCount = Number.parseInt(next.GIT_CONFIG_COUNT ?? '0', 10)
  const index = Number.isFinite(gitConfigCount) && gitConfigCount >= 0 ? gitConfigCount : 0
  next.GIT_CONFIG_COUNT = String(index + 1)
  next[`GIT_CONFIG_KEY_${index}`] = 'color.ui'
  next[`GIT_CONFIG_VALUE_${index}`] = 'always'

  return next
}

function withColorPrelude(command: string) {
  if (!COLOR_ALIASES_ENABLED) return command
  return `${COLOR_ALIAS_PRELUDE}\n${command}`
}

function normalizeCarriageReturns(text: string) {
  const lines: string[] = []
  let current = ''

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\r') {
      if (text[index + 1] === '\n') continue
      current = ''
      continue
    }
    if (char === '\n') {
      lines.push(current)
      current = ''
      continue
    }
    if (char === '\b') {
      current = current.slice(0, -1)
      continue
    }
    current += char
  }

  lines.push(current)
  return lines.join('\n')
}

function preserveOnlySafeAnsi(text: string) {
  return text
    // Drop OSC hyperlinks/window-title changes and DCS/PM/APC strings.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    // Keep SGR color/style CSI sequences only; strip cursor movement, clears, etc.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, sequence => sequence.endsWith('m') ? sequence : '')
    // Strip remaining non-CSI escape sequences and C0 controls except tab/newline.
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function safeTerminalOutput(text: string) {
  return preserveOnlySafeAnsi(normalizeCarriageReturns(text)).replace(/\t/g, '    ')
}

function styleAnsiForPi(text: string, theme: any) {
  let themeFg: string | null = null
  let rawFg = ''
  let rawBg = ''
  let bold = false
  let cursor = 0
  let rendered = ''
  const sgrPattern = /\x1b\[([0-9;]*)m/g

  const applyStyle = (chunk: string) => {
    if (!chunk) return ''

    let styled = themeFg ? theme.fg(themeFg, chunk) : chunk
    if (themeFg && bold) styled = theme.bold(styled)

    const rawPrefix = `${!themeFg && bold ? '\x1b[1m' : ''}${rawFg}${rawBg}`
    if (!rawPrefix) return styled

    return `${rawPrefix}${styled}${ANSI_RESET}`
  }

  const colorForCode = (code: number) => {
    switch (code) {
      case 30: return 'muted'
      case 31: return 'error'
      case 32: return 'success'
      case 33: return 'warning'
      case 34: return 'accent'
      case 35: return 'accent'
      case 36: return 'borderMuted'
      case 37: return null
      case 90: return 'dim'
      case 91: return 'error'
      case 92: return 'success'
      case 93: return 'warning'
      case 94: return 'accent'
      case 95: return 'accent'
      case 96: return 'borderMuted'
      case 97: return null
      default: return undefined
    }
  }

  const ansiCode = (...codes: number[]) => `\x1b[${codes.join(';')}m`
  const colorByte = (value: number | undefined) => Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined

  for (const match of text.matchAll(sgrPattern)) {
    rendered += applyStyle(text.slice(cursor, match.index))
    cursor = match.index + match[0].length

    const codes = (match[1] || '0')
      .split(';')
      .map(part => Number.parseInt(part, 10))

    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]
      if (!Number.isFinite(code)) continue

      if (code === 0) {
        themeFg = null
        rawFg = ''
        rawBg = ''
        bold = false
      } else if (code === 1) {
        bold = true
      } else if (code === 22) {
        bold = false
      } else if (code === 39) {
        themeFg = null
        rawFg = ''
      } else if (code === 49) {
        rawBg = ''
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        const mapped = colorForCode(code)
        if (mapped !== undefined) {
          themeFg = mapped
          rawFg = ''
        }
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        rawBg = ansiCode(code)
      } else if (code === 38 || code === 48) {
        const target = code === 38 ? 'fg' : 'bg'
        const mode = codes[index + 1]

        if (mode === 5) {
          const color = colorByte(codes[index + 2])
          if (color !== undefined) {
            if (target === 'fg') {
              themeFg = null
              rawFg = ansiCode(38, 5, color)
            } else {
              rawBg = ansiCode(48, 5, color)
            }
            index += 2
          }
        } else if (mode === 2) {
          const r = colorByte(codes[index + 2])
          const g = colorByte(codes[index + 3])
          const b = colorByte(codes[index + 4])
          if (r !== undefined && g !== undefined && b !== undefined) {
            if (target === 'fg') {
              themeFg = null
              rawFg = ansiCode(38, 2, r, g, b)
            } else {
              rawBg = ansiCode(48, 2, r, g, b)
            }
            index += 4
          }
        }
      }
    }
  }

  rendered += applyStyle(text.slice(cursor))
  return rendered
}

function repeatToWidth(char: string, width: number) {
  return width <= 0 ? '' : char.repeat(width)
}

function ruleLine(left: string, right: string, width: number, styleFill?: (text: string) => string) {
  const rawFill = repeatToWidth('─', Math.max(0, width - visibleWidth(left) - visibleWidth(right)))
  const fill = styleFill ? styleFill(rawFill) : rawFill
  return `${left}${fill}${right}`
}

function statusText(theme: any, state: MiniTerminalState, isPartial: boolean, isError: boolean) {
  if (isPartial) return theme.fg('warning', '● running')
  if (isError) return theme.fg('error', '✕ error')
  if (state.startedAt) return theme.fg('success', '✓ done')
  return theme.fg('muted', 'queued')
}

function contentLine(theme: any, rawContent: string, width: number) {
  if (width <= 4) return truncateToWidth(rawContent, width, '')

  const left = theme.fg('borderMuted', '│ ')
  const right = theme.fg('borderMuted', ' │')
  const innerWidth = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
  const content = truncateToWidth(rawContent, innerWidth, '…')
  const padding = repeatToWidth(' ', Math.max(0, innerWidth - visibleWidth(content)))
  return `${left}${ANSI_RESET}${content}${ANSI_RESET}${padding}${right}`
}

function wrapTerminalLine(line: string, width: number) {
  if (width <= 0) return ['']
  const wrapped = wrapTextWithAnsi(line, width)
  return wrapped.length > 0 ? wrapped : ['']
}

function renderWrappedContent(theme: any, text: string, width: number, expanded: boolean) {
  const innerWidth = Math.max(1, width - 4)
  const logicalLines = text.split('\n')
  const visualLines = logicalLines.flatMap(line => wrapTerminalLine(line, innerWidth))
  const hidden = expanded ? 0 : Math.max(0, visualLines.length - PREVIEW_LINES)
  const shown = hidden > 0 ? visualLines.slice(-PREVIEW_LINES) : visualLines
  const lines: string[] = []

  if (hidden > 0) {
    lines.push(contentLine(theme, theme.fg('muted', `… ${hidden} earlier terminal line${hidden === 1 ? '' : 's'} hidden (${keyHint('app.tools.expand', 'expand')})`), width))
  }

  for (const line of shown) {
    lines.push(contentLine(theme, line, width))
  }

  return lines
}

class MiniTerminalCall implements Component {
  constructor(
    private readonly command: string,
    private readonly cwd: string | undefined,
    private readonly title: string,
    private readonly theme: any,
    private readonly state: MiniTerminalState,
    private readonly isPartial: boolean,
    private readonly isError: boolean
  ) {}

  render(width: number): string[] {
    if (width <= 0) return []

    const border = (text: string) => this.theme.fg('borderMuted', text)
    const title = `${border('╭─')} ${this.theme.fg('accent', this.theme.bold(this.title))}`
    const cwd = shortenPath(this.cwd)
    const cwdText = cwd ? ` ${this.theme.fg('dim', cwd)}` : ''
    const status = ` ${statusText(this.theme, this.state, this.isPartial, this.isError)} ${border('╮')}`
    const top = ruleLine(`${title}${cwdText} `, status, width, text => this.theme.fg('borderMuted', text))
    const commandPrefix = this.theme.fg('success', '$ ')
    const commandLines = wrapTerminalLine(`${commandPrefix}${styleAnsiForPi(safeTerminalOutput(this.command), this.theme) || this.theme.fg('muted', '…')}`, Math.max(1, width - 4))

    return [
      top,
      ...commandLines.map(line => contentLine(this.theme, line, width))
    ]
  }

  invalidate(): void {}
}

class MiniTerminalResult implements Component {
  constructor(
    private readonly output: string,
    private readonly theme: any,
    private readonly state: MiniTerminalState,
    private readonly expanded: boolean,
    private readonly isPartial: boolean,
    private readonly isError: boolean
  ) {}

  render(width: number): string[] {
    if (width <= 0) return []

    const cleaned = styleAnsiForPi(safeTerminalOutput(this.output).trimEnd(), this.theme)
    const body = cleaned
      ? renderWrappedContent(this.theme, cleaned, width, this.expanded)
      : [contentLine(this.theme, this.theme.fg('muted', this.isPartial ? 'waiting for output…' : '(no output)'), width)]

    const duration = formatDuration(this.state.startedAt, this.state.endedAt)
    const left = this.theme.fg('borderMuted', '╰─')
    const metaParts = [
      duration && this.theme.fg('muted', duration),
      this.expanded ? this.theme.fg('muted', 'expanded') : keyHint('app.tools.expand', 'expand')
    ].filter(Boolean)
    const right = `${metaParts.length > 0 ? ` ${metaParts.join(this.theme.fg('dim', ' • '))} ` : ''}${this.theme.fg('borderMuted', '╯')}`

    return [
      ...body,
      ruleLine(left, right, width, text => this.theme.fg('borderMuted', text))
    ]
  }

  invalidate(): void {}
}

function getMiniTerminalState(context: any): MiniTerminalState {
  return context.state as MiniTerminalState
}

export default function miniTerminalBash(pi: ExtensionAPI) {
  const cwd = process.cwd()
  const shellPath = configuredShellPath()
  const title = shellTitle(shellPath)
  const bashTool = createBashTool(cwd, {
    shellPath,
    spawnHook: ({ command, cwd, env }) => ({
      command: withColorPrelude(command),
      cwd,
      env: colorEnv(env)
    })
  })

  pi.registerTool({
    ...bashTool,
    renderShell: 'self',
    execute: async (id, params, signal, onUpdate) => bashTool.execute(id, params, signal, onUpdate),
    renderCall(args, theme, context) {
      const state = getMiniTerminalState(context)
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = performance.now()
        state.endedAt = undefined
      }
      if (!context.isPartial && state.startedAt !== undefined && state.endedAt === undefined) {
        state.endedAt = performance.now()
      }

      return new MiniTerminalCall(
        commandFromArgs(args),
        context.cwd,
        title,
        theme,
        state,
        context.isPartial,
        context.isError
      )
    },
    renderResult(result, options, theme, context) {
      const state = getMiniTerminalState(context)
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = performance.now()
      }
      if (options.isPartial && state.interval === undefined) {
        state.interval = setInterval(() => context.invalidate(), 1000)
        state.interval.unref?.()
      }
      if (!options.isPartial) {
        state.endedAt ??= performance.now()
        if (state.interval !== undefined) {
          clearInterval(state.interval)
          state.interval = undefined
        }
      }

      return new MiniTerminalResult(
        outputFromResult(result),
        theme,
        state,
        options.expanded,
        options.isPartial,
        context.isError
      )
    }
  })
}
