# yt-insights

A self-contained [Pi](https://github.com/badlogic/pi-mono) extension that converts a **captioned** YouTube video into grounded key ideas, then saves the result as an Obsidian Source note.

## Install

```bash
./install.sh
```

This installs the production dependencies (`youtube-transcript` and `youtubei.js`) and symlinks this directory to `~/.pi/agent/extensions/yt-insights`. Start Pi or run `/reload` after installation.

No `yt-dlp`, `ffmpeg`, or other system binaries are required.

## Usage

```text
/yt https://www.youtube.com/watch?v=VIDEO_ID
/yt https://youtu.be/VIDEO_ID
/yt model
/yt model google-vertex gemini-3.6-flash
/yt model google-vertex gemini-3.6-flash high
/yt model reset
```

`/yt` fetches captions through `youtube-transcript` first, with `youtubei.js` as a fallback, preserves timestamps, asks the configured Pi model for strict structured JSON, validates every model-provided timestamp and quote against the transcript, retries once for malformed or ungrounded output, and writes a note. It displays the nested model usage after completion.

Agents can call the same pipeline with `yt_insights`. Its tool result includes nested-call usage so Pi can include it in session totals.

## Configuration

Copy the sample into Pi's agent directory and edit it if needed:

```bash
cp yt-insights.json ~/.pi/agent/yt-insights.json
```

```json
{
  "provider": "google-vertex",
  "model": "gemini-3.6-flash",
  "thinking": "high",
  "outputDir": "/Users/danish/Documents/notes/Sources"
}
```

All values are optional. Defaults are:

- provider: `google-vertex`
- model: `gemini-3.6-flash`
- output directory: `/Users/danish/Documents/notes/Sources`
- thinking: `off`

The selected thinking level, including the default `off`, is forwarded to Pi's model registry as `reasoning`. Provider support is best-effort; this behavior has been probe-verified only for `google-vertex`. Authentication is resolved by Pi's model registry; the configured provider/model must be usable in your Pi setup. `/yt model` checks availability before it writes a model pin.

## Notes

Notes use the Source-note convention:

```yaml
---
type: source
kind: video
status: read
url: "https://www.youtube.com/watch?v=VIDEO_ID"
created: 2026-08-12
channel: "Channel"
video_id: "VIDEO_ID"
duration: "12:34"
---
```

They are written atomically. Running the extension again for the same video overwrites the same note. If a note with the same title has a different or missing `video_id`, yt-insights writes `<Title> [<video_id>].md` instead of overwriting it.

## Limits and errors

- Captions are required in v1. For an uncaptioned video, try a video with captions or provide a transcript; audio transcription is a future feature.
- Private, deleted, or region-locked videos report an actionable availability error.
- YouTube 429/CAPTCHA responses advise waiting, opening YouTube in a browser if needed, and retrying.
- Transcript input is treated as untrusted data in the nested-model prompt; instructions found in captions are not followed.
- Input is estimated at roughly four characters per token. Transcripts above **800,000 tokens** fail before a model request with a message naming the limit. Map/reduce and audio fallback are intentionally out of scope for v1.

## Test

```bash
node --test lib.test.mjs
```

The test suite covers the pure logic: URL parsing, caption normalization/deduplication, the token guard, strict schema parsing, deterministic timestamp/quote validation, prompt delimiters, note rendering, and filename collision decisions.
