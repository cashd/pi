import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  fuzzyFilter,
  Input,
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  type SelectItem
} from '@earendil-works/pi-tui'

const LINEAR_WORKSPACE = process.env.PI_LINEAR_WORKSPACE ?? 'morpho'
const SHORTCUT = Key.ctrlShift('l')
const LEADER = Key.ctrl(Key.space)
const PREVIOUS_BRANCH_SHORTCUT = Key.ctrlAlt('b')
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]
const EFFORT_KEY_CANDIDATES = {
  s: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  m: ['medium', 'low', 'high', 'minimal', 'xhigh'],
  l: ['high', 'xhigh', 'medium', 'low', 'minimal'],
  x: ['xhigh', 'high', 'medium', 'low', 'minimal']
} as const satisfies Record<string, readonly ThinkingLevel[]>
const LINEAR_TICKET_STATUS_KEY = 'linear-ticket'

type QuickAction = {
  id: string
  label: string
  description: string
  keys?: string[]
  run: (ctx: ExtensionContext) => Promise<void>
}

type GitBranchKind = 'local' | 'remote'

type GitBranch = {
  key: string
  kind: GitBranchKind
  shortName: string
  fullName: string
  switchRef: string
  localName: string
  upstream?: string
  date?: string
  subject?: string
  current: boolean
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

function localNameForRemoteBranch(shortName: string) {
  const slashIndex = shortName.indexOf('/')
  return slashIndex === -1 ? shortName : shortName.slice(slashIndex + 1)
}

function compactBranchText(value: string | undefined) {
  return value?.trim() || undefined
}

function parseGitBranches(stdout: string, current: string | null | undefined): GitBranch[] {
  const rawBranches = stdout
    .split('\n')
    .map(line => {
      const [fullName = '', shortName = '', upstream = '', date = '', subject = ''] = line.split('\0')
      const kind: GitBranchKind = fullName.startsWith('refs/remotes/') ? 'remote' : 'local'
      const localName = kind === 'remote' ? localNameForRemoteBranch(shortName) : shortName

      return {
        key: `${kind}:${shortName}`,
        kind,
        shortName,
        fullName,
        switchRef: shortName,
        localName,
        upstream: compactBranchText(upstream),
        date: compactBranchText(date),
        subject: compactBranchText(subject),
        current: kind === 'local' && shortName === current
      }
    })
    .filter(branch => branch.fullName && branch.shortName)
    .filter(branch => !(branch.kind === 'remote' && (
      branch.fullName.endsWith('/HEAD') || branch.shortName.endsWith('/HEAD')
    )))

  const localNames = new Set(
    rawBranches
      .filter(branch => branch.kind === 'local')
      .map(branch => branch.shortName)
  )

  return rawBranches.filter(branch => !(branch.kind === 'remote' && localNames.has(branch.localName)))
}

async function listGitBranches(pi: ExtensionAPI): Promise<{ branches: GitBranch[]; error?: string }> {
  const current = await currentBranch(pi)
  const result = await pi.exec(
    'git',
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(committerdate:relative)%00%(subject)',
      'refs/heads',
      'refs/remotes'
    ],
    { timeout: 10_000 }
  )

  if (result.code !== 0) {
    return { branches: [], error: (result.stderr || result.stdout || 'Not a git repository').trim() }
  }

  return { branches: parseGitBranches(result.stdout, current) }
}

function branchDescription(branch: GitBranch) {
  const scope = branch.kind === 'remote'
    ? 'remote'
    : branch.upstream ? `tracks ${branch.upstream}` : 'local'
  return [scope, branch.date, branch.subject].filter(Boolean).join(' • ')
}

function branchSearchText(branch: GitBranch) {
  return [
    branch.shortName,
    branch.localName,
    branch.upstream,
    branch.subject,
    branch.kind
  ].filter(Boolean).join(' ')
}

async function hasDirtyWorktree(pi: ExtensionAPI) {
  const result = await pi.exec('git', ['status', '--porcelain'], { timeout: 10_000 })
  return result.code === 0 && result.stdout.trim().length > 0
}

