#!/usr/bin/env bash
# Installs orbit-job and its skill into a Claude cloud session.
# Usage: curl -fsSL https://raw.githubusercontent.com/DragonflyAI-sh/orbit/<ref>/tools/orbit-job/install.sh | bash -s -- <ref>
set -euo pipefail
ref="${1:-main}"
base="https://raw.githubusercontent.com/DragonflyAI-sh/orbit/$ref/tools/orbit-job"
bin="$HOME/.local/bin"
skill="$HOME/.claude/skills/orbit-job"
mkdir -p "$bin" "$skill"
curl -fsSL "$base/orbit-job" -o "$bin/orbit-job"
curl -fsSL "$base/SKILL.md" -o "$skill/SKILL.md"
chmod +x "$bin/orbit-job"
case ":$PATH:" in *":$bin:"*) ;; *) echo "orbit-job: add $bin to PATH, or run $bin/orbit-job" ;; esac
echo "orbit-job: installed $("$bin/orbit-job" --version) from $ref"
