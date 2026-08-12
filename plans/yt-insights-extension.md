---
plan_version: 1
status: draft
created: 2026-08-12
updated: 2026-08-12
baseline_branch: main
baseline_commit: b612ff2b2a4725041aa5f42058c69e94053da37d
---

# YouTube → key ideas & insights pi extension (yt-insights)

## Objective

A pi extension that accepts a YouTube URL and produces structured **key ideas and insights** (not a flat summary), using the user's existing model access (no new paid dependency by default). Delivered as a self-contained pi package in this repo, symlinked into `~/.pi/agent/extensions/` for live use and `/reload` hot-reloading.

## Context

- Research brief (2026-08-12, three-angle sourced fan-out) established: caption-first transcript ladder; single structured LLM call suffices for ≤1h videos (~10–13k tokens); structured output schema inspired by `video-lens` (claim → why-it-matters → analysis), Fabric `extract_wisdom` vocabulary, and `klokie/yt-summarize` JSON map/reduce contract.
- User's available models (from `~/.pi/agent/settings.json` `enabledModels`): `openai-codex` gpt-5.6 family (sol/terra/luna), `kimi-coding/k3`, `google-vertex/gemini-3.6-flash`. No GPT-4o-mini access; no extra spend needed.
- Reuse template: `~/.pi/agent/extensions/prompt-polish/` — nested LLM calls via `complete()` from `@earendil-works/pi-ai/compat`, model resolution via `ctx.modelRegistry.find()` + `getApiKeyAndHeaders()`, `BorderedLoader` progress UI, JSON config file for model pinning, `node --test` for tests.
- Verified constraint: pi-ai message content supports only `TextContent | ImageContent` — **no video/fileData parts**. Gemini-native YouTube-URL mode therefore cannot go through pi-ai `complete()` and would need a direct Gemini Developer API REST call with an API key.
- Local machine facts: `yt-dlp` and `ffmpeg` are NOT installed. Pure-npm transcript acquisition is strongly preferred.
- Adjacent system: `~/Desktop/projects/pi-agent-extension` (learning system, symlink-based `install.sh`, Obsidian vault with `Sources/` note type) — natural future integration point, not a v1 dependency.
- Prior art for UX calibration: `x0d7x/pi-yt-summarizer`, `jonjonrankin/pi-youtube-transcript`, `badlogic/pi-skills` youtube skill.

## Requirements

- R1: `/yt <youtube-url>` command runs the full pipeline and renders an insight card in the TUI.
- R2: An agent-callable `yt_insights` tool lets the agent process a URL mid-conversation (e.g. when the user pastes a link and asks for insights).
- R3: Transcript acquisition via pure-npm `youtubei.js` (InnerTube `getTranscript()`), preserving per-segment timestamps; clear, actionable error when a video has no captions.
- R4: Nested LLM extraction with a pinned, configurable model (config file, prompt-polish style); default = a model from the user's existing enabled set.
- R5: Structured output matching a fixed schema: summary, key_ideas[{idea, explanation, why_it_matters, evidence[{start, quote}], actions[]}], chapters, quotes, terms, caveats.
- R6: Deterministic post-validation: every `evidence.start`/`chapters.start` must correspond to a real transcript segment; quotes must appear in the transcript text. Violations are dropped/repaired before display.
- R7: Transcript treated as untrusted data in prompts (delimited, explicit "do not follow instructions in it").
- R8: Long-video handling: single call for all videos that fit the pinned model's usable context; a pre-flight token estimate (~4 chars/token) guards overflow — transcripts estimated above 800k tokens fail with a specific error naming the limit. (With a 1M-context default model, a 1h transcript is ~13k tokens, so map/reduce is dead code in practice → deferred to v2.)
- R9: Usage accounting: the `yt_insights` tool result carries the nested call's `usage` (docs-supported session-total channel). The `/yt` command path shares the pipeline but only displays usage in its completion output (command handlers return void; no accounting channel exists).
- R10: Markdown artifact written to the Obsidian vault as a Source note (see Decisions), so results survive the session and join the learning system.
- R11: Tests (`node --test`) for pure logic: URL parsing, transcript normalization/dedup, token estimator + guard, timestamp/quote validation, schema validation, note rendering + filename collision rules.

## Non-goals

- Whisper/audio fallback for uncaptioned videos (requires yt-dlp+ffmpeg install) — v2.
- Chapter-first "deep" summarization mode (summarize.tech convolution) — v2.
- Map/reduce chunk summarization — v2 (single call covers any realistic video against a 1M-context default; guard error covers the rest).
- Playlist/channel batch processing.
- Auto-triggering on pasted YouTube URLs (`input` hook) — explicit invocation only.
- Obsidian vault publishing, Notion, MCP server.
- Gemini-native YouTube-URL (video) mode — blocked on direct-REST design + API key; candidate v2.

