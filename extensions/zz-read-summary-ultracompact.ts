import {
	createReadToolDefinition,
	isToolCallEventType,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";

const MAX_COLLAPSED_FILES = 5;
const MAX_PATH_DEPTH = 4;
const KEEP_HEAD_SEGMENTS = 1;
const KEEP_TAIL_SEGMENTS = 2;
const MAX_PATH_CHARS = 54;
const META_KEY = "__cashdUltraReadSummary";
const ULTRA_READ_SUMMARY_GLOBAL_KEY = Symbol.for("cashd.pi.ultraReadSummary");

type LineRange = {
	start: number;
	end: number;
};

type ReadBatchEntry = {
	path: string;
	ranges: LineRange[];
	inFlight: number;
	failed: boolean;
	isImage: boolean;
};

type ReadBatch = {
	id: string;
	anchorToolCallId: string;
	entries: ReadBatchEntry[];
	inFlight: number;
	pendingFinalize: boolean;
	done: boolean;
};

type ReadSummaryMeta = {
	batchId: string;
	toolCallId: string;
};

type ToolContentBlock = {
	type: string;
	text?: string;
};

type ReadResultLike = {
	content?: ToolContentBlock[];
	details?: unknown;
};

function emptyComponent(): Component {
	return { render: () => [], invalidate() {} };
}

function plural(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function toDisplaySeparators(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

function compactHome(filePath: string): string {
	const home = os.homedir();
	return filePath === home || filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}

function isWithinDirectory(absolutePath: string, cwd: string): boolean {
	const relativePath = path.relative(cwd, absolutePath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizeDisplayPath(inputPath: unknown, cwd: string): string {
	if (typeof inputPath !== "string") return "(unknown path)";

	const stripped = inputPath.trim().replace(/^@/, "");
	if (!stripped) return "(unknown path)";

	const absolutePath = path.isAbsolute(stripped) ? path.normalize(stripped) : path.resolve(cwd, stripped);
	if (isWithinDirectory(absolutePath, cwd)) {
		return toDisplaySeparators(path.relative(cwd, absolutePath) || ".");
	}

	return toDisplaySeparators(compactHome(absolutePath));
}

function splitPathPrefix(displayPath: string): { prefix: string; rest: string } {
	if (displayPath.startsWith("~/")) return { prefix: "~/", rest: displayPath.slice(2) };
	if (displayPath.startsWith("/")) return { prefix: "/", rest: displayPath.slice(1) };
	return { prefix: "", rest: displayPath };
}

function truncatePathDepth(displayPath: string): string {
	const { prefix, rest } = splitPathPrefix(displayPath);
	const segments = rest.split("/").filter(Boolean);
	if (segments.length <= MAX_PATH_DEPTH) return displayPath;

	const headCount = Math.min(KEEP_HEAD_SEGMENTS, segments.length);
	const tailCount = Math.min(KEEP_TAIL_SEGMENTS, Math.max(0, segments.length - headCount));
	const head = segments.slice(0, headCount);
	const tail = segments.slice(segments.length - tailCount);
	return `${prefix}${[...head, "…", ...tail].join("/")}`;
}

function truncatePathChars(displayPath: string): string {
	if (displayPath.length <= MAX_PATH_CHARS) return displayPath;

	const available = Math.max(8, MAX_PATH_CHARS - 1);
	const headLength = Math.max(8, Math.floor(available / 3));
	const tailLength = Math.max(8, available - headLength);
	return `${displayPath.slice(0, headLength)}…${displayPath.slice(-tailLength)}`;
}

function compactDisplayPath(displayPath: string): string {
	return truncatePathChars(truncatePathDepth(displayPath));
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
	const sorted = ranges
		.filter((range) => range.start > 0 && range.end >= range.start)
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: LineRange[] = [];

	for (const range of sorted) {
		const previous = merged.at(-1);
		if (!previous || range.start > previous.end + 1) {
			merged.push({ ...range });
		} else {
			previous.end = Math.max(previous.end, range.end);
		}
	}

	return merged;
}

function addLineRange(ranges: LineRange[], start: number, lineCount: number): LineRange[] {
	if (lineCount <= 0) return ranges;
	return mergeRanges([...ranges, { start, end: start + lineCount - 1 }]);
}

function countRangeLines(ranges: LineRange[]): number {
	return ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
}

function formatLineRange(range: LineRange): string {
	return range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
}

function formatLineRanges(ranges: LineRange[]): string {
	return ranges.map(formatLineRange).join(", ");
}

function positiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const integer = Math.floor(value);
	return integer > 0 ? integer : undefined;
}

function getReadStartLine(args: unknown): number {
	if (!args || typeof args !== "object" || Array.isArray(args)) return 1;
	return positiveInteger((args as { offset?: unknown }).offset) ?? 1;
}

function isImageReadResult(result: ReadResultLike): boolean {
	return result.content?.some((block) => block.type === "image") === true;
}

function textContent(result: ReadResultLike): string | undefined {
	return result.content?.find((block) => block.type === "text" && typeof block.text === "string")?.text;
}

function extractLineCountFromText(text: string): number {
	const showingMatch = text.match(/\[Showing lines (\d+)-(\d+) of \d+(?: \([^)]+\))?\. Use offset=\d+ to continue\.\]\s*$/);
	if (showingMatch) {
		const start = Number.parseInt(showingMatch[1] ?? "", 10);
		const end = Number.parseInt(showingMatch[2] ?? "", 10);
		if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) return end - start + 1;
	}

	const withoutNotice = text
		.replace(/\n\n\[Showing lines \d+-\d+ of \d+(?: \([^)]+\))?\. Use offset=\d+ to continue\.\]\s*$/, "")
		.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]\s*$/, "");

	return withoutNotice ? withoutNotice.split("\n").length : 0;
}

