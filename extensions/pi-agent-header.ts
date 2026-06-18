import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import { VERSION } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

const GITHUB_USERNAME = 'cashd'
const TITLE = `pi agent (@${GITHUB_USERNAME})`
const RESET = '\x1b[0m'
type Rgb = [number, number, number]

const DEEP_BLUE: Rgb = [22, 83, 189]
const BLUE: Rgb = [48, 129, 247]
const SKY: Rgb = [93, 171, 255]
const ICE: Rgb = [151, 205, 255]
const PALETTE: Rgb[] = [DEEP_BLUE, BLUE, SKY, ICE, SKY, BLUE]

// Muted blue, roughly the old sky border blended into the dark header bg.
const BORDER_RGB: Rgb = [50, 74, 110]
const PI_WORDMARK = 'pi agent'

function mix(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t)
}

function sampleGradient(position: number): Rgb {
  const wrapped = ((position % 1) + 1) % 1
  const scaled = wrapped * PALETTE.length
  const index = Math.floor(scaled)
  const nextIndex = (index + 1) % PALETTE.length
  const t = scaled - index
  const a = PALETTE[index]!
  const b = PALETTE[nextIndex]!
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]
}

function fg([r, g, b]: Rgb, text: string) {
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`
}

function gradientText(text: string, phase: number) {
  const chars = [...text]
  const span = Math.max(chars.length - 1, 1)
  return chars
    .map((char, index) => {
      if (char === ' ') return char
      return fg(sampleGradient(index / span + phase), char)
    })
    .join('')
}

function getPiWordmark() {
  return [gradientText(PI_WORDMARK, 0.18)]
}

function githubUsername(theme: Theme) {
  return theme.fg('accent', theme.bold(`@${GITHUB_USERNAME}`))
}

function padToWidth(text: string, width: number) {
  const fitted = truncateToWidth(text, width, '…')
  const gap = Math.max(0, width - visibleWidth(fitted))
  const left = Math.floor(gap / 2)

  return `${' '.repeat(left)}${fitted}${' '.repeat(gap - left)}`
}

function renderPinnedBox(lines: string[], width: number) {
  const horizontalPadding = 1
  const border = (text: string) => fg(BORDER_RGB, text)
  const naturalContentWidth = Math.max(...lines.map(line => visibleWidth(line)))
  const boxWidth = Math.min(width, naturalContentWidth + (horizontalPadding * 2) + 2)
  const innerWidth = Math.max(1, boxWidth - 2)
  const contentWidth = Math.max(1, innerWidth - (horizontalPadding * 2))
  const sidePad = ' '.repeat(horizontalPadding)

  return [
    `${border('╭')}${border('─'.repeat(innerWidth))}${border('╮')}`,
    ...lines.map(line => `${border('│')}${sidePad}${padToWidth(line, contentWidth)}${sidePad}${border('│')}`),
    `${border('╰')}${border('─'.repeat(innerWidth))}${border('╯')}`
  ]
}

function renderHeader(theme: Theme, width: number) {
  const lines = width >= 24
    ? [
        ...renderPinnedBox([
          ...getPiWordmark(),
          `${theme.fg('dim', `v${VERSION}`)} ${theme.fg('muted', 'github')} ${githubUsername(theme)}`
        ], width),
        ''
      ]
    : [
        `${gradientText(PI_WORDMARK, 0)} ${theme.fg('dim', `v${VERSION}`)} ${githubUsername(theme)}`,
        ''
      ]

  return lines.map(line => truncateToWidth(line, width, ''))
}

export default function piAgentHeader(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return

    ctx.ui.setTitle(TITLE)
    // Show the same branded header after session replacement commands such as
    // /clear, so the cleared view matches a fresh pi startup.
    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        return renderHeader(theme, width)
      }
    }))
  })

  pi.registerCommand('pi-agent-header', {
    description: 'Restore the pi agent startup header',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('The custom header is only visible in the TUI', 'warning')
        return
      }

      ctx.ui.setTitle(TITLE)
      ctx.ui.setHeader((_tui, theme) => ({
        invalidate() {},
        render(width: number): string[] {
          return renderHeader(theme, width)
        }
      }))
      ctx.ui.notify('Pi agent header restored', 'info')
    }
  })

  pi.registerCommand('builtin-header', {
    description: 'Restore the built-in pi startup header',
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined)
      ctx.ui.notify('Built-in header restored', 'info')
    }
  })
}
