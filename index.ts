import { Type } from "typebox";
import { formatTimestamp } from "./lib.ts";
import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	clearConfigLenient,
	configPath,
	describeRun,
	effectiveConfig,
	isThinking,
	readConfig,
	readConfigLenient,
	runInsights,
	writeConfig,
	type InsightRun,
	type Thinking,
} from "./io.ts";

const ENTRY_TYPE = "yt-insights-card";
const TOOL_MAX_OUTPUT_CHARS = 45_000;
type InsightCard = {
	video: InsightRun["video"];
	insights: InsightRun["insights"];
	notePath: string;
	estimatedTokens: number;
	repaired: boolean;
	validationViolations: string[];
};

type ToolDetails = InsightCard & { usage: InsightRun["usage"] };

function formatUsage(run: InsightRun): string {
	const { usage } = run;
	return `Model usage: ${usage.totalTokens.toLocaleString()} tokens (input ${usage.input.toLocaleString()}, output ${usage.output.toLocaleString()})`;
}

function toCard(run: InsightRun): InsightCard {
	return {
		video: run.video,
		insights: run.insights,
		notePath: run.notePath,
		estimatedTokens: run.estimatedTokens,
		repaired: run.repaired,
		validationViolations: run.validationViolations,
	};
}

function toolContent(run: InsightRun): string {
	const structured = JSON.stringify({
		video: run.video,
		insights: run.insights,
		notePath: run.notePath,
		estimatedTokens: run.estimatedTokens,
		repaired: run.repaired,
		validationViolations: run.validationViolations,
	});
	if (structured.length <= TOOL_MAX_OUTPUT_CHARS) return structured;
	return `${describeRun(run)}\n\n[Structured result is too large for the tool-output limit; the complete validated note was written to ${run.notePath}.]`;
}

function appendCard(pi: ExtensionAPI, run: InsightRun): void {
	pi.appendEntry<InsightCard>(ENTRY_TYPE, toCard(run));
}

async function runWithLoader(
	url: string,
	ctx: ExtensionContext,
	verb: string,
): Promise<InsightRun | null> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return runInsights(url, ctx, ctx.signal);

	let failure: unknown;
	let cancelled = false;
	const result = await ctx.ui.custom<InsightRun | null>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `${verb} YouTube insights...`);
		loader.onAbort = () => {
			cancelled = true;
			done(null);
		};
		void (async () => {
			try {
				done(await runInsights(url, ctx, loader.signal));
			} catch (error) {
				if (!cancelled) failure = error;
				done(null);
			}
		})();
		return loader;
	});
	if (failure) throw failure;
	return result ?? null;
}

async function handleModelCommand(args: string[], ctx: ExtensionCommandContext): Promise<void> {
	if (args.length === 0) {
		const config = await effectiveConfig();
		const stored = await readConfig();
		const origin = stored?.provider || stored?.model || stored?.thinking ? "pinned" : "default";
		ctx.ui.notify(
			`yt-insights model: ${config.provider}/${config.model} · thinking: ${config.thinking} (${origin}) · config: ${configPath()}`,
			"info",
		);
		return;
	}

	if (args.length === 1 && args[0].toLowerCase() === "reset") {
		const { ignoredInvalid } = await clearConfigLenient();
		const config = await effectiveConfig();
		const ignored = ignoredInvalid ? " Previous config was ignored because it was invalid." : "";
		ctx.ui.notify(`yt-insights model reset to ${config.provider}/${config.model}.${ignored}`, "info");
		return;
	}

	const configForMerge = await readConfigLenient();
	const provider = args[0]?.trim() ?? "";
	const rest = args.slice(1);
	let thinking: Thinking | "off" = configForMerge.config?.thinking ?? "off";
	const candidateThinking = rest.at(-1)?.toLowerCase();
	if (rest.length > 1 && candidateThinking && isThinking(candidateThinking)) {
		thinking = rest.pop()!.toLowerCase() as Thinking;
	}
	const model = rest.join(" ").trim();
	if (!provider || !model) {
		ctx.ui.notify("Usage: /yt model [provider model [thinking-level]|reset]", "warning");
		return;
	}
	if (!ctx.modelRegistry.find(provider, model)) {
		ctx.ui.notify(`Model not found: ${provider}/${model}. Check models available in this Pi session.`, "error");
		return;
	}
	const existing = configForMerge.config ?? {};
	const updated = { ...existing, provider, model };
	if (thinking === "off") delete updated.thinking;
	else updated.thinking = thinking;
	await writeConfig(updated);
	const ignored = configForMerge.ignoredInvalid ? " Previous config was ignored because it was invalid." : "";
	ctx.ui.notify(`yt-insights model pinned to ${provider}/${model} · thinking: ${thinking}.${ignored}`, "info");
}

function runErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<InsightCard>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const card = entry.data;
		if (!card) return new Text(theme.fg("error", "yt-insights card data is unavailable."), 0, 0);
		let text = theme.fg("accent", theme.bold(`YouTube insights · ${card.video.title}`));
		text += `\n${theme.fg("muted", card.video.channel)} · ${card.insights.key_ideas.length} key ideas`;
		text += `\n${card.insights.summary}`;
		if (expanded) {
			for (const idea of card.insights.key_ideas) {
				text += `\n\n${theme.bold(idea.idea)}\n${idea.explanation}\n${theme.fg("muted", `Why it matters: ${idea.why_it_matters}`)}`;
				for (const evidence of idea.evidence) {
					text += `\n  ${theme.fg("dim", `${formatTimestamp(evidence.start)} — ${evidence.quote}`)}`;
				}
			}
			if (card.insights.chapters.length > 0) {
				text += "\n\n" + theme.bold("Chapters");
				for (const chapter of card.insights.chapters) {
					const seconds = Math.max(0, Math.floor(chapter.start));
					text += `\n- ${formatTimestamp(chapter.start)} ${chapter.title} — https://www.youtube.com/watch?v=${card.video.id}&t=${seconds}`;
				}
			}
			text += `\n\n${theme.fg("dim", `Note: ${card.notePath}`)}`;
			if (card.repaired || card.validationViolations.length > 0) {
				text += `\n${theme.fg("warning", `Validation repair: ${card.repaired ? "attempted" : "not needed"}; invalid references dropped: ${card.validationViolations.length}.`)}`;
			}
		}
		return new Text(text, 0, 0);
	});

	pi.registerCommand("yt", {
		description: "Extract validated key ideas from a captioned YouTube video and save a Source note",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const parts = raw ? raw.split(/\s+/) : [];
			if (parts[0]?.toLowerCase() === "model") {
				try {
					await handleModelCommand(parts.slice(1), ctx);
				} catch (error) {
					ctx.ui.notify(runErrorMessage(error), "error");
				}
				return;
			}
			if (!raw) {
				ctx.ui.notify("Usage: /yt <youtube-url> | /yt model [provider model [thinking-level]|reset]", "warning");
				return;
			}

			ctx.ui.setStatus("yt-insights", "Fetching YouTube transcript...");
			try {
				const run = await runWithLoader(raw, ctx, "Extracting");
				if (!run) {
					ctx.ui.notify("yt-insights cancelled.", "info");
					return;
				}
				appendCard(pi, run);
				ctx.ui.notify(`${describeRun(run)}\n\n${formatUsage(run)}`, "info");
			} catch (error) {
				ctx.ui.notify(runErrorMessage(error), "error");
			} finally {
				ctx.ui.setStatus("yt-insights", undefined);
			}
		},
	});

	pi.registerTool({
		name: "yt_insights",
		label: "YouTube Insights",
		description: "Fetch a captioned YouTube video and return grounded key ideas, chapters, quotes, terms, caveats, and a saved Source note.",
		promptSnippet: "Extract validated insights from a captioned YouTube URL",
		promptGuidelines: [
			"Use yt_insights when the user asks for key ideas or insights from a specific YouTube video URL. Do not use it for uncaptioned videos unless the user asks to try anyway.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "A YouTube watch, short-link, shorts, or embed URL" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Fetching transcript and extracting grounded insights..." }], details: {} });
			ctx.ui.setStatus("yt-insights", "Extracting YouTube insights...");
			try {
				const run = await runInsights(params.url, ctx, signal);
				appendCard(pi, run);
				return {
					content: [{ type: "text", text: toolContent(run) }],
					details: { ...toCard(run), usage: run.usage } satisfies ToolDetails,
					usage: run.usage,
				};
			} finally {
				ctx.ui.setStatus("yt-insights", undefined);
			}
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("yt_insights "))}${theme.fg("muted", args.url)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Extracting grounded insights..."), 0, 0);
			const details = result.details as ToolDetails | undefined;
			if (!details) return new Text(theme.fg("error", "yt_insights did not return details."), 0, 0);
			let text = theme.fg("success", `✓ ${details.video.title} · ${details.insights.key_ideas.length} key ideas`);
			text += `\n${details.insights.summary}`;
			if (expanded) {
				for (const idea of details.insights.key_ideas) text += `\n- ${idea.idea}: ${idea.why_it_matters}`;
				text += `\n${theme.fg("dim", `Note: ${details.notePath}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