async function prepareForBranchSwitch(pi: ExtensionAPI, ctx: ExtensionContext, targetLabel: string) {
  if (!(await hasDirtyWorktree(pi))) return true

  const choice = await ctx.ui.select('Worktree has uncommitted changes', [
    'Switch anyway',
    'Stash changes then switch',
    'Cancel'
  ])

  if (choice !== 'Switch anyway' && choice !== 'Stash changes then switch') return false

  if (choice === 'Stash changes then switch') {
    const result = await pi.exec(
      'git',
      ['stash', 'push', '-u', '-m', `pi quick action: switch to ${targetLabel}`],
      { timeout: 30_000 }
    )

    if (result.code !== 0) {
      ctx.ui.notify(`Could not stash changes: ${(result.stderr || result.stdout).trim()}`, 'error')
      return false
    }

    ctx.ui.notify('Stashed changes before switching branches', 'info')
  }

  return true
}

async function switchGitBranch(pi: ExtensionAPI, ctx: ExtensionContext, branch: GitBranch) {
  if (branch.current) {
    ctx.ui.notify(`Already on ${branch.shortName}`, 'info')
    return
  }

  const target = branch.kind === 'remote' ? branch.localName : branch.shortName
  if (!(await prepareForBranchSwitch(pi, ctx, target))) return

  const args = branch.kind === 'local'
    ? ['switch', branch.shortName]
    : ['switch', '--track', branch.switchRef]
  const result = await pi.exec('git', args, { timeout: 30_000 })
  const output = (result.stderr || result.stdout).trim()

  if (result.code === 0) {
    ctx.ui.notify(`Switched to ${target}`, 'info')
    return
  }

  ctx.ui.notify(`Could not switch branch${output ? `: ${output}` : ''}`, 'error')
}

