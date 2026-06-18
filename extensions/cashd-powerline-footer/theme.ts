/**
 * Theme system for powerline-footer
 * 
 * Colors are resolved in order:
 * 1. User overrides from theme.json (if exists)
 * 2. Preset colors
 * 3. Default colors
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ColorScheme, ColorValue, SemanticColor, ThemeLike } from "./types.ts";

export interface PowerlineThemeConfig {
  colors?: unknown;
  icons?: unknown;
}

// Default color scheme (uses pi theme colors)
const DEFAULT_COLORS: Required<ColorScheme> = {
  model: "#d787af",  // Pink/mauve (matching original colors.ts)
  shellMode: "accent",
  path: "#00afaf",  // Teal/cyan (matching original colors.ts)
  gitDirty: "warning",
  gitClean: "#7aa2f7",
  thinking: "thinkingOff",
  thinkingMinimal: "thinkingMinimal",
  thinkingLow: "thinkingLow",
  thinkingMedium: "thinkingMedium",
  context: "#bb9af7",
  contextWarn: "warning",
  contextError: "error",
  cost: "text",
  tokens: "muted",
  separator: "dim",
  border: "borderMuted",
};

// Extra-high thinking is a brighter, bolder sibling of the Pi-logo gradient.
const EXTRA_HIGH_THINKING_GRADIENT_COLORS = [
  "#3081f7", "#00afff", "#7dd3fc", "#c084fc",
  "#97cdff", "#3081f7",
];

const ANTHROPIC_BRAND_COLOR = "#d97757";
const OPENAI_BRAND_COLOR = "#10a37f";

// Matches the left-to-right blue Pi glyph gradient used by extensions/baller-header.ts.
const PI_LOGO_GRADIENT_COLORS = [
  "#1653bd",
  "#3081f7",
  "#5dabff",
  "#97cdff",
  "#5dabff",
  "#3081f7",
];

// Cache for user theme overrides
let userThemeCache: ColorScheme | null = null;
let userThemeCacheTime = 0;
let themeConfigCache: PowerlineThemeConfig | null = null;
let themeConfigCacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds
const warnedInvalidThemeColors = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeUserThemeOverrides(value: unknown): ColorScheme {
  if (!isRecord(value)) {
    return {};
  }

  const sanitized: ColorScheme = {};
  for (const [key, rawColor] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_COLORS, key)) {
      continue;
    }
    if (typeof rawColor !== "string") {
      continue;
    }

    const color = rawColor.trim();
    if (!color) {
      continue;
    }

    sanitized[key as SemanticColor] = color as ColorValue;
  }

  return sanitized;
}

/**
 * Get the path to the theme.json file
 */
function getThemePath(): string {
  const extDir = dirname(fileURLToPath(import.meta.url));
  return join(extDir, "theme.json");
}

/**
 * Load user theme config from theme.json
 */
export function loadThemeConfig(): PowerlineThemeConfig {
  const now = Date.now();
  if (themeConfigCache && now - themeConfigCacheTime < CACHE_TTL) {
    return themeConfigCache;
  }

  const themePath = getThemePath();
  try {
    if (existsSync(themePath)) {
      const content = readFileSync(themePath, "utf-8");
      const parsed = JSON.parse(content);
      themeConfigCache = isRecord(parsed) ? parsed : {};
      themeConfigCacheTime = now;
      return themeConfigCache;
    }
  } catch (error) {
    // Theme overrides are optional. If the file is unreadable or malformed,
    // keep rendering with built-in defaults instead of breaking the footer.
    console.debug(`[powerline-theme] Failed to load ${themePath}:`, error);
  }

  themeConfigCache = {};
  themeConfigCacheTime = now;
  return themeConfigCache;
}

function loadUserTheme(): ColorScheme {
  const now = Date.now();
  if (userThemeCache && now - userThemeCacheTime < CACHE_TTL) {
    return userThemeCache;
  }

  userThemeCache = sanitizeUserThemeOverrides(loadThemeConfig().colors);
  userThemeCacheTime = now;
  return userThemeCache;
}

/**
 * Resolve a semantic color to an actual color value
 */
export function resolveColor(
  semantic: SemanticColor,
  presetColors?: ColorScheme
): ColorValue {
  const userTheme = loadUserTheme();
  
  // Priority: user overrides > preset colors > defaults
  return userTheme[semantic] 
    ?? presetColors?.[semantic] 
    ?? DEFAULT_COLORS[semantic];
}