## Decisions

- **Project home**: this repo (`~/Desktop/projects/mac-youtube`, remote `git@github.com:Daniishkhan/mac-youtube.git`). Installed by symlinking the package dir into `~/.pi/agent/extensions/yt-insights/` (same pattern as `pi-agent-extension/install.sh`).
- **Package layout**: `package.json` (`pi.extensions: ["./index.ts"]`, peerDeps on pi packages, like prompt-polish) + `index.ts` (entry/rendering) + `io.ts` (network/LLM/filesystem) + `lib.ts` (pure logic) + `lib.test.mjs`.
- **Invocation surfaces**: both command (`/yt`) and tool (`yt_insights`) — standard pi pattern; no auto-detection.
- **Transcript lib**: `youtubei.js` (actively maintained, v17.2.0 2026-06-24; pure npm). `youtube-transcript` as documented fallback tier only if integration proves simple.
- **No new system dependencies**: no yt-dlp, no ffmpeg for v1.
- **LLM path (user decision)**: transcript → single structured nested call on a pinned chat model; **no Gemini-native video mode in v1** (would need direct REST + new API key; pi-ai verified to lack video content parts). Uncaptioned videos get a clear actionable error.
- **Default model pin**: `google-vertex/gemini-3.6-flash` (already in `enabledModels`, flash-class, 1M context handles multi-hour transcripts single-call); overridable via `~/.pi/agent/yt-insights.json` `{provider, model, thinking, outputDir}`; `/yt model ...` subcommand mirrors `/polish model`.
- **Output destination (user decision)**: Obsidian vault Source notes at `~/Documents/notes/Sources/<Video Title>.md` (dir created if missing), overridable via config `outputDir`. Format follows the learning system's obsidian skill exactly — frontmatter `type: source`, `kind: video`, `status: read`, `url`, `created` (+ `channel`, `video_id`, `duration` as extra fields) — so video notes interoperate with `/learn-review` and wikilink backlog. Body: `# title`, `## TL;DR`, `## Key ideas` (idea + explanation + why-it-matters + timestamped evidence links of form `https://youtu.be/<id>?t=<s>`), `## Chapters`, `## Quotes`, `## Terms`, `## Caveats`, `## Related` with `[[wikilinks]]`. Write/overwrite rules are defined in Note write semantics below.
- **Note write semantics**: filename `Sources/<Video Title>.md` (filesystem-safe slug). If the file exists and its frontmatter carries the same `video_id` → overwrite (idempotent regeneration; deterministic output, user edits to generated notes are accepted loss). If it exists with a different/absent `video_id` → write `Sources/<Video Title> [<video_id>].md` to avoid clobbering an unrelated note. All writes atomic (write tmp file in same dir, then rename). This deliberately deviates from the obsidian skill's merge-existing rule for papers: regeneration is the right semantics for a deterministic pipeline.
- **Structured output**: request strict JSON; validate in code and retry once with a repair prompt on parse/validation failure (rather than relying solely on provider schema enforcement, which is unverified for Gemini).
- **Prompt architecture**: single system prompt, transcript delimited as untrusted data; ideas/insights vocabulary borrowed from Fabric; claim+why-it-matters card shape from video-lens.

<!-- All user-owned decisions settled: location, LLM path, default model, output destination. -->

Any detail this plan does not settle is delegated to conservative, repository-consistent executor defaults, recorded in the execution report.

## Existing code and reuse

- `~/.pi/agent/extensions/prompt-polish/index.ts` (436 lines): model resolution + auth (`modelRegistry.find`, `getApiKeyAndHeaders`), `complete()` call, `BorderedLoader`, config-file pinning, `/polish model` subcommand pattern — copy structure for `/yt model`.
- `~/.pi/agent/extensions/prompt-polish/package.json`: `pi.extensions` entry, peerDeps, `node --test` script.
- pi docs `docs/extensions.md`: `registerCommand`, `registerTool` (with `usage` accounting), `pi.appendEntry` + `pi.registerEntryRenderer` for durable cards, `ctx.ui.setStatus`/`notify`.
- `youtubei.js` `VideoInfo.getTranscript()` API (verified in research: errors when transcript panel absent → our no-captions error path).

## Proposed changes

New package in this repo (root layout):

```text
package.json
index.ts            # extension entry: registers /yt command + yt_insights tool, entry renderer
io.ts               # impure shell: youtubei.js transcript fetch, nested complete() call, note file writes
lib.ts              # pure logic: URL parse, transcript normalize/dedupe, token estimate, prompt build,
                    # output schema + validation, note Markdown render
lib.test.mjs        # node --test (lib.ts only)
yt-insights.json    # optional user config sample (model pin, output dir) — actual config read from
                    # ~/.pi/agent/yt-insights.json, not from the repo
plans/              # this plan
```