async function switchPreviousGitBranch(pi: ExtensionAPI, ctx: ExtensionContext) {
  const previous = await pi.exec('git', ['rev-parse', '--abbrev-ref', '@{-1}'], { timeout: 10_000 })
  const target = previous.stdout.trim() || 'previous branch'

  if (previous.code !== 0) {
    ctx.ui.notify('No previous git branch found', 'warning')
    return
  }

  if (!(await prepareForBranchSwitch(pi, ctx, target))) return

  const result = await pi.exec('git', ['switch', '-'], { timeout: 30_000 })
  const output = (result.stderr || result.stdout).trim()

  if (result.code === 0) {
    ctx.ui.notify(`Switched to ${target}`, 'info')
    return
  }

  ctx.ui.notify(`Could not switch to previous branch${output ? `: ${output}` : ''}`, 'error')
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

type ModelCandidate = {
  provider: string
  id: string
}

type ModelPreset = {
  label: string
  description: string
  candidates: ModelCandidate[]
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

type ThinkingModel = {
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
}

function supportedThinkingLevels(model: unknown): ThinkingLevel[] {
  const thinkingModel = model as ThinkingModel | undefined
  if (!thinkingModel?.reasoning) return ['off']

  return THINKING_LEVELS.filter(level => thinkingModel.thinkingLevelMap?.[level] !== null)
}

function bestEffortThinkingLevel(model: unknown, key: keyof typeof EFFORT_KEY_CANDIDATES): ThinkingLevel {
  const supported = supportedThinkingLevels(model)
  return EFFORT_KEY_CANDIDATES[key].find(level => supported.includes(level)) ?? supported[0] ?? 'off'
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

type SearchableChoice = {
  value: string
  label: string
  description?: string
  searchText: string
  checked?: boolean
}

type SearchablePickerOptions = {
  title: string
  hint: string
  items: SearchableChoice[]
  maxVisible: number
  overlayWidth: number
  maxHeight?: number | string
  emptyText: string
}

function keybindingMatches(keybindings: any, data: string, id: string, fallback: string) {
  return typeof keybindings?.matches === 'function'
    ? keybindings.matches(data, id)
    : matchesKey(data, fallback)
}

function filterChoices(items: SearchableChoice[], query: string) {
  return query.trim()
    ? fuzzyFilter(items, query, item => item.searchText)
    : items
}

async function showSearchablePicker(
  ctx: ExtensionContext,
  options: SearchablePickerOptions
): Promise<string | null> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify(`${options.title} is only available in the TUI`, 'warning')
    return null
  }

  return ctx.ui.custom<string | null>(
    (tui, theme, keybindings, done) => {
      const searchInput = new Input()
      let filteredItems = options.items
      let selectedIndex = 0
      let lastQuery = ''

      const applyFilter = () => {
        const query = searchInput.getValue()
        filteredItems = filterChoices(options.items, query)
        selectedIndex = query === lastQuery
          ? Math.min(selectedIndex, Math.max(0, filteredItems.length - 1))
          : 0
        lastQuery = query
      }

      const selectCurrent = () => {
        const item = filteredItems[selectedIndex]
        if (item) done(item.value)
      }

      const renderList = (width: number) => {
        const lines: string[] = []
        if (filteredItems.length === 0) {
          lines.push(theme.fg('warning', `  ${options.emptyText}`))
          return lines
        }

        const maxVisible = Math.max(1, options.maxVisible)
        const startIndex = Math.max(
          0,
          Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible)
        )
        const endIndex = Math.min(startIndex + maxVisible, filteredItems.length)

        for (let index = startIndex; index < endIndex; index += 1) {
          const item = filteredItems[index]
          if (!item) continue

          const isSelected = index === selectedIndex
          const prefix = isSelected ? theme.fg('accent', '→ ') : '  '
          const marker = item.checked ? theme.fg('success', '✓') : theme.fg('dim', '○')
          const label = isSelected ? theme.fg('accent', item.label) : item.label
          const description = item.description ? theme.fg('muted', `  ${item.description}`) : ''
          lines.push(truncateToWidth(`${prefix}${marker} ${label}${description}`, width, '…', true))
        }

        if (startIndex > 0 || endIndex < filteredItems.length) {
          lines.push(theme.fg('dim', `  (${selectedIndex + 1}/${filteredItems.length})`))
        }

        return lines
      }

      return {
        render: (width: number) => {
          const contentWidth = Math.max(1, width - 2)
          const content = [
            theme.fg('dim', 'Search:'),
            ...searchInput.render(contentWidth),
            '',
            ...renderList(contentWidth)
          ]
          return renderOverlayBox(theme, options.title, options.hint, content, width)
        },
        invalidate: () => searchInput.invalidate(),
        handleInput: (data: string) => {
          if (keybindingMatches(keybindings, data, 'tui.select.up', Key.up)) {
            if (filteredItems.length > 0) {
              selectedIndex = selectedIndex === 0 ? filteredItems.length - 1 : selectedIndex - 1
            }
            tui.requestRender()
            return
          }

          if (keybindingMatches(keybindings, data, 'tui.select.down', Key.down)) {
            if (filteredItems.length > 0) {
              selectedIndex = selectedIndex === filteredItems.length - 1 ? 0 : selectedIndex + 1
            }
            tui.requestRender()
            return
          }

          if (keybindingMatches(keybindings, data, 'tui.select.confirm', Key.enter)) {
            selectCurrent()
            return
          }

          if (matchesKey(data, Key.ctrl('c'))) {
            if (searchInput.getValue()) {
              searchInput.setValue('')
              applyFilter()
              tui.requestRender()
            } else {
              done(null)
            }
            return
          }

          if (matchesKey(data, Key.escape)) {
            done(null)
            return
          }

          searchInput.handleInput(data)
          applyFilter()
          tui.requestRender()
        }
      }
    },
    {
      overlay: true,
      overlayOptions: powerlineSafeOverlayOptions({
        width: options.overlayWidth,
        maxHeight: options.maxHeight ?? '80%',
        anchor: 'center'
      })
    }
  )
}

