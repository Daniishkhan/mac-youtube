#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
extensions_dir="$HOME/.pi/agent/extensions"
target="$extensions_dir/yt-insights"

npm install --omit=dev --prefix "$repo_dir"
mkdir -p "$extensions_dir"
ln -sfn "$repo_dir" "$target"
printf 'Installed yt-insights at %s\nReload Pi with /reload.\n' "$target"
