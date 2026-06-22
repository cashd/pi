import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  CONFIG_DIR_NAME,
  createBashToolDefinition,
  getAgentDir,
  isToolCallEventType,
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
const COMMAND_MIN_PATH_WIDTH = 16
const COMMAND_MAX_PATH_WIDTH = 32
const OUTPUT_MIN_PATH_WIDTH = 18
const OUTPUT_MAX_PATH_WIDTH = 36
const LONG_PATH_SEGMENT_THRESHOLD = 5
const BATCH_COLLAPSED_MAX_ENTRIES = 8
const BATCH_COLLAPSED_HEAD_ENTRIES = 3
const BATCH_COLLAPSED_TAIL_ENTRIES = 2
const BATCH_EXPANDED_OUTPUT_LINES = 6
const ANSI_RESET = '\x1b[0m'
const META_KEY = '__cashdMiniTerminalBashBatch'
const PATH_CANDIDATE_RE = /(^|[\s"'([{=,])((?:~|\.{1,2}|\/|[A-Za-z]:[\\/])(?:[^\s"'`|;(){}\[\]<>,:]+[\\/])*[^\s"'`|;(){}\[\]<>,:]+|(?:[A-Za-z0-9_.@+-]+[\\/]){2,}[^\s"'`|;(){}\[\]<>,:]+)/g

type MiniTerminalState = {
  startedAt?: number
  endedAt?: number
  interval?: ReturnType<typeof setInterval>
}

type MiniTerminalBashSettings = {
  batchMode: boolean
}

type BashBatchEntryStatus = 'queued' | 'running' | 'success' | 'error'

type BashBatchEntry = {
  toolCallId: string
  command: string
  commandComplete: boolean
  cwd: string
  status: BashBatchEntryStatus
  startedAt?: number
  endedAt?: number
  output: string
  lineCount?: number
  exitCode?: number
  truncated: boolean
  fullOutputPath?: string
}

type BashBatch = {
  id: string
  anchorToolCallId: string
  entries: BashBatchEntry[]
  inFlight: number
  pendingFinalize: boolean
  done: boolean
}

type BashBatchMeta = {
  batchId: string
  toolCallId: string
}

type TextBlock = { type: 'text'; text?: string }
type ToolCallBlock = { type: 'toolCall'; name?: string }
type AssistantContentBlock = TextBlock | ToolCallBlock | { type: string }
type ToolResultLike = { content?: Array<TextBlock | { type: string }>; details?: unknown }
type BatchRenderItem =
  | { kind: 'entry'; entry: BashBatchEntry }
  | { kind: 'gap'; entries: BashBatchEntry[] }

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

function lastVisibleAssistantBlock(content: unknown): AssistantContentBlock | undefined {
  if (!Array.isArray(content)) return undefined

  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index]
    if (!isRecord(block) || typeof block.type !== 'string') continue
    if (block.type === 'thinking') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length === 0) continue
    return block as AssistantContentBlock
  }

  return undefined
}

function assistantOutputEndsWithBash(message: unknown): boolean {
  if (!isRecord(message) || message.role !== 'assistant') return false
  const block = lastVisibleAssistantBlock(message.content)
  return isRecord(block) && block.type === 'toolCall' && block.name === 'bash'
}

function shortenPath(path: string | undefined) {
  if (!path) return ''
  const home = homedir()
  if (path === home) return '~'
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
  return path
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
  try {
    if (!existsSync(settingsPath)) return {}
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    return isRecord(parsed) ? parsed : {}
  } catch (error) {
    console.debug(`[mini-terminal-bash] Failed to read settings from ${settingsPath}:`, error)
    return {}
  }
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key]
    merged[key] = isRecord(existing) && isRecord(value) && !Array.isArray(existing) && !Array.isArray(value)
      ? mergeSettings(existing, value)
      : value
  }
  return merged
}