async function showBranchPicker(pi: ExtensionAPI, ctx: ExtensionContext) {
  const { branches, error } = await listGitBranches(pi)
  if (error) {
    ctx.ui.notify(`Could not list branches: ${error}`, 'error')
    return
  }

  if (branches.length === 0) {
    ctx.ui.notify('No git branches found', 'warning')
    return
  }

  const branchByKey = new Map(branches.map(branch => [branch.key, branch]))
  const selected = await showSearchablePicker(ctx, {
    title: 'Git Branch Search',
    hint: 'type fuzzy branch • enter switch • ctrl+c clear • esc cancel',
    maxVisible: 12,
    overlayWidth: 76,
    maxHeight: '80%',
    emptyText: 'No matching branches',
    items: branches.map(branch => ({
      value: branch.key,
      label: branch.shortName,
      description: branchDescription(branch),
      checked: branch.current,
      searchText: branchSearchText(branch)
    }))
  })

  const branch = selected ? branchByKey.get(selected) : undefined
  if (branch) await switchGitBranch(pi, ctx, branch)
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

  function modelSpec(candidate: ModelCandidate) {
    return `${candidate.provider}/${candidate.id}`
  }

  const modelPresets: ModelPreset[] = [
    {
      label: 'Switch to Claude 4.8',
      description: 'Use Anthropic Claude Opus 4.8',
      candidates: [{ provider: 'anthropic', id: 'claude-opus-4-8' }]
    },
    {
      label: 'Switch to top Codex',
      description: 'Use the top Codex subscription model',
      candidates: [
        { provider: 'openai-codex', id: 'gpt-5.5' },
        { provider: 'openai', id: 'gpt-5.3-codex-spark' },
        { provider: 'openai', id: 'gpt-5.3-codex' },
        { provider: 'openrouter', id: 'openai/gpt-5.3-codex' }
      ]
    },
    {
      label: 'Switch to top GPT',
      description: 'Use the highest-end GPT model available',
      candidates: [
        { provider: 'openai', id: 'gpt-5.5-pro' },
        { provider: 'openai', id: 'gpt-5.5' },
        { provider: 'azure-openai-responses', id: 'gpt-5.5-pro' },
        { provider: 'azure-openai-responses', id: 'gpt-5.5' },
        { provider: 'openrouter', id: 'openai/gpt-5.5-pro' },
        { provider: 'openrouter', id: 'openai/gpt-5.5' }
      ]
    }
  ]

  function switchToModelPreset(preset: ModelPreset) {
    return async (ctx: ExtensionContext) => {
      const attempted: string[] = []
      let foundCandidate = false

      for (const candidate of preset.candidates) {
        const spec = modelSpec(candidate)
        const model = ctx.modelRegistry.find(candidate.provider, candidate.id)
        if (!model) continue

        foundCandidate = true
        attempted.push(spec)

        const ok = await pi.setModel(model)
        if (ok) {
          ctx.ui.notify(`Set model to ${spec}`, 'info')
          return
        }
      }

      if (!foundCandidate) {
        ctx.ui.notify(`No configured model found for ${preset.label}`, 'error')
        return
      }

      ctx.ui.notify(
        `Could not switch to ${preset.label}; no configured auth for ${attempted.join(', ')}`,
        'error'
      )
    }
  }

  const actions: QuickAction[] = [
    ...modelPresets.map(preset => ({
      id: `model.switch.${preset.label.toLowerCase().replace(/[^a-z0-9]+/g, '.')}`,
      label: preset.label,
      description: preset.description,
      run: switchToModelPreset(preset)
    })),
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
      id: 'git.switchBranch',
      label: 'Switch Git branch',
      description: 'Fuzzy-search local and remote branches, then git switch',
      keys: ['g', 'b', 's'],
      run: ctx => showBranchPicker(pi, ctx)
    },
    {
      id: 'git.previousBranch',
      label: 'Switch to previous Git branch',
      description: `Run git switch - (${PREVIOUS_BRANCH_SHORTCUT})`,
      keys: ['g', 'b', 'p'],
      run: ctx => switchPreviousGitBranch(pi, ctx)
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
        const shortcutForLevel = (level: ThinkingLevel) =>
          (Object.keys(EFFORT_KEY_CANDIDATES) as Array<keyof typeof EFFORT_KEY_CANDIDATES>)
            .filter(key => bestEffortThinkingLevel(ctx.model, key) === level)
            .join('/')

        const items: SelectItem[] = THINKING_LEVELS.map(level => {
          const shortcuts = shortcutForLevel(level)
          return {
            value: level,
            label: `${level === current ? '✓' : '○'} ${level}`,
            description: shortcuts
              ? `${shortcuts} shortcut${shortcuts.includes('/') ? 's' : ''}`
              : level === current ? 'Current effort level' : 'Set model effort level'
          }
        })

        const selectList = new SelectList(items, Math.min(items.length, 8), overlaySelectListTheme(theme))
        selectList.onSelect = item => done(item.value)
        selectList.onCancel = () => done(null)

        return {
          render: (width: number) =>
            renderOverlayBox(
              theme,
              'leader m e  Model Effort',
              's small • m medium • l large • x max • ↑↓/enter • esc',
              selectList.render(Math.max(1, width - 2)),
              width
            ),
          invalidate: () => selectList.invalidate(),
          handleInput: (data: string) => {
            const key = printableKey(data)
            if (key && key in EFFORT_KEY_CANDIDATES) {
              done(bestEffortThinkingLevel(ctx.model, key as keyof typeof EFFORT_KEY_CANDIDATES))
              return
            }

            selectList.handleInput(data)
            tui.requestRender()
          }
        }
      },
      { overlay: true, overlayOptions: powerlineSafeOverlayOptions({ width: 54, maxHeight: '70%', anchor: 'center' }) }
    )

    if (!selected) return
    pi.setThinkingLevel(selected as ThinkingLevel)
    ctx.ui.notify(`Set model effort to ${pi.getThinkingLevel()}`, 'info')
  }

  async function showModelPicker(ctx: ExtensionContext) {
    const models = ctx.modelRegistry.getAvailable()
    if (models.length === 0) {
      ctx.ui.notify('No available models with configured auth', 'warning')
      return
    }

    const sortedModels = [...models].sort((a, b) => {
      const aCurrent = ctx.model?.provider === a.provider && ctx.model.id === a.id
      const bCurrent = ctx.model?.provider === b.provider && ctx.model.id === b.id
      if (aCurrent && !bCurrent) return -1
      if (!aCurrent && bCurrent) return 1
      return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)
    })

    const selected = await showSearchablePicker(ctx, {
      title: 'leader m m  Model Select',
      hint: 'type fuzzy search • enter apply • ctrl+c clear • esc cancel',
      maxVisible: 12,
      overlayWidth: 72,
      maxHeight: '80%',
      emptyText: 'No matching models',
      items: sortedModels.map(model => {
        const value = `${model.provider}/${model.id}`
        const current = ctx.model?.provider === model.provider && ctx.model.id === model.id
        return {
          value,
          label: model.id,
          description: `${model.provider}${model.reasoning ? ' • reasoning' : ''}`,
          checked: current,
          searchText: `${value} ${model.id} ${model.provider} ${model.name ?? ''}`
        }
      })
    })

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
              const keys = route.keys
                .map((key, index) => {
                  if (index < prefix.length) return theme.fg('dim', ` ${key} `)
                  if (index === prefix.length)
                    return theme.bg('selectedBg', theme.fg('accent', ` ${key} `))
                  return theme.fg('dim', ` ${key} `)
                })
                .join(theme.fg('dim', '→'))
              lines.push(
                truncateToWidth(
                  `  ${keys}  ${theme.fg('muted', route.label)}`,
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

  pi.registerShortcut(PREVIOUS_BRANCH_SHORTCUT, {
    description: 'Switch to previous Git branch',
    handler: ctx => switchPreviousGitBranch(pi, ctx)
  })

  pi.registerCommand('quick-actions', {
    description: 'Open quick actions',
    handler: async (_args, ctx) => showQuickActions(ctx)
  })

  async function clearChatAndStartNewAgent(ctx: ExtensionCommandContext) {
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