/**
 * Check if a color value is a hex color
 */
function isHexColor(color: ColorValue): color is `#${string}` {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

/**
 * Convert hex color to ANSI escape code
 */
function hexToAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mixChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function interpolateGradientRgb(colors: readonly string[], position: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, position));
  const scaled = clamped * (colors.length - 1);
  const index = Math.floor(scaled);
  const nextIndex = Math.min(index + 1, colors.length - 1);
  const t = scaled - index;
  const a = hexToRgb(colors[index]!);
  const b = hexToRgb(colors[nextIndex]!);

  return [mixChannel(a[0], b[0], t), mixChannel(a[1], b[1], t), mixChannel(a[2], b[2], t)];
}

function interpolateGradient(colors: readonly string[], position: number): string {
  const [r, g, b] = interpolateGradientRgb(colors, position);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Apply a color to text using the pi theme or custom hex
 */
export function applyColor(
  theme: ThemeLike,
  color: ColorValue,
  text: string
): string {
  if (isHexColor(color)) {
    return `${hexToAnsi(color)}${text}\x1b[0m`;
  }

  try {
    return theme.fg(color as ThemeColor, text);
  } catch (error) {
    const key = String(color);
    if (!warnedInvalidThemeColors.has(key)) {
      warnedInvalidThemeColors.add(key);
      if (warnedInvalidThemeColors.size > 200) {
        warnedInvalidThemeColors.clear();
      }
      console.debug(`[powerline-theme] Invalid theme color "${key}"; falling back to "text".`, error);
    }
    return theme.fg("text", text);
  }
}

/**
 * Apply a semantic color to text
 */
export function fg(
  theme: ThemeLike,
  semantic: SemanticColor,
  text: string,
  presetColors?: ColorScheme
): string {
  const color = resolveColor(semantic, presetColors);
  return applyColor(theme, color, text);
}

/**
 * Apply the blue Pi-logo gradient used by the custom header.
 */
export function piLogoGradient(text: string): string {
  const colorableChars = [...text].filter(char => char !== " ").length;
  const span = Math.max(colorableChars - 1, 1);
  let result = "";
  let colorIndex = 0;

  for (const char of text) {
    if (char === " ") {
      result += char;
      continue;
    }

    result += interpolateGradient(PI_LOGO_GRADIENT_COLORS, colorIndex / span) + char;
    colorIndex++;
  }

  return result + "\x1b[0m";
}

/**
 * Apply the extra-high thinking gradient one notch above the regular high gradient.
 */
export function extraHighThinkingGradient(text: string): string {
  const colorableChars = [...text].filter(char => char !== " ").length;
  const span = Math.max(colorableChars - 1, 1);
  let result = "\x1b[1m";
  let colorIndex = 0;

  for (const char of text) {
    if (char === " ") {
      result += char;
      continue;
    }

    result += interpolateGradient(EXTRA_HIGH_THINKING_GRADIENT_COLORS, colorIndex / span) + char;
    colorIndex++;
  }

  return result + "\x1b[0m";
}

export function brandedModelColor(
  model: { provider?: unknown; id?: unknown; name?: unknown } | null | undefined,
  text: string,
): string | null {
  const provider = typeof model?.provider === "string" ? model.provider.toLowerCase() : "";
  const id = typeof model?.id === "string" ? model.id.toLowerCase() : "";
  const name = typeof model?.name === "string" ? model.name.toLowerCase() : "";
  const searchable = `${provider} ${id} ${name}`;

  if (searchable.includes("codex")) {
    return `${hexToAnsi(OPENAI_BRAND_COLOR)}${text}\x1b[0m`;
  }

  if ((searchable.includes("claude") || searchable.includes("anthropic")) && /(?:^|[^0-9])4[._-]?8(?:[^0-9]|$)/.test(searchable)) {
    return `${hexToAnsi(ANTHROPIC_BRAND_COLOR)}${text}\x1b[0m`;
  }

  if ((searchable.includes("openai") || searchable.includes("gpt")) && /(?:^|[^a-z0-9])gpt[-_ ]?5(?:[._-]?\d+)?(?:[^a-z0-9]|$)/.test(searchable)) {
    return `${hexToAnsi(OPENAI_BRAND_COLOR)}${text}\x1b[0m`;
  }

  return null;
}

/**
 * Get the default color scheme
 */
export function getDefaultColors(): Required<ColorScheme> {
  return { ...DEFAULT_COLORS };
}