function loadSettings(cwd: string, includeProjectSettings: boolean): Record<string, unknown> {
  const globalSettings = readSettingsFile(join(getAgentDir(), 'settings.json'))
  const projectSettings = includeProjectSettings
    ? readSettingsFile(join(cwd, CONFIG_DIR_NAME, 'settings.json'))
    : {}
  return mergeSettings(globalSettings, projectSettings)
}

function parseMiniTerminalBashSettings(settings: Record<string, unknown>): MiniTerminalBashSettings {
  const raw = isRecord(settings.miniTerminalBash) ? settings.miniTerminalBash : {}
  const mode = typeof raw.mode === 'string' ? raw.mode : undefined
  const modeBatch = mode === 'batch' || mode === 'batch-tree' || mode === 'tree'
  const modeMiniTerminal = mode === 'mini-terminal' || mode === 'terminal' || mode === 'classic'
  const batchMode = typeof raw.batchMode === 'boolean'
    ? raw.batchMode
    : modeBatch && !modeMiniTerminal

  return { batchMode }
}

function configuredShellPath(settings: Record<string, unknown>) {
  const settingsShellPath = typeof settings.shellPath === 'string' ? settings.shellPath : undefined
  for (const candidate of [process.env.PI_MINI_TERMINAL_SHELL, settingsShellPath, process.env.SHELL]) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

function configuredCommandPrefix(settings: Record<string, unknown>) {
  return typeof settings.shellCommandPrefix === 'string' ? settings.shellCommandPrefix : undefined
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

function emptyComponent(): Component {
  return { render: () => [], invalidate() {} }
}

function plural(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
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

    if (visibleWidth(candidate) <= maxWidth) {
      return { text: candidate, collapsed: candidate !== rawPath }
    }
  }

  const fallbackTail = parts.segments.slice(-1)
  const fallback = fallbackTail.length > 0
    ? joinCollapsedPath(parts.root, parts.separator, [], fallbackTail, parts.trailingSeparator)
    : compactPath
  const text = truncateStartToWidth(fallback, maxWidth)
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
    Math.min(COMMAND_MAX_PATH_WIDTH, Math.floor(width * 0.28)),
  )
  return collapseCommandPaths(cleaned, maxPathWidth)
}

function outputDisplayText(text: string, width: number, expanded: boolean): CommandDisplayText {
  if (expanded) return { text, collapsedPaths: 0 }

  const maxPathWidth = Math.max(
    OUTPUT_MIN_PATH_WIDTH,
    Math.min(OUTPUT_MAX_PATH_WIDTH, Math.floor(width * 0.30)),
  )
  return collapseCommandPaths(text, maxPathWidth)
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
  const display = outputDisplayText(text, innerWidth, expanded)
  const logicalLines = display.text.split('\n')
  const visualLines = logicalLines.flatMap(line => wrapTerminalLine(line, innerWidth))
  const hidden = expanded ? 0 : Math.max(0, visualLines.length - PREVIEW_LINES)
  const shown = hidden > 0 ? visualLines.slice(-PREVIEW_LINES) : visualLines
  const lines: string[] = []

  if (hidden > 0) {
    const details = [`${hidden} earlier terminal line${hidden === 1 ? '' : 's'} hidden`]
    if (display.collapsedPaths > 0) {
      details.push(`${display.collapsedPaths} path${display.collapsedPaths === 1 ? '' : 's'} collapsed`)
    }
    lines.push(contentLine(theme, theme.fg('muted', `… ${details.join(', ')} (${keyHint('app.tools.expand', 'expand')})`), width))
  } else if (!expanded && display.collapsedPaths > 0) {
    lines.push(contentLine(theme, theme.fg('muted', `… ${display.collapsedPaths} output path${display.collapsedPaths === 1 ? '' : 's'} collapsed (${keyHint('app.tools.expand', 'expand')})`), width))
  }

  for (const line of shown) {
    lines.push(contentLine(theme, line, width))
  }

  return lines
}