function extractReadLineCount(result: ReadResultLike): number | undefined {
	if (result.details && typeof result.details === "object" && !Array.isArray(result.details)) {
		const truncation = (result.details as { truncation?: { outputLines?: unknown } }).truncation;
		if (typeof truncation?.outputLines === "number") return truncation.outputLines;
	}

	const text = textContent(result);
	return typeof text === "string" ? extractLineCountFromText(text) : undefined;
}

function getOrCreateEntry(batch: ReadBatch, displayPath: string): ReadBatchEntry | undefined {
	if (!displayPath) return undefined;

	const existing = batch.entries.find((entry) => entry.path === displayPath);
	if (existing) return existing;

	const entry: ReadBatchEntry = {
		path: displayPath,
		ranges: [],
		inFlight: 0,
		failed: false,
		isImage: false,
	};
	batch.entries.push(entry);
	return entry;
}

function mergeDetailsWithMeta(details: unknown, meta: ReadSummaryMeta): Record<string, unknown> {
	if (details && typeof details === "object" && !Array.isArray(details)) {
		return { ...(details as Record<string, unknown>), [META_KEY]: meta };
	}
	return { [META_KEY]: meta };
}

function getSummaryMeta(details: unknown): ReadSummaryMeta | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const raw = (details as Record<string, unknown>)[META_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

	const meta = raw as { batchId?: unknown; toolCallId?: unknown };
	if (typeof meta.batchId !== "string" || typeof meta.toolCallId !== "string") return undefined;
	return { batchId: meta.batchId, toolCallId: meta.toolCallId };
}

function entryStatus(entry: ReadBatchEntry, theme: Theme): string {
	if (entry.failed) return theme.fg("warning", "[failed]");
	if (entry.isImage) return theme.fg("muted", "[image]");
	if (entry.inFlight > 0) return theme.fg("muted", "[reading…]");

	const lineCount = countRangeLines(entry.ranges);
	if (lineCount > 0) return theme.fg("muted", `[${plural(lineCount, "line")}]`);
	return theme.fg("muted", "[read]");
}

