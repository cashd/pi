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
  const milliseconds = Math.max(0, (endedAt ?? performance.now()) - startedAt)
  const maximumFractionDigits = milliseconds < 10 ? 1 : 0
  return `${milliseconds.toLocaleString(undefined, { maximumFractionDigits })}ms`
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

function stripTerminalEscapes(text: string) {
  return text
    // Drop OSC hyperlinks/window-title changes and DCS/PM/APC strings.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    // Strip all CSI/escape sequences, including color/style codes.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    // Strip remaining C0 controls except tab/newline.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function safeTerminalOutput(text: string) {
  return stripTerminalEscapes(normalizeCarriageReturns(text)).replace(/\t/g, '    ')
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
    const commandLines = wrapTerminalLine(`${commandPrefix}${safeTerminalOutput(this.command) || this.theme.fg('muted', '…')}`, Math.max(1, width - 4))

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

    const cleaned = safeTerminalOutput(this.output).trimEnd()
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
  const bashTool = createBashTool(cwd, { shellPath })

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
        state.interval = setInterval(() => context.invalidate(), 100)
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
