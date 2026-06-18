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
const COMMAND_PREVIEW_LINES = 4
const COMMAND_PREVIEW_HEAD_LINES = 2
const COMMAND_PREVIEW_TAIL_LINES = 1
const COMMAND_MIN_PATH_WIDTH = 24
const COMMAND_MAX_PATH_WIDTH = 56
const LONG_PATH_SEGMENT_THRESHOLD = 5
const ANSI_RESET = '\x1b[0m'
const PATH_CANDIDATE_RE = /(^|[\s"'([{=,])((?:~|\.{1,2}|\/|[A-Za-z]:[\\/])(?:[^\s"'`|;(){}\[\]<>,:]+[\\/])*[^\s"'`|;(){}\[\]<>,:]+|(?:[A-Za-z0-9_.@+-]+[\\/]){2,}[^\s"'`|;(){}\[\]<>,:]+)/g

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

type CollapsedPath = { text: string; collapsed: boolean }
type CommandDisplayText = { text: string; collapsedPaths: number }

function pathSeparatorFor(path: string) {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function splitPath(path: string) {
  const separator = pathSeparatorFor(path)
  let root = ''
  let rest = path
  const driveRoot = /^[A-Za-z]:[\\/]/.exec(path)?.[0]

  if (driveRoot) {
    root = driveRoot
    rest = path.slice(driveRoot.length)
  } else if (path.startsWith('~/') || path.startsWith('~\\')) {
    root = path.slice(0, 2)
    rest = path.slice(2)
  } else if (path.startsWith('/') || path.startsWith('\\')) {
    root = path[0] ?? ''
    rest = path.replace(/^[\\/]+/, '')
  } else {
    const relativeRoot = /^(?:(?:\.|\.\.)[\\/])+/.exec(path)?.[0]
    if (relativeRoot) {
      root = relativeRoot
      rest = path.slice(relativeRoot.length)
    }
  }

  return {
    root,
    separator,
    segments: rest.split(/[\\/]+/).filter(Boolean),
    trailingSeparator: /[\\/]$/.test(rest),
  }
}

function joinCollapsedPath(root: string, separator: string, head: string[], tail: string[], trailingSeparator: boolean) {
  const body = [...head, '…', ...tail].join(separator)
  const prefix = root && body && !root.endsWith('/') && !root.endsWith('\\') ? `${root}${separator}` : root
  const suffix = trailingSeparator && body && !body.endsWith(separator) ? separator : ''
  return `${prefix}${body}${suffix}`
}

function truncateStartToWidth(text: string, maxWidth: number) {
  if (maxWidth <= 0) return ''
  if (visibleWidth(text) <= maxWidth) return text
  if (maxWidth <= visibleWidth('…')) return truncateToWidth('…', maxWidth, '')

  let tail = ''
  for (const char of Array.from(text).reverse()) {
    const candidate = `${char}${tail}`
    if (visibleWidth(`…${candidate}`) > maxWidth) break
    tail = candidate
  }

  return `…${tail}`
}

function collapsePathCandidate(rawPath: string, maxWidth: number): CollapsedPath {
  const compactPath = shortenPath(rawPath)
  const parts = splitPath(compactPath)
  const shouldCollapseDirs = parts.segments.length >= LONG_PATH_SEGMENT_THRESHOLD || visibleWidth(compactPath) > maxWidth

  if (!shouldCollapseDirs) {
    return { text: compactPath, collapsed: compactPath !== rawPath }
  }

  for (const tailCount of [3, 2, 1]) {
    const headCount = parts.segments.length > tailCount + 1 ? 1 : 0
    const head = parts.segments.slice(0, headCount)
    const tail = parts.segments.slice(Math.max(headCount, parts.segments.length - tailCount))
    const candidate = joinCollapsedPath(parts.root, parts.separator, head, tail, parts.trailingSeparator)
    const text = visibleWidth(candidate) <= maxWidth ? candidate : truncateStartToWidth(candidate, maxWidth)

    if (visibleWidth(text) <= maxWidth) {
      return { text, collapsed: text !== rawPath }
    }
  }

  const text = truncateStartToWidth(compactPath, maxWidth)
  return { text, collapsed: text !== rawPath }
}

function collapseCommandPaths(command: string, maxPathWidth: number): CommandDisplayText {
  let collapsedPaths = 0
  const text = command.replace(PATH_CANDIDATE_RE, (_match: string, prefix: string, rawPath: string) => {
    const collapsed = collapsePathCandidate(rawPath, maxPathWidth)
    if (collapsed.collapsed) collapsedPaths += 1
    return `${prefix}${collapsed.text}`
  })

  return { text, collapsedPaths }
}

function commandDisplayText(command: string, width: number, expanded: boolean): CommandDisplayText {
  const cleaned = safeTerminalOutput(command)
  if (expanded) return { text: cleaned, collapsedPaths: 0 }

  const maxPathWidth = Math.max(
    COMMAND_MIN_PATH_WIDTH,
    Math.min(COMMAND_MAX_PATH_WIDTH, Math.floor(width * 0.45)),
  )
  return collapseCommandPaths(cleaned, maxPathWidth)
}

function commandHiddenHint(theme: any, hiddenLines: number, collapsedPaths: number) {
  const details = [`${hiddenLines} wrapped command line${hiddenLines === 1 ? '' : 's'} hidden`]
  if (collapsedPaths > 0) {
    details.push(`${collapsedPaths} path${collapsedPaths === 1 ? '' : 's'} collapsed`)
  }
  return theme.fg('muted', `… ${details.join(', ')} (${keyHint('app.tools.expand', 'expand')})`)
}

function renderCommandLines(theme: any, command: string, width: number, expanded: boolean) {
  const innerWidth = Math.max(1, width - 4)
  const display = commandDisplayText(command, innerWidth, expanded)
  const commandText = display.text || theme.fg('muted', '…')
  const logicalLines = commandText.split('\n')
  const visualLines = logicalLines.flatMap((line, index) => {
    const prefix = index === 0 ? theme.fg('success', '$ ') : theme.fg('muted', '  ')
    return wrapTerminalLine(`${prefix}${line}`, innerWidth)
  })

  if (expanded || visualLines.length <= COMMAND_PREVIEW_LINES) {
    return visualLines.map(line => contentLine(theme, line, width))
  }

  const headCount = Math.min(COMMAND_PREVIEW_HEAD_LINES, visualLines.length)
  const tailCount = Math.min(COMMAND_PREVIEW_TAIL_LINES, Math.max(0, visualLines.length - headCount))
  const hiddenLines = Math.max(0, visualLines.length - headCount - tailCount)
  const shown = [
    ...visualLines.slice(0, headCount),
    commandHiddenHint(theme, hiddenLines, display.collapsedPaths),
    ...visualLines.slice(visualLines.length - tailCount),
  ]

  return shown.map(line => contentLine(theme, line, width))
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
    private readonly expanded: boolean,
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

    return [
      top,
      ...renderCommandLines(this.theme, this.command, width, this.expanded)
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
        Boolean(context.expanded),
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
