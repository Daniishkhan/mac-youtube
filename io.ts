import { type AssistantMessage, type UserMessage, type Usage } from "@earendil-works/pi-ai";
import { getAgentDir, withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Innertube } from "youtubei.js";
import {
	fetchTranscript,
	YoutubeTranscriptDisabledError,
	YoutubeTranscriptNotAvailableError,
	YoutubeTranscriptNotAvailableLanguageError,
	YoutubeTranscriptTooManyRequestError,
	YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	assertPromptFits,
	assertTranscriptFits,
	buildCompletionOptions,
	buildInsightsPrompt,
	buildRepairPrompt,
	chooseNoteFilename,
	formatInsightsSummary,
	filesystemSafeTitle,
	mapYoutubeTranscriptSegments,
	normalizeTranscript,
	parseJsonObject,
	parseYouTubeUrl,
	renderSourceNote,
	validateInsightsSchema,
	validateTranscriptReferences,
	validateYtConfig,
	INSIGHTS_SYSTEM_PROMPT,
	type Insights,
	type StoredYtConfig,
	type TranscriptSegment,
	type VideoMetadata,
	type YoutubeTranscriptSegment,
} from "./lib.ts";

export const DEFAULT_PROVIDER = "google-vertex";
export const DEFAULT_MODEL = "gemini-3.6-flash";
export const DEFAULT_OUTPUT_DIR = "/Users/danish/Documents/notes/Sources";

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];
export function isThinking(value: string): value is Thinking {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}
type StoredConfig = StoredYtConfig<Thinking>;

export type YtConfig = Omit<Required<StoredConfig>, "thinking"> & { thinking: Thinking | "off" };

export type FetchedVideo = {
	video: VideoMetadata;
	transcript: TranscriptSegment[];
	estimatedTokens: number;
};

export type InsightRun = {
	video: VideoMetadata;
	insights: Insights;
	notePath: string;
	estimatedTokens: number;
	usage: Usage;
	repaired: boolean;
	validationViolations: string[];
};

export class NoCaptionsError extends Error {
	constructor() {
		super("This video has no accessible captions. Try a video with captions or provide a transcript; audio transcription is not available in yt-insights v1.");
		this.name = "NoCaptionsError";
	}
}

export class YouTubeVideoUnavailableError extends Error {
	constructor() {
		super("This video is private, deleted, region-locked, or otherwise unavailable. Open the link in YouTube to confirm it is public, then try again.");
		this.name = "YouTubeVideoUnavailableError";
	}
}

export class YouTubeRateLimitedError extends Error {
	constructor() {
		super("YouTube rate-limited this request or requested a CAPTCHA. Wait a few minutes, open YouTube in a browser if needed, then retry.");
		this.name = "YouTubeRateLimitedError";
	}
}

export function configPath(): string {
	return path.join(getAgentDir(), "yt-insights.json");
}

/** Reads and validates the user-owned config; absent config uses defaults. */
export async function readConfig(): Promise<StoredConfig | null> {
	const location = configPath();
	try {
		const raw = JSON.parse(await readFile(location, "utf8")) as unknown;
		return validateYtConfig(raw, location, THINKING_LEVELS);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if (error instanceof SyntaxError) {
			throw new Error(`Could not parse yt-insights config at ${location}: ${error.message}`);
		}
		throw error;
	}
}

