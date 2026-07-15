#!/usr/bin/env bash
# Peacock merge kill-switch — reusable PATH shims that make merging impossible.
#
# SOURCE this file, then call peacock_install_killswitch. It writes a `gh` shim
# and a `git` shim into a directory and prepends that directory to PATH, so any
# tool the pipeline invokes (agent, script, subshell) hits the shims first.
#
#   source scripts/merge-killswitch.sh
#   peacock_install_killswitch [SHIM_DIR]
#
# The shims refuse every mechanical PR-merge / protected-branch-write vector and
# forward everything else to the real binary:
#   gh   — blocks `gh pr merge`, `gh api ... pulls/<n>/merge`, `gh api ... mergePullRequest`.
#   git  — blocks `git push` whose destination refspec targets a protected branch.
#
# Environment overrides:
#   PEACOCK_REAL_GH / PEACOCK_REAL_GIT     real binaries to forward to (default: command -v).
#   PEACOCK_PROTECTED_BRANCHES             space-separated protected branch names
#                                          (default: main master prod production release).
#                                          Read by the git shim at run time.

peacock_install_killswitch() {
  local shim_dir="${1:-}"
  if [[ -z "$shim_dir" ]]; then
    shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/peacock-shim.XXXXXX")"
  fi
  mkdir -p "$shim_dir"

  local real_gh real_git
  real_gh="${PEACOCK_REAL_GH:-$(command -v gh)}"
  real_git="${PEACOCK_REAL_GIT:-$(command -v git)}"
  [[ -n "$real_gh" ]] || { echo "peacock kill-switch: no gh binary found (set PEACOCK_REAL_GH)" >&2; return 1; }
  [[ -n "$real_git" ]] || { echo "peacock kill-switch: no git binary found (set PEACOCK_REAL_GIT)" >&2; return 1; }

  # The heredocs are UNQUOTED so the real-binary path is baked in at write time;
  # the shims' own positional params ($1/$@/$arg) are escaped to stay literal.
  cat > "$shim_dir/gh" <<SHIM
#!/usr/bin/env bash
# Peacock merge kill-switch: refuse every gh merge vector, forward the rest.
if [[ "\$1" == "pr" && "\$2" == "merge" ]]; then
  echo "peacock: 'gh pr merge' is blocked — peacock never merges." >&2
  exit 1
fi
if [[ "\$1" == "api" ]]; then
  for arg in "\$@"; do
    if [[ "\$arg" == *mergePullRequest* ]]; then
      echo "peacock: 'gh api ... mergePullRequest' is blocked — peacock never merges." >&2
      exit 1
    fi
    if [[ "\$arg" =~ pulls/[0-9]+/merge ]]; then
      echo "peacock: 'gh api ... pulls/<n>/merge' is blocked — peacock never merges." >&2
      exit 1
    fi
  done
fi
exec "$real_gh" "\$@"
SHIM

  cat > "$shim_dir/git" <<SHIM
#!/usr/bin/env bash
# Peacock merge kill-switch: refuse pushes to a protected branch, forward the rest.
if [[ "\$1" == "push" ]]; then
  protected="\${PEACOCK_PROTECTED_BRANCHES:-main master prod production release}"
  for arg in "\$@"; do
    case "\$arg" in -*) continue ;; esac
    dest="\${arg##*:}"
    dest="\${dest#+}"
    dest="\${dest#refs/heads/}"
    for branch in \$protected; do
      if [[ "\$dest" == "\$branch" ]]; then
        echo "peacock: 'git push' to protected branch '\$branch' is blocked — peacock only pushes to a PR's head branch." >&2
        exit 1
      fi
    done
  done
fi
exec "$real_git" "\$@"
SHIM

  chmod +x "$shim_dir/gh" "$shim_dir/git"
  export PATH="$shim_dir:$PATH"
}
