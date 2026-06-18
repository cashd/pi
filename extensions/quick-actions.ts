import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  type SelectItem
} from '@earendil-works/pi-tui'

const LINEAR_WORKSPACE = process.env.PI_LINEAR_WORKSPACE ?? 'morpho'
const SHORTCUT = Key.ctrlShift('l')
const LEADER = Key.ctrl(Key.space)
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const LINEAR_TICKET_STATUS_KEY = 'linear-ticket'

type QuickAction = {
  id: string
  label: string
  description: string
  keys?: string[]
  run: (ctx: ExtensionContext) => Promise<void>
}

function getLinearIssueId(branch: string | null | undefined) {
  const match = branch?.match(/\b([a-z][a-z0-9]+-\d+)\b/i)
  return match?.[1]?.toUpperCase() ?? null
}

function linearUrl(issueId: string) {
  return `https://linear.app/${LINEAR_WORKSPACE}/issue/${issueId}`
}

async function openUrl(pi: ExtensionAPI, url: string) {
  const platform = process.platform
  if (platform === 'darwin') {
    await pi.exec('open', [url], { timeout: 5_000 })
    return
  }

  if (platform === 'win32') {
    await pi.exec('cmd', ['/c', 'start', '', url], { timeout: 5_000 })
    return
  }

  await pi.exec('xdg-open', [url], { timeout: 5_000 })
}

async function currentBranch(pi: ExtensionAPI): Promise<string | null | undefined> {
  const result = await pi.exec('git', ['branch', '--show-current'], { timeout: 5_000 })
  if (result.code !== 0) return undefined
  return result.stdout.trim() || null
}

function linearBadge(issueId: string) {
  // Bracket-free square highlight. Subtle background, no pill caps.
  return `\x1b[48;5;60m\x1b[38;5;231m ${issueId} \x1b[0m`
}

function publishLinearTicketStatus(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (ctx.mode !== 'tui') return undefined

  let active = true
  let lastIssueId: string | null | undefined
  const update = async () => {
    try {
      const branch = await currentBranch(pi)
      if (!active) return
      // Transient git failures used to clear the badge for one refresh cycle,
      // which looked like flashing. Keep the previous badge until we get a
      // successful branch read.
      if (branch === undefined) return

      const issueId = getLinearIssueId(branch)
      if (issueId === lastIssueId) return

      lastIssueId = issueId
      ctx.ui.setStatus(
        LINEAR_TICKET_STATUS_KEY,
        issueId ? linearBadge(issueId) : undefined
      )
    } catch (error) {
      if (active) console.error('[quick-actions] failed to update Linear ticket status', error)
    }
  }

  void update()
  const interval = setInterval(() => void update(), 10_000)
  interval.unref?.()

  return () => {
    active = false
    clearInterval(interval)
  }
}

async function ghUrl(pi: ExtensionAPI, args: string[]) {
  const result = await pi.exec('gh', args, { timeout: 10_000 })
  return result.code === 0 ? result.stdout.trim() || null : null
}

async function currentPrUrl(pi: ExtensionAPI) {
  return ghUrl(pi, ['pr', 'view', '--json', 'url', '--jq', '.url'])
}

async function currentBranchUrl(pi: ExtensionAPI) {
  return ghUrl(pi, ['browse', '--branch', '--no-browser'])
}

async function repoUrl(pi: ExtensionAPI) {
  return ghUrl(pi, ['repo', 'view', '--json', 'url', '--jq', '.url'])
}

async function currentCommitUrl(pi: ExtensionAPI) {
  return ghUrl(pi, ['browse', '--commit', '--no-browser'])
}

type LeaderRoute = {
  keys: string[]
  label: string
  description: string
  run: (ctx: ExtensionContext) => Promise<void>
}

function routeKey(route: LeaderRoute) {
  return route.keys.join('')
}

function routeMatchesPrefix(route: LeaderRoute, prefix: string[]) {
  return prefix.every((key, index) => route.keys[index] === key)
}

function routeIsComplete(route: LeaderRoute, prefix: string[]) {
  return route.keys.length === prefix.length && routeMatchesPrefix(route, prefix)
}

function printableKey(data: string) {
  return data.length === 1 && data >= ' ' && data <= '~' ? data.toLowerCase() : null
}

function overlaySelectListTheme(theme: any) {
  return {
    selectedPrefix: (text: string) => theme.fg('accent', text),
    selectedText: (text: string) => theme.fg('accent', text),
    description: (text: string) => theme.fg('muted', text),
    scrollInfo: (text: string) => theme.fg('dim', text),
    noMatch: (text: string) => theme.fg('warning', text)
  }
}

function powerlineSafeOverlayOptions<T extends object>(options: T): T & { preservePowerline: true } {
  // Custom marker consumed by cashd-powerline-footer's fixed editor compositor.
  // Pi's overlay system ignores unknown option fields.
  return { ...options, preservePowerline: true } as T & { preservePowerline: true }
}