function outputDetails(result: ToolResultLike | undefined) {
  const details = isRecord(result?.details) ? result.details : undefined
  const truncation = details && isRecord(details.truncation) ? details.truncation : undefined
  const fullOutputPath = typeof details?.fullOutputPath === 'string' ? details.fullOutputPath : undefined
  return { details, truncation, fullOutputPath }
}

function outputLineCount(output: string, result: ToolResultLike | undefined) {
  const { truncation } = outputDetails(result)
  const outputLines = truncation?.outputLines
  if (typeof outputLines === 'number') return outputLines

  const cleaned = safeTerminalOutput(output).trimEnd()
  if (!cleaned || cleaned === '(no output)') return 0
  return cleaned.split('\n').length
}

function extractExitCode(output: string) {
  const match = safeTerminalOutput(output).match(/Command exited with code (\d+)/)
  if (!match?.[1]) return undefined
  const code = Number.parseInt(match[1], 10)
  return Number.isFinite(code) ? code : undefined
}

function latestMeaningfulLine(output: string) {
  const lines = safeTerminalOutput(output)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''

  const last = lines.at(-1) ?? ''
  if (/^Command (?:exited with code|timed out|aborted)/.test(last) && lines.length > 1) {
    return lines.at(-2) ?? last
  }
  return last === '(no output)' ? '' : last
}

function committedOutputText(output: string, final: boolean) {
  const cleaned = safeTerminalOutput(output)
  if (final) return cleaned

  const lastNewline = cleaned.lastIndexOf('\n')
  return lastNewline === -1 ? '' : cleaned.slice(0, lastNewline)
}

function updateEntryFromResult(entry: BashBatchEntry, result: ToolResultLike | undefined, final = false) {
  const rawOutput = outputFromResult(result)
  const output = committedOutputText(rawOutput, final)
  const { truncation, fullOutputPath } = outputDetails(result)
  entry.output = output
  entry.lineCount = outputLineCount(output, final ? result : { content: [{ type: 'text', text: output }] })
  entry.exitCode = final ? extractExitCode(rawOutput) : undefined
  entry.truncated = Boolean(truncation?.truncated)
  entry.fullOutputPath = fullOutputPath
}

function mergeDetailsWithMeta(details: unknown, meta: BashBatchMeta): Record<string, unknown> {
  if (isRecord(details) && !Array.isArray(details)) {
    return { ...details, [META_KEY]: meta }
  }
  return { [META_KEY]: meta }
}

function getBatchMeta(details: unknown): BashBatchMeta | undefined {
  if (!isRecord(details) || Array.isArray(details)) return undefined
  const raw = details[META_KEY]
  if (!isRecord(raw) || Array.isArray(raw)) return undefined

  const batchId = raw.batchId
  const toolCallId = raw.toolCallId
  return typeof batchId === 'string' && typeof toolCallId === 'string'
    ? { batchId, toolCallId }
    : undefined
}

function commandOneLine(command: string, width: number) {
  const oneLine = safeTerminalOutput(command)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ↵ ')
    .replace(/\s+/g, ' ')
  const display = commandDisplayText(oneLine || '…', Math.max(1, width), false)
  return display.text || '…'
}

function entryDuration(entry: BashBatchEntry) {
  return formatDuration(entry.startedAt, entry.endedAt)
}

function lineCountLabel(lineCount: number | undefined) {
  if (lineCount === undefined) return ''
  return lineCount === 0 ? 'no output' : plural(lineCount, 'line')
}

function entryStatusGlyph(entry: BashBatchEntry, theme: any) {
  switch (entry.status) {
    case 'queued':
      return theme.fg('muted', '◌')
    case 'running':
      return theme.fg('warning', '…')
    case 'success':
      return theme.fg('success', '✓')
    case 'error':
      return theme.fg('error', '✕')
  }
}