function formatCollapsed(batch: ReadBatch, theme: Theme, width: number): string {
	const fileCount = batch.entries.length;
	const failedCount = batch.entries.filter((entry) => entry.failed).length;
	const dot = batch.done ? theme.fg("success", "●") : theme.fg("accent", "○");
	const verb = batch.done ? "Read" : "Reading";
	const shownEntries = batch.entries.slice(0, MAX_COLLAPSED_FILES);
	const remaining = Math.max(0, batch.entries.length - shownEntries.length);
	const paths = shownEntries.map((entry) => theme.fg(entry.failed ? "warning" : "accent", compactDisplayPath(entry.path)));
	if (remaining > 0) paths.push(theme.fg("muted", `+${remaining} more`));

	let line = `${dot} ${theme.fg(batch.done ? "success" : "accent", `${verb} ${plural(fileCount, "file")}`)}`;
	if (failedCount > 0) line += ` ${theme.fg("warning", `(${failedCount} failed)`)}`;
	if (paths.length > 0) line += `${theme.fg("dim", ": ")}${paths.join(theme.fg("dim", ", "))}`;
	return truncateToWidth(line, width);
}

function formatExpandedEntry(entry: ReadBatchEntry, theme: Theme, width: number): string {
	const prefix = theme.fg("dim", "  ");
	const status = entryStatus(entry, theme);
	const availablePathWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(status) - 1);
	const styledPath = theme.fg(entry.failed ? "warning" : "accent", compactDisplayPath(entry.path));
	return `${prefix}${truncateToWidth(styledPath, availablePathWidth)} ${status}`;
}

function createSummaryComponent(batchId: string, batches: Map<string, ReadBatch>, theme: Theme, expanded: boolean): Component {
	return {
		render(width: number): string[] {
			const batch = batches.get(batchId);
			if (!batch) return [];

			const safeWidth = Math.max(1, width);
			if (!expanded) return [formatCollapsed(batch, theme, safeWidth)];

			const lines = [formatCollapsed(batch, theme, safeWidth)];
			for (const entry of batch.entries) {
				lines.push(formatExpandedEntry(entry, theme, safeWidth));
				if (entry.ranges.length > 0) {
					lines.push(truncateToWidth(`${theme.fg("dim", "    ")}${theme.fg("muted", formatLineRanges(entry.ranges))}`, safeWidth));
				}
			}
			return lines;
		},
		invalidate() {},
	};
}

