import { createReadToolDefinition, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import os from "node:os";

const MAX_READ_PATH_CHARS = 80;
const MIN_READ_PATH_HEAD_CHARS = 12;
const ULTRA_READ_SUMMARY_GLOBAL_KEY = Symbol.for("cashd.pi.ultraReadSummary");

function valueToString(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function hasUltraReadSummaryOverride(): boolean {
	return (globalThis as Record<PropertyKey, unknown>)[ULTRA_READ_SUMMARY_GLOBAL_KEY] === true;
}

function compactHome(path: string): string {
	const home = os.homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function lastSeparatorBefore(text: string, index: number): number {
	return Math.max(text.lastIndexOf("/", index), text.lastIndexOf("\\", index));
}

function firstSeparatorAfter(text: string, index: number): number {
	const slash = text.indexOf("/", index);
	const backslash = text.indexOf("\\", index);
	if (slash === -1) return backslash;
	if (backslash === -1) return slash;
	return Math.min(slash, backslash);
}

function splitLongPath(rawPath: string): { head: string; tail: string } | undefined {
	const path = compactHome(rawPath);
	if (path.length <= MAX_READ_PATH_CHARS) return undefined;

	// Keep a 1:2 head:tail ratio. The tail gets 2× the head because the file name
	// and nearest directories usually matter most, while the head identifies the root.
	const availableChars = MAX_READ_PATH_CHARS - 1;
	let headChars = Math.max(MIN_READ_PATH_HEAD_CHARS, Math.floor(availableChars / 3));
	let tailChars = availableChars - headChars;

	const headBoundary = lastSeparatorBefore(path, headChars + 6);
	if (headBoundary >= MIN_READ_PATH_HEAD_CHARS) {
		headChars = headBoundary + 1;
		tailChars = availableChars - headChars;
	}

	const tailStartTarget = path.length - tailChars;
	const tailBoundary = firstSeparatorAfter(path, tailStartTarget - 6);
	const tailStart = tailBoundary >= 0 && tailBoundary > headChars ? tailBoundary : tailStartTarget;

	return {
		head: path.slice(0, headChars),
		tail: path.slice(tailStart),
	};
}

function formatLineRange(args: { offset?: number; limit?: number } | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";

	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatPath(rawPath: string, theme: Theme): string {
	const split = splitLongPath(rawPath);
	if (!split) return theme.fg("accent", compactHome(rawPath));

	return `${theme.fg("accent", split.head)}${theme.fg("muted", "…")}${theme.fg("accent", theme.bold(split.tail))}`;
}

function formatReadCall(args: { path?: unknown; file_path?: unknown; offset?: number; limit?: number } | undefined, theme: Theme): string {
	const rawPath = valueToString(args?.file_path ?? args?.path);
	const pathDisplay = rawPath === null
		? theme.fg("error", "[invalid arg]")
		: rawPath
			? formatPath(rawPath, theme)
			: theme.fg("toolOutput", "...");

	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatLineRange(args, theme)}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (hasUltraReadSummaryOverride()) return;

		const readTool = createReadToolDefinition(ctx.cwd);

		pi.registerTool({
			...readTool,
			renderCall(args, theme, context) {
				const readArgs = args as { path?: unknown; file_path?: unknown; offset?: number; limit?: number } | undefined;
				const rawPath = valueToString(readArgs?.file_path ?? readArgs?.path);

				// While tool args are streaming, use Pi's built-in renderer to avoid
				// visibly re-shortening partial paths on every render pass.
				if (!context.argsComplete || rawPath === null || compactHome(rawPath).length <= MAX_READ_PATH_CHARS) {
					return readTool.renderCall?.(args, theme, context) ?? new Text("", 0, 0);
				}

				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(formatReadCall(readArgs, theme));
				return text;
			},
		});
	});
}