function entryMeta(entry: BashBatchEntry) {
  if (entry.status === 'queued') return ['queued']

  const parts: string[] = []
  if (entry.status === 'error' && entry.exitCode !== undefined) {
    parts.push(`exit ${entry.exitCode}`)
  }

  const duration = entryDuration(entry)
  if (duration) parts.push(duration)

  const lines = lineCountLabel(entry.lineCount)
  if (lines && !(entry.status === 'running' && entry.lineCount === 0)) parts.push(lines)
  if (entry.truncated) parts.push('truncated')
  return parts
}

function batchStartedAt(batch: BashBatch) {
  const starts = batch.entries
    .map(entry => entry.startedAt)
    .filter((value): value is number => typeof value === 'number')
  return starts.length > 0 ? Math.min(...starts) : undefined
}

function batchEndedAt(batch: BashBatch) {
  const hasActive = batch.entries.some(entry => entry.status === 'queued' || entry.status === 'running')
  if (hasActive) return undefined

  const ends = batch.entries
    .map(entry => entry.endedAt)
    .filter((value): value is number => typeof value === 'number')
  return ends.length > 0 ? Math.max(...ends) : undefined
}

function batchStatus(batch: BashBatch) {
  const failed = batch.entries.filter(entry => entry.status === 'error').length
  const active = batch.entries.filter(entry => entry.status === 'queued' || entry.status === 'running').length
  return { failed, active }
}

function formatBatchHeader(batch: BashBatch, theme: any, width: number) {
  const { failed, active } = batchStatus(batch)
  const symbol = failed > 0
    ? theme.fg('error', '✕')
    : active > 0
      ? theme.fg('warning', '○')
      : theme.fg('success', '●')
  const parts = [plural(batch.entries.length, 'cmd')]
  const duration = formatDuration(batchStartedAt(batch), batchEndedAt(batch))
  if (duration) parts.push(duration)
  if (failed > 0) parts.push(`${failed} failed`)
  if (active > 0) parts.push(`${active} active`)

  const line = `${symbol} ${theme.fg(failed > 0 ? 'error' : active > 0 ? 'warning' : 'success', 'shell batch')} ${theme.fg('dim', `· ${parts.join(' · ')}`)}`
  return truncateToWidth(line, width, '…')
}

function selectedBatchItems(entries: BashBatchEntry[], expanded: boolean): BatchRenderItem[] {
  const completeEntries = entries.filter(entry => entry.commandComplete)
  if (expanded || completeEntries.length <= BATCH_COLLAPSED_MAX_ENTRIES) {
    return completeEntries.map(entry => ({ kind: 'entry', entry }))
  }

  const visibleIndexes = new Set<number>()
  for (let index = 0; index < Math.min(BATCH_COLLAPSED_HEAD_ENTRIES, completeEntries.length); index++) {
    visibleIndexes.add(index)
  }
  for (let index = Math.max(0, completeEntries.length - BATCH_COLLAPSED_TAIL_ENTRIES); index < completeEntries.length; index++) {
    visibleIndexes.add(index)
  }
  completeEntries.forEach((entry, index) => {
    if (entry.status !== 'success') visibleIndexes.add(index)
  })

  const sorted = [...visibleIndexes].sort((a, b) => a - b)
  const items: BatchRenderItem[] = []
  let cursor = 0
  for (const index of sorted) {
    if (index > cursor) {
      items.push({ kind: 'gap', entries: completeEntries.slice(cursor, index) })
    }
    const entry = completeEntries[index]
    if (entry) items.push({ kind: 'entry', entry })
    cursor = index + 1
  }
  if (cursor < completeEntries.length) {
    items.push({ kind: 'gap', entries: completeEntries.slice(cursor) })
  }
  return items
}

function formatGapLine(entries: BashBatchEntry[], connector: string, theme: any, width: number) {
  const failed = entries.filter(entry => entry.status === 'error').length
  const active = entries.filter(entry => entry.status === 'queued' || entry.status === 'running').length
  const details = [plural(entries.length, 'cmd'), 'hidden']
  if (failed > 0) details.push(`${failed} failed`)
  if (active > 0) details.push(`${active} active`)
  return truncateToWidth(`${theme.fg('borderMuted', connector)}${theme.fg('muted', `… ${details.join(' · ')}`)}`, width, '…')
}