export default function ultraCompactReadSummary(pi: ExtensionAPI) {
	(globalThis as Record<PropertyKey, unknown>)[ULTRA_READ_SUMMARY_GLOBAL_KEY] = true;

	const batches = new Map<string, ReadBatch>();
	const toolCallToBatch = new Map<string, string>();
	const toolCallToPath = new Map<string, string>();

	let activeBatchId: string | undefined;
	let batchCounter = 0;

	function clearState(): void {
		batches.clear();
		toolCallToBatch.clear();
		toolCallToPath.clear();
		activeBatchId = undefined;
		batchCounter = 0;
	}

	function createBatch(anchorToolCallId: string): ReadBatch {
		batchCounter += 1;
		const batch: ReadBatch = {
			id: `cashd-read-batch-${batchCounter}`,
			anchorToolCallId,
			entries: [],
			inFlight: 0,
			pendingFinalize: false,
			done: false,
		};
		batches.set(batch.id, batch);
		activeBatchId = batch.id;
		return batch;
	}

	function startReadCall(toolCallId: string, displayPath: string): ReadBatch {
		let batch = activeBatchId ? batches.get(activeBatchId) : undefined;
		if (!batch || batch.done || batch.pendingFinalize) batch = createBatch(toolCallId);

		const entry = getOrCreateEntry(batch, displayPath);
		if (entry) entry.inFlight += 1;
		batch.inFlight += 1;
		toolCallToBatch.set(toolCallId, batch.id);
		toolCallToPath.set(toolCallId, displayPath);
		return batch;
	}

	function markActiveBatchPendingFinalize(): void {
		if (!activeBatchId) return;
		const batch = batches.get(activeBatchId);
		if (!batch) {
			activeBatchId = undefined;
			return;
		}

		batch.pendingFinalize = true;
		if (batch.inFlight === 0) {
			batch.done = true;
			activeBatchId = undefined;
		}
	}

	function completeReadCall(toolCallId: string): void {
		const batchId = toolCallToBatch.get(toolCallId);
		if (!batchId) return;
		const batch = batches.get(batchId);
		if (!batch) return;

		batch.inFlight = Math.max(0, batch.inFlight - 1);
		const displayPath = toolCallToPath.get(toolCallId);
		if (displayPath) {
			const entry = getOrCreateEntry(batch, displayPath);
			if (entry) entry.inFlight = Math.max(0, entry.inFlight - 1);
		}

		if (batch.pendingFinalize && batch.inFlight === 0) {
			batch.done = true;
			if (activeBatchId === batch.id) activeBatchId = undefined;
		}
	}

	function markEntryFailed(batchId: string, displayPath: string): void {
		const batch = batches.get(batchId);
		if (!batch) return;
		const entry = getOrCreateEntry(batch, displayPath);
		if (entry) entry.failed = true;
	}

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("read", event)) {
			startReadCall(event.toolCallId, normalizeDisplayPath(event.input.path, ctx.cwd));
			return;
		}

		markActiveBatchPendingFinalize();
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant" && event.message.stopReason !== "toolUse") {
			markActiveBatchPendingFinalize();
		}
	});

	pi.on("agent_end", async () => {
		markActiveBatchPendingFinalize();
	});

	pi.on("session_start", async (_event, ctx) => {
		clearState();
		const readTool = createReadToolDefinition(ctx.cwd);

		pi.registerTool({
			...readTool,
			renderShell: "self",

			async execute(toolCallId, params, signal, onUpdate, executeCtx) {
				const displayPath = normalizeDisplayPath(params.path, executeCtx.cwd);
				let batchId = toolCallToBatch.get(toolCallId);
				if (!batchId) batchId = startReadCall(toolCallId, displayPath).id;

				try {
					const result = await readTool.execute(toolCallId, params, signal, onUpdate, executeCtx);
					const batch = batches.get(batchId);
					const entry = batch ? getOrCreateEntry(batch, displayPath) : undefined;
					if (entry) {
						const resultLike: ReadResultLike = {
							content: result.content as ToolContentBlock[] | undefined,
							details: result.details,
						};
						entry.isImage = entry.isImage || isImageReadResult(resultLike);

						if (!entry.isImage) {
							const lineCount = extractReadLineCount(resultLike);
							if (typeof lineCount === "number") {
								entry.ranges = addLineRange(entry.ranges, getReadStartLine(params), lineCount);
							}
						}
					}

					return {
						...result,
						details: mergeDetailsWithMeta(result.details, { batchId, toolCallId }),
					};
				} catch (error) {
					markEntryFailed(batchId, displayPath);
					throw error;
				} finally {
					completeReadCall(toolCallId);
				}
			},

			renderCall() {
				return emptyComponent();
			},

			renderResult(result, options, theme, context) {
				let meta = getSummaryMeta(result.details);
				if (!meta) {
					const batchId = toolCallToBatch.get(context.toolCallId);
					if (batchId) meta = { batchId, toolCallId: context.toolCallId };
				}

				if (!meta) return emptyComponent();
				const batch = batches.get(meta.batchId);
				if (!batch || batch.anchorToolCallId !== meta.toolCallId) return emptyComponent();
				return createSummaryComponent(meta.batchId, batches, theme, options.expanded);
			},
		});
	});
}