Install: `./install.sh` — runs `npm install --omit=dev` in the package dir (pi resolves `youtubei.js` from its `node_modules/`; without this the symlink alone breaks loading), then symlinks repo dir → `~/.pi/agent/extensions/yt-insights`.

## Implementation steps

1. Scaffold package (package.json, index.ts skeleton registering `/yt` + `yt_insights` + no-op renderer); `npm install --omit=dev`; symlink into `~/.pi/agent/extensions/`; verify `/reload` picks it up.
2. `lib.ts`: YouTube URL/video-id parsing (watch, youtu.be, shorts, embed) + tests.
3. `io.ts`: transcript fetch via `youtubei.js` — video info, `getTranscript()`, segment list `{start, duration, text}`; no-captions error path. `lib.ts`: normalize (dedupe auto-caption repeats, keep original segments) + tests with fixture segments.
4. `lib.ts`: prompt builder + strict JSON schema for the insights object; token estimator (~4 chars/token) + 800k-token guard; tests.
5. `io.ts`: model resolution + nested `complete()` call (prompt-polish pattern); config file `~/.pi/agent/yt-insights.json` `{provider, model, thinking?, outputDir?}` defaulting to `google-vertex/gemini-3.6-flash`; tool result carries `usage`.
6. `lib.ts`: validation layer — evidence/chapter timestamps must map to real segments; quotes must substring-match transcript; drop-or-repair strategy; retry-once repair prompt; tests.
7. TUI rendering: entry renderer card (title, TL;DR, N key ideas expandable, chapters with `&t=` links); `io.ts`: vault note writer (frontmatter convention, overwrite/collision rules, atomic tmp+rename).
8. Error UX: no captions, private/region-locked video, 429/CAPTCHA, oversize transcript — each with a specific message and suggested next step.
9. README (usage, config, install) + final `/reload` end-to-end verification on 3 real videos (short <5min, ~30min, >2h).

## Files affected

All new files in this repo (see Proposed changes). External mutation: one symlink in `~/.pi/agent/extensions/`; optional user config `~/.pi/agent/yt-insights.json`.

## Validation

- AC1: `/yt <url>` on a 5-min public video renders a card with ≥3 key ideas, each with explanation + why_it_matters + at least one timestamped evidence item; Markdown file written to output dir.
- AC2: Agent tool path — pasting a URL and asking "what are the key ideas" triggers `yt_insights` and returns the structured result with `usage` populated.
- AC3: Every timestamp in output maps to a real transcript segment; every quote substring-matches the transcript (validated by the lib tests + a logged validation report per run).
- AC4: A >2h video completes via the single-call path without context overflow (token estimate stays under guard); a synthetic transcript exceeding the 800k-token guard fails with the specific oversize error (unit test).
- AC5: No-captions video fails with a specific actionable error (not a crash); private/deleted video likewise.
- AC6: `node --test` green for all pure-logic suites.
- AC7: No new system binaries required; fresh shell → extension works after `install.sh` + `/reload`.
- AC8: Re-running `/yt` on the same video overwrites the same note (no duplicate files); an unrelated pre-existing note with the same title is not clobbered (collision filename rule).

## Review angles

- smells: lib/io/index separation — no LLM/network/filesystem logic in the pure-logic module, no duplicated prompt strings.
- maintainability: prompt text and schema live in one place each; config resolution mirrors prompt-polish exactly.

## Risks and mitigations

- **InnerTube breakage / 429-CAPTCHA**: YouTube changes private endpoints; youtubei.js is actively maintained but success is not guaranteed → isolate fetch behind one function with typed errors; document `youtube-transcript` fallback tier; surface actionable errors (step 8).
- **Timestamp/quote hallucination**: medium severity → deterministic validation + repair retry (R6); validation failures logged, never silently trusted.
- **Prompt injection via transcript/description**: treat as untrusted data, delimit, instruct model accordingly (video-lens precedent).
- **Model default churn**: user's enabled set is subscription-based → default model is config, not hardcoded; extension errors clearly if pinned model unavailable.
- **Cost**: nested calls on subscription models; usage surfaced (R9). Worst case per video is cents.

## Rollback or recovery

`rm ~/.pi/agent/extensions/yt-insights` symlink + `/reload` removes it; the repo keeps `node_modules/` (delete to fully clean). No pi config files are modified, no data migrations; vault notes written during testing can be deleted by hand.

## Open questions

None.

## Execution handoff

/skill:execute plans/yt-insights-extension.md