function formatEntryLine(entry: BashBatchEntry, connector: string, theme: any, width: number) {
  const prefix = `${theme.fg('borderMuted', connector)}${entryStatusGlyph(entry, theme)} `
  const metaParts = entryMeta(entry)
  const meta = metaParts.length > 0 ? ` · ${metaParts.join(' · ')}` : ''
  const styledMeta = theme.fg('dim', meta)
  const availableCommandWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(styledMeta))
  const command = truncateToWidth(commandOneLine(entry.command, availableCommandWidth), availableCommandWidth, '…')
  const commandColor = entry.status === 'error' ? 'warning' : 'accent'
  return truncateToWidth(`${prefix}${theme.fg(commandColor, command)}${styledMeta}`, width, '…')
}

function renderChildLine(parentIsLast: boolean, text: string, theme: any, width: number, color: 'muted' | 'warning' = 'muted') {
  const prefix = theme.fg('borderMuted', parentIsLast ? '   ' : '│  ')
  const available = Math.max(1, width - visibleWidth(prefix))
  return `${prefix}${truncateToWidth(theme.fg(color, text), available, '…')}`
}

function outputPreview(entry: BashBatchEntry, expanded: boolean) {
  const cleaned = safeTerminalOutput(entry.output).trimEnd()
  if (!cleaned || cleaned === '(no output)') return { hidden: 0, lines: [] as string[] }

  if (!expanded) {
    const tail = latestMeaningfulLine(cleaned)
    return tail ? { hidden: 0, lines: [`└─ ${tail}`] } : { hidden: 0, lines: [] }
  }

  const lines = cleaned.split('\n').map(line => line.trimEnd()).filter(line => line.length > 0)
  const hidden = Math.max(0, lines.length - BATCH_EXPANDED_OUTPUT_LINES)
  return {
    hidden,
    lines: hidden > 0 ? lines.slice(-BATCH_EXPANDED_OUTPUT_LINES) : lines,
  }
}

function renderEntryChildren(entry: BashBatchEntry, parentIsLast: boolean, expanded: boolean, theme: any, width: number) {
  const shouldShowCollapsedTail = !expanded && (entry.status === 'error' || entry.status === 'running')
  if (!expanded && !shouldShowCollapsedTail) return []

  const preview = outputPreview(entry, expanded)
  const lines: string[] = []
  if (expanded && preview.hidden > 0) {
    lines.push(renderChildLine(parentIsLast, `… ${plural(preview.hidden, 'earlier output line')} hidden`, theme, width))
  }

  const color = entry.status === 'error' ? 'warning' : 'muted'
  for (const line of preview.lines) {
    lines.push(renderChildLine(parentIsLast, line, theme, width, color))
  }

  if (expanded && entry.fullOutputPath) {
    lines.push(renderChildLine(parentIsLast, `Full output: ${shortenPath(entry.fullOutputPath)}`, theme, width, 'warning'))
  }
  return lines
}

class BashBatchTree implements Component {
  constructor(
    private readonly batchId: string,
    private readonly batches: Map<string, BashBatch>,
    private readonly theme: any,
    private readonly expanded: boolean
  ) {}

  render(width: number): string[] {
    if (width <= 0) return []

    const batch = this.batches.get(this.batchId)
    if (!batch) return []

    const safeWidth = Math.max(1, width)
    const lines = [formatBatchHeader(batch, this.theme, safeWidth)]
    const items = selectedBatchItems(batch.entries, this.expanded)

    items.forEach((item, index) => {
      const isLast = index === items.length - 1
      const connector = isLast ? '└─ ' : '├─ '
      if (item.kind === 'gap') {
        lines.push(formatGapLine(item.entries, connector, this.theme, safeWidth))
        return
      }

      lines.push(formatEntryLine(item.entry, connector, this.theme, safeWidth))
      lines.push(...renderEntryChildren(item.entry, isLast, this.expanded, this.theme, safeWidth))
    })

    return lines
  }

