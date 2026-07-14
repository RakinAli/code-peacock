#!/usr/bin/env bash
# Peacock autopilot — hosted, unattended review runner.
#
# Runs on a VM, container, or cron so your laptop can be off. Every pass it
# enumerates the repo's OPEN PULL REQUESTS and runs the peacock pipeline (PR
# mode) on each one that changed since its last pass. It reviews, tests, audits
# UI, reports, and pushes fixes to each PR's own head branch.
#
# It NEVER merges. This script hard-blocks the merge verb (see run_agent) so a
# bug or prompt-injection cannot cause a merge even if the model tried.
#
# Usage:
#   peacock-autopilot.sh --repo owner/name [options]
#
# Options:
#   --repo <owner/name>     Target repo (required; must be cloneable by gh/git).
#   --workdir <dir>         Where to clone/checkout (default: ./.peacock-autopilot).
#   --agent <claude|codex>  Which CLI drives the pipeline (default: claude).
#   --interval <seconds>    Poll interval; 0 = single pass then exit (default: 0).
#   --max-prs <n>           Cap PRs handled per pass (default: 20).
#   --once                  Alias for --interval 0.
#
# Auth (via environment):
#   GH_TOKEN or GITHUB_TOKEN   contents:write + pull-requests:write. Use a token
#                              WITHOUT admin rights; combine with branch protection
#                              on your default branch so merge stays human-only.
#   ANTHROPIC_API_KEY          when --agent claude
#   OPENAI_API_KEY             when --agent codex
set -euo pipefail

PEACOCK_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO=""
WORKDIR="$PWD/.peacock-autopilot"
AGENT="claude"
INTERVAL=0
MAX_PRS=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    --workdir) WORKDIR="${2:?--workdir needs a path}"; shift 2 ;;
    --agent) AGENT="${2:?--agent needs claude|codex}"; shift 2 ;;
    --interval) INTERVAL="${2:?--interval needs seconds}"; shift 2 ;;
    --max-prs) MAX_PRS="${2:?--max-prs needs a number}"; shift 2 ;;
    --once) INTERVAL=0; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO" ]] || { echo "error: --repo owner/name is required" >&2; exit 2; }
command -v gh >/dev/null || { echo "error: gh CLI not found" >&2; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "error: gh is not authenticated (set GH_TOKEN)" >&2; exit 2; }
[[ "$AGENT" == "claude" || "$AGENT" == "codex" ]] || { echo "error: --agent must be claude or codex" >&2; exit 2; }

log() { printf '%s peacock-autopilot: %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# The merge kill-switch. Sourcing the shared script defines
# peacock_install_killswitch, which writes `gh` and `git` PATH shims that refuse
# every mechanical merge / protected-branch-push vector and forward everything
# else to the real binaries.
# shellcheck source=scripts/merge-killswitch.sh
source "$(dirname "${BASH_SOURCE[0]}")/merge-killswitch.sh"

prepare_repo() {
  if [[ ! -d "$WORKDIR/repo/.git" ]]; then
    log "cloning $REPO"
    gh repo clone "$REPO" "$WORKDIR/repo" -- --quiet
  fi
  git -C "$WORKDIR/repo" fetch --all --prune --quiet
}

# Absolute state dir OUTSIDE the repo checkout, so review markers survive branch
# switches and never get committed. Keyed by PR number -> last-reviewed head SHA.
marker_file() { echo "$WORKDIR/state/pr-$1.sha"; }

run_agent() {
  local pr="$1"
  local prompt="/peacock $pr

You are peacock autopilot running unattended (agent=$AGENT). Review-only:
under NO circumstances merge, enable auto-merge, or push to the default branch.
Push fixes to PR #$pr's own head branch only. When done, leave it green and
mergeable for a human."

  ( cd "$WORKDIR/repo"
    if [[ "$AGENT" == "claude" ]]; then
      claude -p "$prompt" --dangerously-skip-permissions
    else
      codex exec --full-auto --skip-git-repo-check "$(cat "$HOME/.codex/prompts/peacock.md" 2>/dev/null)

$prompt"
    fi
  )
}

one_pass() {
  prepare_repo
  mkdir -p "$WORKDIR/state"
  local prs
  # Open PRs whose base is the repo default branch, oldest first, capped.
  local default_branch
  default_branch="$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')"
  prs="$(gh pr list --repo "$REPO" --state open --base "$default_branch" \
          --json number,headRefOid,isDraft --jq \
          ".[] | select(.isDraft==false) | \"\(.number) \(.headRefOid)\"" | head -n "$MAX_PRS")"

  if [[ -z "$prs" ]]; then
    log "no open PRs to review against $default_branch"
    return
  fi

  while read -r number head_sha; do
    [[ -n "$number" ]] || continue
    local marker; marker="$(marker_file "$number")"
    if [[ -f "$marker" ]] && [[ "$(cat "$marker")" == "$head_sha" ]]; then
      log "PR #$number unchanged since last pass ($head_sha) — skipping"
      continue
    fi
    log "reviewing PR #$number (head $head_sha)"
    if run_agent "$number"; then
      echo "$head_sha" > "$marker"
      log "PR #$number done — left for a human to merge"
    else
      log "PR #$number run failed (exit $?) — will retry next pass"
    fi
  done <<< "$prs"
}

peacock_install_killswitch "$WORKDIR/.shim"
log "target=$REPO agent=$AGENT interval=${INTERVAL}s workdir=$WORKDIR"

if [[ "$INTERVAL" -le 0 ]]; then
  one_pass
  log "single pass complete"
  exit 0
fi

while true; do
  one_pass || log "pass errored, continuing"
  log "sleeping ${INTERVAL}s"
  sleep "$INTERVAL"
done
