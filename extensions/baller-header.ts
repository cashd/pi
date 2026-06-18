import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import { CustomEditor, VERSION } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

const GITHUB_USERNAME = 'cashd'
const TITLE = `pi (${GITHUB_USERNAME})`
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
type Rgb = [number, number, number]

const DEEP_BLUE: Rgb = [22, 83, 189]
const BLUE: Rgb = [48, 129, 247]
const SKY: Rgb = [93, 171, 255]
const ICE: Rgb = [151, 205, 255]
const PALETTE: Rgb[] = [DEEP_BLUE, BLUE, SKY, ICE, SKY, BLUE]

const TITLE_LINES = [
  '  ██████╗  ██╗ ',
  '  ██╔══██╗ ██║ ',
  '  ██████╔╝ ██║ ',
  '  ██╔═══╝  ██║ ',
  '  ██║      ██║ ',
  '  ╚═╝      ╚═╝ ',
]

const EMPTY_INPUT_PLACEHOLDERS = [
  'Do or do not. There is no try…',
  'Make it so…',
  'Roads? Where we’re going, we don’t need roads…',
  'It’s alive! It’s alive…',
  'I love it when a plan comes together…',
  'With great power comes great responsibility…',
  'This is the way…',
  'One does not simply ship to prod…'
]

function getRandomPlaceholder() {
  return EMPTY_INPUT_PLACEHOLDERS[Math.floor(Math.random() * EMPTY_INPUT_PLACEHOLDERS.length)] ?? EMPTY_INPUT_PLACEHOLDERS[0]
}

function center(text: string, width: number) {
  const textWidth = visibleWidth(text)
  if (textWidth >= width) return truncateToWidth(text, width, '…')

  return `${' '.repeat(Math.floor((width - textWidth) / 2))}${text}`
}

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

function getPiGlyph(_theme: Theme) {
  return TITLE_LINES.map((line, row) => gradientText(line, row * 0.045))
}

class PlaceholderEditor extends CustomEditor {
  private readonly emptyInputPlaceholder = getRandomPlaceholder()

  render(width: number): string[] {
    const lines = super.render(width)
    if (this.getText().length > 0 || lines.length < 3) return lines

    const maxPadding = Math.max(0, Math.floor((width - 1) / 2))
    const paddingX = Math.min(this.getPaddingX(), maxPadding)
    const contentWidth = Math.max(1, width - paddingX * 2)
    const leftPadding = ' '.repeat(paddingX)
    const rightPadding = leftPadding
    const cursor = this.focused ? '\x1b[7m \x1b[0m' : ' '
    const placeholder = truncateToWidth(this.emptyInputPlaceholder, Math.max(1, contentWidth - 2), '…')
    const text = `${cursor} \x1b[2m${placeholder}\x1b[22m`
    const padding = ' '.repeat(Math.max(0, contentWidth - visibleWidth(text)))

    lines[1] = `${leftPadding}${text}${padding}${rightPadding}`
    return lines
  }
}

function setBallerEditor(ctx: { ui: { setEditorComponent: (factory: unknown) => void } }) {
  ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => new PlaceholderEditor(tui, theme, keybindings))
}

function renderHeader(theme: Theme, width: number) {
  const minWidthForGraphic = 42
  const lines: string[] = []

  if (width >= minWidthForGraphic) {
    for (const line of getPiGlyph(theme)) lines.push(center(line, width))
  }

  lines.push(`${BOLD}${gradientText(center(`pi (${GITHUB_USERNAME})`, width), 0.18)}${RESET}`)
  lines.push(center(theme.fg('muted', `github ${GITHUB_USERNAME}`), width))
  lines.push(center(theme.fg('muted', `v${VERSION}`), width))
  lines.push(center(theme.fg('muted', 'baller god mode'), width))
  lines.push('')

  return lines.map(line => truncateToWidth(line, width, ''))
}

export default function ballerHeader(pi: ExtensionAPI) {
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
    setBallerEditor(ctx)
  })

  pi.registerCommand('baller-header', {
    description: 'Restore the baller startup header',
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
      setBallerEditor(ctx)
      ctx.ui.notify('Baller header restored', 'info')
    }
  })

  pi.registerCommand('builtin-header', {
    description: 'Restore the built-in pi startup header',
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined)
      ctx.ui.setEditorComponent(undefined)
      ctx.ui.notify('Built-in header restored', 'info')
    }
  })
}