  invalidate(): void {}
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

function renderMiniTerminalCall(args: unknown, theme: any, context: any, title: string) {
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
}

function renderMiniTerminalResult(result: ToolResultLike, options: any, theme: any, context: any) {
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

function updateBatchRenderInterval(context: any, batch: BashBatch) {
  const state = getMiniTerminalState(context)
  const active = batch.entries.some(entry => entry.status === 'queued' || entry.status === 'running')

  if (active && state.interval === undefined) {
    state.interval = setInterval(() => context.invalidate(), 250)
    state.interval.unref?.()
  }

  if (!active && state.interval !== undefined) {
    clearInterval(state.interval)
    state.interval = undefined
  }
}

export default function miniTerminalBash(pi: ExtensionAPI) {
  const batches = new Map<string, BashBatch>()
  const toolCallToBatch = new Map<string, string>()
  const toolCallToEntry = new Map<string, BashBatchEntry>()

  let settings: MiniTerminalBashSettings = { batchMode: false }
  let activeBatchId: string | undefined
  let batchCounter = 0

  function clearBatchState(): void {
    batches.clear()
    toolCallToBatch.clear()
    toolCallToEntry.clear()
    activeBatchId = undefined
    batchCounter = 0
  }

  function createBatch(anchorToolCallId: string): BashBatch {
    batchCounter += 1
    const batch: BashBatch = {
      id: `cashd-bash-batch-${batchCounter}`,
      anchorToolCallId,
      entries: [],
      inFlight: 0,
      pendingFinalize: false,
      done: false,
    }
    batches.set(batch.id, batch)
    activeBatchId = batch.id
    return batch
  }

  function ensureBashCall(toolCallId: string, command: string, cwd: string, commandComplete = false) {
    const existingEntry = toolCallToEntry.get(toolCallId)
    const existingBatchId = toolCallToBatch.get(toolCallId)
    const existingBatch = existingBatchId ? batches.get(existingBatchId) : undefined
    if (existingEntry && existingBatch) {
      if (commandComplete) {
        existingEntry.command = command
        existingEntry.commandComplete = true
      }
      existingEntry.cwd = cwd
      return { batch: existingBatch, entry: existingEntry }
    }

    let batch = activeBatchId ? batches.get(activeBatchId) : undefined
    if (!batch || batch.done || batch.pendingFinalize) {
      batch = createBatch(toolCallId)
    }

    const entry: BashBatchEntry = {
      toolCallId,
      command: commandComplete ? command : '',
      commandComplete,
      cwd,
      status: 'queued',
      output: '',
      truncated: false,
    }
    batch.entries.push(entry)
    batch.inFlight += 1
    toolCallToBatch.set(toolCallId, batch.id)
    toolCallToEntry.set(toolCallId, entry)
    return { batch, entry }
  }

  function markActiveBatchPendingFinalize(): void {
    if (!activeBatchId) return
    const batch = batches.get(activeBatchId)
    if (!batch) {
      activeBatchId = undefined
      return
    }

    batch.pendingFinalize = true
    if (batch.inFlight === 0) {
      batch.done = true
      activeBatchId = undefined
    }
  }

  function completeBashCall(toolCallId: string): void {
    const batchId = toolCallToBatch.get(toolCallId)
    if (!batchId) return
    const batch = batches.get(batchId)
    if (!batch) return

    batch.inFlight = Math.max(0, batch.inFlight - 1)
    if (batch.pendingFinalize && batch.inFlight === 0) {
      batch.done = true
      if (activeBatchId === batch.id) activeBatchId = undefined
    }
  }

  pi.on('tool_call', async (event, ctx) => {
    if (!settings.batchMode) return

    if (isToolCallEventType('bash', event)) {
      ensureBashCall(event.toolCallId, event.input.command, ctx.cwd, true)
      return
    }

    markActiveBatchPendingFinalize()
  })

  pi.on('message_update', async (event) => {
    if (!settings.batchMode) return
    if (event.message.role === 'assistant' && !assistantOutputEndsWithBash(event.message)) {
      markActiveBatchPendingFinalize()
    }
  })

  pi.on('message_end', async (event) => {
    if (!settings.batchMode) return
    if (event.message.role === 'assistant' && (event.message.stopReason !== 'toolUse' || !assistantOutputEndsWithBash(event.message))) {
      markActiveBatchPendingFinalize()
    }
  })

  pi.on('agent_end', async () => {
    if (!settings.batchMode) return
    markActiveBatchPendingFinalize()
  })

  pi.on('session_start', async (_event, ctx) => {
    clearBatchState()

    const rawSettings = loadSettings(ctx.cwd, ctx.isProjectTrusted())
    settings = parseMiniTerminalBashSettings(rawSettings)

    const shellPath = configuredShellPath(rawSettings)
    const title = shellTitle(shellPath)
    const commandPrefix = configuredCommandPrefix(rawSettings)
    const bashTool = createBashToolDefinition(ctx.cwd, { shellPath, commandPrefix })

    pi.registerTool({
      ...bashTool,
      renderShell: 'self',
      async execute(toolCallId, params, signal, onUpdate, executeCtx) {
        if (!settings.batchMode) {
          return bashTool.execute(toolCallId, params, signal, onUpdate, executeCtx)
        }

        const { entry } = ensureBashCall(toolCallId, params.command, executeCtx.cwd, true)
        entry.status = 'running'
        entry.startedAt ??= performance.now()
        entry.endedAt = undefined

        const wrappedOnUpdate = onUpdate
          ? (result: any) => {
              updateEntryFromResult(entry, result, false)
              onUpdate(result)
            }
          : undefined

        try {
          const result = await bashTool.execute(toolCallId, params, signal, wrappedOnUpdate, executeCtx)
          updateEntryFromResult(entry, result, true)
          entry.status = 'success'
          entry.endedAt = performance.now()
          return {
            ...result,
            details: mergeDetailsWithMeta(result.details, { batchId: toolCallToBatch.get(toolCallId) ?? '', toolCallId }),
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          updateEntryFromResult(entry, { content: [{ type: 'text', text }] }, true)
          entry.status = 'error'
          entry.endedAt = performance.now()
          throw error
        } finally {
          completeBashCall(toolCallId)
        }
      },
      renderCall(args, theme, context) {
        if (!settings.batchMode) {
          return renderMiniTerminalCall(args, theme, context, title)
        }

        const existingBatchId = toolCallToBatch.get(context.toolCallId)
        if (!existingBatchId && !context.isPartial && !context.executionStarted) {
          return renderMiniTerminalCall(args, theme, context, title)
        }

        const { batch, entry } = ensureBashCall(context.toolCallId, commandFromArgs(args), context.cwd, Boolean(context.argsComplete))
        if (context.executionStarted && entry.status === 'queued') {
          entry.status = 'running'
          entry.startedAt ??= performance.now()
          entry.endedAt = undefined
        }

        if (batch.anchorToolCallId !== context.toolCallId) {
          return emptyComponent()
        }

        updateBatchRenderInterval(context, batch)
        return new BashBatchTree(batch.id, batches, theme, Boolean(context.expanded))
      },
      renderResult(result, options, theme, context) {
        if (!settings.batchMode) {
          return renderMiniTerminalResult(result, options, theme, context)
        }

        const meta = getBatchMeta(result.details)
        const batchId = toolCallToBatch.get(context.toolCallId) ?? meta?.batchId
        if (!batchId || !batches.has(batchId)) {
          return renderMiniTerminalResult(result, options, theme, context)
        }

        return emptyComponent()
      }
    })
  })
}
