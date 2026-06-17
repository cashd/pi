#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const powerlineRoot = join(repoRoot, 'npm', 'node_modules', 'pi-powerline-footer')

function read(path) {
  return readFileSync(path, 'utf8')
}

function write(path, content) {
  writeFileSync(path, content)
}

function replaceOnce(path, oldText, newText) {
  const before = read(path)
  if (before.includes(newText)) return false
  if (!before.includes(oldText)) {
    throw new Error(`Could not find expected text in ${path}`)
  }
  write(path, before.replace(oldText, newText))
  return true
}

function replaceAll(path, oldText, newText) {
  const before = read(path)
  if (!before.includes(oldText)) return false
  write(path, before.split(oldText).join(newText))
  return true
}

if (existsSync(powerlineRoot)) {
  const presetsPath = join(powerlineRoot, 'presets.ts')
  replaceOnce(
    presetsPath,
    'leftSegments: ["model", "thinking", "shell_mode", "path", "git", "context_pct", "cache_read", "cost"],',
    'leftSegments: ["model", "thinking", "shell_mode", "path", "git", "context_pct", "cache_read"],'
  )

  const segmentsPath = join(powerlineRoot, 'segments.ts')
  replaceOnce(
    segmentsPath,
    `function withIcon(icon: string, text: string): string {\n  return icon ? \`${'${icon}'} ${'${text}'}\` : text;\n}\n\nfunction formatTokens(n: number): string {`,
    `function withIcon(icon: string, text: string): string {\n  return icon ? \`${'${icon}'} ${'${text}'}\` : text;\n}\n\nfunction getModelProvider(model: SegmentContext['model']): string {\n  const provider = (model as { provider?: unknown } | undefined)?.provider;\n  return typeof provider === "string" ? provider.toLowerCase() : "";\n}\n\nfunction getModelIcon(model: SegmentContext['model'], fallback: string): string {\n  const provider = getModelProvider(model);\n  const id = model?.id?.toLowerCase() ?? "";\n  const name = model?.name?.toLowerCase() ?? "";\n  const searchable = \`${'${provider}'} ${'${id}'} ${'${name}'}\`;\n\n  if (searchable.includes("anthropic") || searchable.includes("claude")) return "✻";\n  if (searchable.includes("codex")) return "⌘";\n  if (searchable.includes("openai") || searchable.includes("gpt") || searchable.includes("chatgpt")) return "◎";\n\n  return fallback;\n}\n\nfunction formatTokens(n: number): string {`
  )
  replaceOnce(
    segmentsPath,
    'let content = withIcon(icons.model, modelName);',
    'let content = withIcon(getModelIcon(ctx.model, icons.model), modelName);'
  )
  replaceOnce(
    segmentsPath,
    'const content = `think:${label}`;',
    'const content = `[think:${label}]`;'
  )
  replaceOnce(
    segmentsPath,
    `const cacheReadSegment: StatusLineSegment = {
  id: "cache_read",
  render(ctx) {
    const icons = getIcons();
    const { cacheRead } = ctx.usageStats;
    if (!cacheRead) return { content: "", visible: false };

    const parts = [icons.cache, icons.input, formatTokens(cacheRead)].filter(Boolean);
    const content = parts.join(" ");
    return { content: color(ctx, "tokens", content), visible: true };
  },
};`,
    `const cacheReadSegment: StatusLineSegment = {
  id: "cache_read",
  render(ctx) {
    const icons = getIcons();
    const { input, cacheRead } = ctx.usageStats;
    if (!cacheRead) return { content: "", visible: false };

    const cacheableInput = input + cacheRead;
    const hitPct = cacheableInput > 0 ? (cacheRead / cacheableInput) * 100 : 0;
    const content = \`${'${icons.cache || "◫"}'} ${'${hitPct.toFixed(0)}'}%/${'${formatTokens(cacheRead)}'}\`;
    return { content: color(ctx, "tokens", content), visible: true };
  },
};`
  )

  const themePath = join(powerlineRoot, 'theme.json')
  let theme = {}
  try {
    theme = JSON.parse(read(themePath))
  } catch {}
  theme.colors = { ...(theme.colors ?? {}), context: '#febc38' }
  theme.icons = { ...(theme.icons ?? {}), context: '' }
  write(themePath, `${JSON.stringify(theme, null, 2)}\n`)
}

const mcpRoot = join(repoRoot, 'npm', 'node_modules', 'pi-mcp-adapter')
const mcpInitPath = join(mcpRoot, 'init.ts')
if (existsSync(mcpInitPath)) {
  replaceOnce(
    mcpInitPath,
    'ui.setStatus("mcp", ui.theme.fg("accent", `MCP: ${connectedCount}/${total} servers`));',
    'ui.setStatus("mcp", ui.theme.fg("dim", `mcp ${connectedCount}/${total}`));'
  )
  replaceOnce(
    mcpInitPath,
    'ctx.ui.setStatus("mcp", `MCP: connecting to ${startupServers.length} servers...`);',
    'ctx.ui.setStatus("mcp", ctx.ui.theme.fg("dim", `mcp connecting ${startupServers.length}`));'
  )
  replaceAll(
    mcpInitPath,
    'state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);',
    'state.ui.setStatus("mcp", state.ui.theme.fg("dim", `mcp connecting ${serverName}`));'
  )
}
const mcpProxyModesPath = join(mcpRoot, 'proxy-modes.ts')
if (existsSync(mcpProxyModesPath)) {
  replaceAll(
    mcpProxyModesPath,
    'state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);',
    'state.ui.setStatus("mcp", state.ui.theme.fg("dim", `mcp connecting ${serverName}`));'
  )
}


console.log('Applied pi-powerline-footer overrides')