export async function writeConfig(config: StoredConfig): Promise<void> {
	await mkdir(path.dirname(configPath()), { recursive: true });
	await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export type LenientConfigRead = {
	config: StoredConfig | null;
	ignoredInvalid: boolean;
};

/** Reads config for repair commands, treating malformed or unreadable contents as absent. */
export async function readConfigLenient(): Promise<LenientConfigRead> {
	try {
		return { config: await readConfig(), ignoredInvalid: false };
	} catch {
		return { config: null, ignoredInvalid: true };
	}
}

/** Removes model-specific keys but preserves an output directory override. */
export async function clearConfig(): Promise<void> {
	const config = await readConfig();
	if (!config) return;
	const { provider: _provider, model: _model, thinking: _thinking, ...remaining } = config;
	if (Object.keys(remaining).length > 0) {
		await writeConfig(remaining);
		return;
	}
	try {
		await unlink(configPath());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Resets malformed config by deleting it instead of requiring a validating read. */
export async function clearConfigLenient(): Promise<LenientConfigRead> {
	const result = await readConfigLenient();
	if (!result.ignoredInvalid) {
		if (result.config) await clearConfig();
		return result;
	}
	try {
		await unlink(configPath());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return result;
}

export async function effectiveConfig(): Promise<YtConfig> {
	const config = await readConfig();
	return {
		provider: config?.provider ?? DEFAULT_PROVIDER,
		model: config?.model ?? DEFAULT_MODEL,
		thinking: config?.thinking ?? "off",
		outputDir: config?.outputDir ?? DEFAULT_OUTPUT_DIR,
	};
}

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toTranscriptSegment(segment: unknown): TranscriptSegment | null {
	const candidate = segment as {
		start_ms?: unknown;
		end_ms?: unknown;
		snippet?: { toString?: () => string };
	};
	const startMs = Number(candidate.start_ms);
	const endMs = Number(candidate.end_ms);
	const text = candidate.snippet?.toString?.() ?? "";
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
	return { start: startMs / 1000, duration: (endMs - startMs) / 1000, text };
}

function classifyYoutubeiError(error: unknown): Error {
	const message = messageFromError(error);
	const folded = message.toLowerCase();
	if (folded.includes("429") || folded.includes("captcha") || folded.includes("sign in to confirm")) {
		return new YouTubeRateLimitedError();
	}
	if (
		folded.includes("private") ||
		folded.includes("unavailable") ||
		folded.includes("deleted") ||
		folded.includes("region") ||
		folded.includes("not available")
	) {
		return new YouTubeVideoUnavailableError();
	}
	if (
		folded.includes("transcript") ||
		folded.includes("caption") ||
		folded.includes("engagement panels")
	) {
		return new NoCaptionsError();
	}
	return error instanceof Error ? error : new Error(message);
}

function classifyYoutubeTranscriptError(error: unknown): Error {
	if (error instanceof YoutubeTranscriptTooManyRequestError) return new YouTubeRateLimitedError();
	if (error instanceof YoutubeTranscriptVideoUnavailableError) return new YouTubeVideoUnavailableError();
	if (
		error instanceof YoutubeTranscriptDisabledError ||
		error instanceof YoutubeTranscriptNotAvailableError ||
		error instanceof YoutubeTranscriptNotAvailableLanguageError
	) {
		return new NoCaptionsError();
	}
	return error instanceof Error ? error : new Error(messageFromError(error));
}

function isTypedYouTubeError(error: Error): boolean {
	return error instanceof NoCaptionsError || error instanceof YouTubeVideoUnavailableError || error instanceof YouTubeRateLimitedError;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function fetchOEmbedMetadata(reference: { id: string; url: string }): Promise<{ title: string | null; channel: string | null }> {
	try {
		const endpoint = new URL("https://www.youtube.com/oembed");
		endpoint.search = new URLSearchParams({ url: reference.url, format: "json" }).toString();
		const response = await fetch(endpoint);
		if (!response.ok) return { title: null, channel: null };
		const payload = (await response.json()) as { title?: unknown; author_name?: unknown };
		return { title: nonEmptyString(payload.title), channel: nonEmptyString(payload.author_name) };
	} catch {
		return { title: null, channel: null };
	}
}

/**
 * Uses youtube-transcript first and falls back to youtubei.js's documented
 * Innertube.getInfo() → VideoInfo.getTranscript() surface when needed.
 */
export async function fetchVideoAndTranscript(url: string): Promise<FetchedVideo> {
	const reference = parseYouTubeUrl(url);
	if (!reference) {
		throw new Error("Invalid YouTube URL. Use a youtube.com/watch, youtu.be, shorts, or embed link.");
	}

	let primaryTranscript: YoutubeTranscriptSegment[] | null = null;
	let primaryError: Error | null = null;
	try {
		primaryTranscript = await fetchTranscript(reference.id);
		if (primaryTranscript.length === 0) throw new NoCaptionsError();
	} catch (error) {
		primaryError = isTypedYouTubeError(error instanceof Error ? error : new Error(messageFromError(error)))
			? (error as Error)
			: classifyYoutubeTranscriptError(error);
	}

	let info: Awaited<ReturnType<Awaited<ReturnType<typeof Innertube.create>>["getInfo"]>> | null = null;
	try {
		const innertube = await Innertube.create();
		info = await innertube.getInfo(reference.id);
	} catch (error) {
		if (!primaryTranscript) {
			const fallbackError = classifyYoutubeiError(error);
			if (isTypedYouTubeError(fallbackError) || !primaryError) throw fallbackError;
			throw primaryError;
		}
	}

	const basic = info?.basic_info;
	if (info && (!basic || basic.is_private || basic.is_crawlable === false)) throw new YouTubeVideoUnavailableError();

	const duration = typeof basic?.duration === "number" && Number.isFinite(basic.duration) ? basic.duration : undefined;
	let transcript: TranscriptSegment[];
	if (primaryTranscript) {
		transcript = normalizeTranscript(mapYoutubeTranscriptSegments(primaryTranscript, duration));
		if (transcript.length === 0) throw new NoCaptionsError();
	} else {
		if (!info) throw primaryError ?? new Error("Could not fetch a YouTube transcript.");
		try {
			const transcriptInfo = await info.getTranscript();
			const rawSegments = transcriptInfo.transcript.content?.body?.initial_segments ?? [];
			transcript = normalizeTranscript(
				rawSegments.map(toTranscriptSegment).filter((segment): segment is TranscriptSegment => segment !== null),
			);
			if (transcript.length === 0) throw new NoCaptionsError();
		} catch (error) {
			const fallbackError = isTypedYouTubeError(error instanceof Error ? error : new Error(messageFromError(error)))
				? (error as Error)
				: classifyYoutubeiError(error);
			if (isTypedYouTubeError(fallbackError) || !primaryError) throw fallbackError;
			throw primaryError;
		}
	}

	let title = nonEmptyString(basic?.title);
	let channel = nonEmptyString(basic?.author);
	if (!title || !channel) {
		const oEmbed = await fetchOEmbedMetadata(reference);
		title ??= oEmbed.title;
		channel ??= oEmbed.channel;
	}
	const estimatedTokens = assertTranscriptFits(transcript);
	return {
		video: {
			...reference,
			title: title ?? `Untitled video ${reference.id}`,
			channel: channel ?? "Unknown channel",
			duration: duration ?? 0,
		},
		transcript,
		estimatedTokens,
	};
}

type ResolvedModel = {
	model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;
	thinking: Thinking | "off";
	label: string;
};

export function resolveModel(ctx: ExtensionContext, config: YtConfig): ResolvedModel {
	const model = ctx.modelRegistry.find(config.provider, config.model);
	if (!model) {
		throw new Error(
			`yt-insights model not found: ${config.provider}/${config.model}. Pin an available model with /yt model <provider> <model>, or /yt model reset.`,
		);
	}
	return { model, thinking: config.thinking, label: `${config.provider}/${config.model} (${config.thinking})` };
}

function modelText(response: AssistantMessage): string {
	if (response.stopReason === "aborted") throw new Error("yt-insights cancelled.");
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "The insights model request failed without an error message.");
	}
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("The insights model returned empty text. Try again or choose another /yt model.");
	return text;
}

function isAuthenticationError(message: string): boolean {
	return /\b(?:unauthenticated|auth(?:enticate|entication|enticated)?|api[ -]?key|credentials?|not configured|unauthorized|forbidden|permission denied|access denied|sign[ -]?in)\b/i.test(
		message,
	);
}

function completionError(resolved: ResolvedModel, error: unknown): Error {
	const message = messageFromError(error);
	if (isAuthenticationError(message)) {
		return new Error(
			`yt-insights provider ${resolved.model.provider} is not authenticated; check /login or provider setup for ${resolved.model.provider}. ${message}`,
		);
	}
	return new Error(`yt-insights model request failed for ${resolved.model.provider}/${resolved.model.id}: ${message}`);
}

const OUTPUT_TOKEN_RESERVE = 4_000;

async function completeInsights(
	prompt: string,
	resolved: ResolvedModel,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<{ text: string; usage: Usage }> {
	const maxInputTokens = Math.floor(resolved.model.contextWindow * 0.8) - OUTPUT_TOKEN_RESERVE;
	assertPromptFits(
		INSIGHTS_SYSTEM_PROMPT,
		prompt,
		maxInputTokens,
		`${resolved.label}'s ${resolved.model.contextWindow.toLocaleString()}-token context window (80% usable input minus a ${OUTPUT_TOKEN_RESERVE.toLocaleString()}-token output reserve: ${maxInputTokens.toLocaleString()} tokens)`,
	);
	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};
	try {
		// Provider honoring of `reasoning` is best-effort; it is probe-verified only for google-vertex.
		const response = await ctx.modelRegistry.complete(
			resolved.model,
			{ systemPrompt: INSIGHTS_SYSTEM_PROMPT, messages: [message] },
			buildCompletionOptions(resolved.thinking, signal),
		);
		return { text: modelText(response), usage: response.usage };
	} catch (error) {
		throw completionError(resolved, error);
	}
}

function addUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

function parseAndGround(text: string, transcript: TranscriptSegment[]):
	| { ok: true; insights: Insights; violations: string[] }
	| { ok: false; issues: string[] } {
	const parsed = parseJsonObject(text);
	const schema = validateInsightsSchema(parsed);
	if (!schema.ok) return { ok: false, issues: schema.issues };
	const grounded = validateTranscriptReferences(schema.value, transcript);
	return { ok: true, insights: grounded.value, violations: grounded.violations };
}

function extractFrontmatterVideoId(markdown: string): string | null {
	const match = /^---\s*\n[\s\S]*?^video_id:\s*(?:"([^"]+)"|'([^']+)'|([^\n\r]+))\s*$[\s\S]*?^---\s*$/m.exec(markdown);
	return match?.[1] ?? match?.[2] ?? match?.[3]?.trim() ?? null;
}

async function readExistingNote(notePath: string): Promise<{ exists: boolean; videoId: string | null }> {
	try {
		return { exists: true, videoId: extractFrontmatterVideoId(await readFile(notePath, "utf8")) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, videoId: null };
		throw error;
	}
}

/** Writes a Source note atomically and follows the video-id collision contract. */
export async function writeSourceNote(
	outputDir: string,
	video: VideoMetadata,
	insights: Insights,
	created = new Date().toISOString().slice(0, 10),
): Promise<string> {
	const basePath = path.join(outputDir, `${filesystemSafeTitle(video.title)}.md`);
	return withFileMutationQueue(basePath, async () => {
		await mkdir(outputDir, { recursive: true });
		const baseFilename = path.basename(basePath);
		const existingBase = await readExistingNote(basePath);
		let filename = chooseNoteFilename(video.title, video.id, existingBase).filename;
		let suffix = 2;
		let notePath: string;

		// Check the actual target too: another same-title video may already own it.
		while (true) {
			notePath = path.join(outputDir, filename);
			const existingTarget = await readExistingNote(notePath);
			if (!existingTarget.exists || existingTarget.videoId === video.id) break;
			const collisionStem = `${filesystemSafeTitle(video.title)} [${video.id}]`;
			filename = filename === baseFilename ? `${collisionStem}.md` : `${collisionStem}-${suffix++}.md`;
		}

		const content = renderSourceNote({ video, insights, created });
		const tempPath = path.join(outputDir, `.${filename}.${process.pid}.${Date.now()}.tmp`);
		try {
			await writeFile(tempPath, content, "utf8");
			// Recheck immediately before replacement while same-base Pi mutations are queued.
			const finalTarget = await readExistingNote(notePath);
			if (finalTarget.exists && finalTarget.videoId !== video.id) {
				throw new Error(`Refusing to overwrite unrelated Source note at ${notePath}; retry the insights run.`);
			}
			await rename(tempPath, notePath);
		} catch (error) {
			try {
				await unlink(tempPath);
			} catch (cleanupError) {
				if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
					throw new AggregateError([error, cleanupError], "Could not write or clean up the Source note");
				}
			}
			throw error;
		}
		return notePath;
	});
}

/** Full fetch → one nested extraction → optional repair → validated note pipeline. */
export async function runInsights(url: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<InsightRun> {
	const config = await effectiveConfig();
	const fetched = await fetchVideoAndTranscript(url);
	const resolved = resolveModel(ctx, config);
	const first = await completeInsights(buildInsightsPrompt(fetched.video, fetched.transcript), resolved, ctx, signal);
	const firstResult = parseAndGround(first.text, fetched.transcript);
	let insights: Insights;
	let usage = first.usage;
	let repaired = false;
	let validationViolations: string[];

	if (!firstResult.ok || firstResult.violations.length > 0 || firstResult.insights.key_ideas.length === 0) {
		const repairViolations = !firstResult.ok
			? firstResult.issues
			: [
					...firstResult.violations,
					...(firstResult.insights.key_ideas.length === 0 ? ["No key idea retained grounded evidence"] : []),
				];
		const repair = await completeInsights(
			buildRepairPrompt(first.text, repairViolations, fetched.video, fetched.transcript),
			resolved,
			ctx,
			signal,
		);
		usage = addUsage(first.usage, repair.usage);
		repaired = true;
		const repairedResult = parseAndGround(repair.text, fetched.transcript);
		if (!repairedResult.ok) {
			throw new Error(
				`The insights model returned invalid structured output after a repair attempt: ${repairedResult.issues.join("; ")}`,
			);
		}
		if (repairedResult.insights.key_ideas.length === 0) {
			throw new Error("The insights model returned no key idea with grounded evidence after a repair attempt.");
		}
		insights = repairedResult.insights;
		validationViolations = repairedResult.violations;
	} else {
		insights = firstResult.insights;
		validationViolations = firstResult.violations;
	}

	const notePath = await writeSourceNote(config.outputDir, fetched.video, insights);
	return {
		video: fetched.video,
		insights,
		notePath,
		estimatedTokens: fetched.estimatedTokens,
		usage,
		repaired,
		validationViolations,
	};
}

export function describeRun(run: InsightRun): string {
	return formatInsightsSummary(run.video, run.insights, run.notePath);
}
