import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import { CustomEditor, VERSION } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

const GITHUB_USERNAME = 'cashd'
const TITLE = `pi (${GITHUB_USERNAME})`
const EMPTY_INPUT_PLACEHOLDER = 'whisper a spell and I’ll chase the bugs…'

function center(text: string, width: number) {
  const textWidth = visibleWidth(text)
  if (textWidth >= width) return truncateToWidth(text, width, '…')

  return `${' '.repeat(Math.floor((width - textWidth) / 2))}${text}`
}

function getPiGlyph(theme: Theme) {
  const accent = (text: string) => theme.fg('accent', text)

  return [
    accent('████████████████'),
    accent('     ███  ███   '),
    accent('     ███  ███   '),
    accent('     ███  ███   '),
    accent('     ███  ███   ')
  ]
}

class PlaceholderEditor extends CustomEditor {
  render(width: number): string[] {
    const lines = super.render(width)
    if (this.getText().length > 0 || lines.length < 3) return lines

    const maxPadding = Math.max(0, Math.floor((width - 1) / 2))
    const paddingX = Math.min(this.getPaddingX(), maxPadding)
    const contentWidth = Math.max(1, width - paddingX * 2)
    const leftPadding = ' '.repeat(paddingX)
    const rightPadding = leftPadding
    const cursor = this.focused ? '\x1b[7m \x1b[0m' : ' '
    const placeholder = truncateToWidth(EMPTY_INPUT_PLACEHOLDER, Math.max(1, contentWidth - 2), '…')
    const text = `${cursor} \x1b[2m${placeholder}\x1b[22m`
    const padding = ' '.repeat(Math.max(0, contentWidth - visibleWidth(text)))

    lines[1] = `${leftPadding}${text}${padding}${rightPadding}`
    return lines
  }
}

function setCashdEditor(ctx: { ui: { setEditorComponent: (factory: unknown) => void } }) {
  ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => new PlaceholderEditor(tui, theme, keybindings))
}

function renderHeader(theme: Theme, width: number) {
  const minWidthForGraphic = 42
  const lines: string[] = []

  if (width >= minWidthForGraphic) {
    for (const line of getPiGlyph(theme)) lines.push(center(line, width))
  }

  lines.push(center(theme.fg('accent', theme.bold('pi')) + theme.fg('muted', ` (${GITHUB_USERNAME})`), width))
  lines.push(center(theme.fg('muted', `github ${GITHUB_USERNAME}`), width))
  lines.push(center(theme.fg('muted', `v${VERSION}`), width))
  lines.push(center('baller god mode', width))
  lines.push('')

  return lines.map(line => truncateToWidth(line, width, ''))
}

export default function cashdHeader(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return

    ctx.ui.setTitle(TITLE)
    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        return renderHeader(theme, width)
      }
    }))
    setCashdEditor(ctx)
  })

  pi.registerCommand('cashd-header', {
    description: 'Restore the custom pi (cashd) startup header',
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
      setCashdEditor(ctx)
      ctx.ui.notify('Custom pi (cashd) header restored', 'info')
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