function renderOverlayBox(
  theme: any,
  title: string,
  hint: string,
  content: string[],
  width: number
) {
  const innerWidth = Math.max(1, width - 2)
  const border = (text: string) => theme.fg('dim', text)
  const row = (text: string) =>
    `${border('│')}${truncateToWidth(text, innerWidth, '…', true)}${border('│')}`

  return [
    border(`╭${'─'.repeat(innerWidth)}╮`),
    row(theme.fg('accent', theme.bold(title))),
    border(`├${'─'.repeat(innerWidth)}┤`),
    ...content.map(row),
    border(`├${'─'.repeat(innerWidth)}┤`),
    row(theme.fg('dim', hint)),
    border(`╰${'─'.repeat(innerWidth)}╯`)
  ]
}

export default function quickActions(pi: ExtensionAPI) {
  let cleanupLinearTicketStatus: (() => void) | undefined

  pi.on('session_start', (_event, ctx) => {
    cleanupLinearTicketStatus?.()
    cleanupLinearTicketStatus = publishLinearTicketStatus(pi, ctx)
  })

  pi.on('session_shutdown', () => {
    cleanupLinearTicketStatus?.()
    cleanupLinearTicketStatus = undefined
  })

  async function openLinearTicket(ctx: ExtensionContext) {
    const issueId = getLinearIssueId(await currentBranch(pi))
    if (!issueId) {
      ctx.ui.notify('No Linear issue id found in the current branch', 'warning')
      return
    }

    await openUrl(pi, linearUrl(issueId))
    ctx.ui.notify(`Opened ${issueId} in Linear`, 'info')
  }

  async function openGithubPr(ctx: ExtensionContext) {
    const url = await currentPrUrl(pi)
    if (!url) {
      ctx.ui.notify('No GitHub PR found for the current branch', 'warning')
      return
    }

    await openUrl(pi, url)
    ctx.ui.notify('Opened PR in browser', 'info')
  }

  async function openGithubRepo(ctx: ExtensionContext) {
    const url = await repoUrl(pi)
    if (!url) {
      ctx.ui.notify('Could not resolve GitHub repository URL', 'warning')
      return
    }

    await openUrl(pi, url)
    ctx.ui.notify('Opened repository in browser', 'info')
  }

  async function openGithubBranch(ctx: ExtensionContext) {
    const url = await currentBranchUrl(pi)
    if (!url) {
      ctx.ui.notify('Could not resolve current branch URL', 'warning')
      return
    }

    await openUrl(pi, url)
    ctx.ui.notify('Opened branch in browser', 'info')
  }

  async function openGithubActions(ctx: ExtensionContext) {
    const url = await repoUrl(pi)
    if (!url) {
      ctx.ui.notify('Could not resolve GitHub repository URL', 'warning')
      return
    }

    await openUrl(pi, `${url}/actions`)
    ctx.ui.notify('Opened GitHub Actions in browser', 'info')
  }

  async function openGithubCommit(ctx: ExtensionContext) {
    const url = await currentCommitUrl(pi)
    if (!url) {
      ctx.ui.notify('Could not resolve current commit URL', 'warning')
      return
    }

    await openUrl(pi, url)
    ctx.ui.notify('Opened current commit in browser', 'info')
  }

  function togglePowerlineDisplay(target: 'branch' | 'branch-truncation' | 'cache') {
    return async (ctx: ExtensionContext) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('Powerline display toggles are only available in the TUI', 'warning')
        return
      }

      pi.events.emit('powerline:toggle-display', { target, mode: 'toggle' })
    }
  }

  const actions: QuickAction[] = [
    {
      id: 'github.openRepo',
      label: 'Open GitHub repository',
      description: 'Open the repository in browser',
      keys: ['g', 'r', 'o'],
      run: openGithubRepo
    },
    {
      id: 'github.openBranch',
      label: 'Open GitHub branch',
      description: 'Open the current branch in browser',
      keys: ['g', 'b', 'o'],
      run: openGithubBranch
    },
    {
      id: 'github.openPr',
      label: 'Open GitHub PR',
      description: 'Open the pull request for the current branch',
      keys: ['g', 'p', 'o'],
      run: openGithubPr
    },
    {
      id: 'github.openActions',
      label: 'Open GitHub Actions',
      description: 'Open repository Actions in browser',
      keys: ['g', 'a', 'o'],
      run: openGithubActions
    },
    {
      id: 'github.openCommit',
      label: 'Open current commit',
      description: 'Open HEAD commit in browser',
      keys: ['g', 'c', 'o'],
      run: openGithubCommit
    },
    {
      id: 'linear.openTicket',
      label: 'Open Linear ticket',
      description: 'Open the issue inferred from the current branch name',
      run: openLinearTicket
    },
    {
      id: 'powerline.toggleBranch',
      label: 'Toggle powerline branch name',
      description: 'Show or hide the branch name in the powerline git segment',
      keys: ['p', 'b'],
      run: togglePowerlineDisplay('branch')
    },
    {
      id: 'powerline.toggleBranchTruncation',
      label: 'Toggle powerline branch truncation',
      description: 'Enable or disable middle truncation of long branch names',
      keys: ['p', 't'],
      run: togglePowerlineDisplay('branch-truncation')
    },
    {
      id: 'powerline.toggleCache',
      label: 'Toggle powerline cache segments',
      description: 'Show or hide cache read/write segments in the powerline',
      keys: ['p', 'c'],
      run: togglePowerlineDisplay('cache')
    }
  ]

  async function showEffortPicker(ctx: ExtensionContext) {
    const current = pi.getThinkingLevel()
    const selected = await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const items: SelectItem[] = THINKING_LEVELS.map(level => ({
          value: level,
          label: `${level === current ? '✓' : '○'} ${level}`,
          description: level === current ? 'Current effort level' : 'Set model effort level'
        }))

        const selectList = new SelectList(items, Math.min(items.length, 8), overlaySelectListTheme(theme))
        selectList.onSelect = item => done(item.value)
        selectList.onCancel = () => done(null)

        return {
          render: (width: number) =>
            renderOverlayBox(
              theme,
              'leader m e  Model Effort',
              '↑↓ navigate • enter apply • esc cancel',
              selectList.render(Math.max(1, width - 2)),
              width
            ),
          invalidate: () => selectList.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data)
            tui.requestRender()
          }
        }
      },
      { overlay: true, overlayOptions: powerlineSafeOverlayOptions({ width: 54, maxHeight: '70%', anchor: 'center' }) }
    )

    if (!selected) return
    pi.setThinkingLevel(selected as (typeof THINKING_LEVELS)[number])
    ctx.ui.notify(`Set model effort to ${selected}`, 'info')
  }

  async function showModelPicker(ctx: ExtensionContext) {
    const models = ctx.modelRegistry.getAvailable()
    if (models.length === 0) {
      ctx.ui.notify('No available models with configured auth', 'warning')
      return
    }

    const selected = await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const items: SelectItem[] = models.map(model => {
          const value = `${model.provider}/${model.id}`
          const current = ctx.model?.provider === model.provider && ctx.model.id === model.id
          return {
            value,
            label: `${current ? '✓' : '○'} ${model.id}`,
            description: `${model.provider}${model.reasoning ? ' • reasoning' : ''}`
          }
        })

        const selectList = new SelectList(items, 12, overlaySelectListTheme(theme))
        selectList.onSelect = item => done(item.value)
        selectList.onCancel = () => done(null)

        return {
          render: (width: number) =>
            renderOverlayBox(
              theme,
              'leader m m  Model Select',
              'type to search • enter apply • esc cancel',
              selectList.render(Math.max(1, width - 2)),
              width
            ),
          invalidate: () => selectList.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data)
            tui.requestRender()
          }
        }
      },
      { overlay: true, overlayOptions: powerlineSafeOverlayOptions({ width: 72, maxHeight: '80%', anchor: 'center' }) }
    )

    if (!selected) return
    const [provider, ...idParts] = selected.split('/')
    const model = provider ? ctx.modelRegistry.find(provider, idParts.join('/')) : undefined
    if (!model) {
      ctx.ui.notify(`Model not found: ${selected}`, 'error')
      return
    }

    const ok = await pi.setModel(model)
    ctx.ui.notify(
      ok ? `Set model to ${selected}` : `Could not set model to ${selected}`,
      ok ? 'info' : 'error'
    )
  }

  const leaderRoutes: LeaderRoute[] = [
    {
      keys: ['m', 'e'],
      label: 'Model effort',
      description: 'Choose thinking/effort level',
      run: showEffortPicker
    },
    {
      keys: ['m', 'm'],
      label: 'Model select',
      description: 'Choose the active model',
      run: showModelPicker
    },
    ...actions
      .filter((action): action is QuickAction & { keys: string[] } => action.keys !== undefined)
      .map(action => ({
        keys: action.keys,
        label: action.label,
        description: action.description,
        run: action.run
      }))
  ]

  async function showLeader(ctx: ExtensionContext) {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Leader key routes are only available in the TUI', 'warning')
      return
    }

    const selected = await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        let prefix: string[] = []

        function visibleRoutes() {
          return leaderRoutes.filter(route => routeMatchesPrefix(route, prefix))
        }

        return {
          invalidate() {},
          render(width: number): string[] {
            const typed =
              prefix.length > 0
                ? prefix.map(key => theme.bg('selectedBg', theme.fg('muted', ` ${key} `))).join(' ')
                : theme.fg('dim', 'waiting')
            const lines = [theme.fg('dim', `route: ${typed}`)]
            for (const route of visibleRoutes()) {
              const next = route.keys[prefix.length]
              const keys = route.keys
                .map((key, index) => {
                  if (index < prefix.length) return theme.fg('dim', ` ${key} `)
                  if (index === prefix.length)
                    return theme.bg('selectedBg', theme.fg('accent', ` ${key} `))
                  return theme.fg('dim', ` ${key} `)
                })
                .join(theme.fg('dim', '→'))
              const nextHint = next
                ? `${theme.bg('selectedBg', theme.fg('accent', ` ${next} `))} ${theme.fg('dim', 'next')}`
                : theme.fg('success', 'ready')
              lines.push(
                truncateToWidth(
                  `${theme.fg('dim', '  press ')}${nextHint}  ${keys}  ${theme.fg('muted', route.label)} ${theme.fg('dim', `— ${route.description}`)}`,
                  Math.max(1, width - 2)
                )
              )
            }
            return renderOverlayBox(
              theme,
              'Leader Routes',
              'ctrl+space toggles • backspace edits • esc cancels',
              lines.length > 1 ? lines : [...lines, theme.fg('warning', '  no matching route')],
              width
            )
          },
          handleInput(data: string) {
            if (matchesKey(data, LEADER) || matchesKey(data, Key.escape)) {
              done(null)
              return
            }
            if (matchesKey(data, Key.backspace)) {
              prefix = prefix.slice(0, -1)
              tui.requestRender()
              return
            }

            const key = printableKey(data)
            if (!key) return

            prefix = [...prefix, key]
            const complete = leaderRoutes.find(route => routeIsComplete(route, prefix))
            if (complete) {
              done(routeKey(complete))
              return
            }
            if (visibleRoutes().length === 0) {
              prefix = []
            }
            tui.requestRender()
          }
        }
      },
      { overlay: true, overlayOptions: powerlineSafeOverlayOptions({ width: 78, maxHeight: '70%', anchor: 'center' }) }
    )

    const route = leaderRoutes.find(candidate => routeKey(candidate) === selected)
    if (route) await route.run(ctx)
  }

  async function showQuickActions(ctx: ExtensionContext) {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Quick actions are only available in the TUI', 'warning')
      return
    }

    const selected = await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const items: SelectItem[] = actions.map(action => ({
          value: action.id,
          label: action.label,
          description: action.keys
            ? `${action.keys.join(' ')} • ${action.description}`
            : action.description
        }))

        const selectList = new SelectList(items, Math.min(items.length, 8), overlaySelectListTheme(theme))
        selectList.onSelect = item => done(item.value)
        selectList.onCancel = () => done(null)

        return {
          render: (width: number) =>
            renderOverlayBox(
              theme,
              'Quick Actions',
              '↑↓ navigate • enter select • esc cancel',
              selectList.render(Math.max(1, width - 2)),
              width
            ),
          invalidate: () => selectList.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data)
            tui.requestRender()
          }
        }
      },
      { overlay: true, overlayOptions: powerlineSafeOverlayOptions({ width: 64, maxHeight: '60%', anchor: 'center' }) }
    )

    const action = actions.find(candidate => candidate.id === selected)
    if (action) await action.run(ctx)
  }

  pi.registerShortcut(SHORTCUT, {
    description: 'Open quick actions',
    handler: showQuickActions
  })

  pi.registerShortcut(LEADER, {
    description: 'Open leader key routes',
    handler: showLeader
  })

  pi.registerCommand('quick-actions', {
    description: 'Open quick actions',
    handler: async (_args, ctx) => showQuickActions(ctx)
  })

  async function clearChatAndStartNewAgent(ctx: ExtensionContext) {
    await ctx.waitForIdle()
    const parentSession = ctx.sessionManager.getSessionFile()
    const result = await ctx.newSession({
      parentSession,
      withSession: async ctx => {
        ctx.ui.notify('Cleared chat and started a fresh agent session', 'info')
      }
    })
    if (result.cancelled) ctx.ui.notify('Clear cancelled', 'warning')
  }

  pi.registerCommand('clear', {
    description: 'Clear the chat output and start a fresh agent session',
    handler: async (_args, ctx) => clearChatAndStartNewAgent(ctx)
  })

  pi.registerCommand('clear-chat', {
    description: 'Clear the chat output and start a fresh agent session',
    handler: async (_args, ctx) => clearChatAndStartNewAgent(ctx)
  })

  pi.registerCommand('clear-textbox', {
    description: 'Clear the input textbox',
    handler: async (_args, ctx) => {
      ctx.ui.setEditorText('')
      ctx.ui.notify('Cleared input textbox', 'info')
    }
  })
}
