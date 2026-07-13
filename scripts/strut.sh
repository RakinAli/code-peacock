#!/usr/bin/env bash
# Peacock strut — announces a pipeline run.
# In a real terminal: an in-place animated bounce across the screen.
# When output is piped (e.g. captured by an agent): a short cascading strut,
# because cursor-movement codes would garble captured output.
set -euo pipefail

BIRD=(
'    @ . @    '
'  @ \ | / @  '
'   \ \|/ /   '
'    ,(o)>    '
'    // \\    '
'   ^^   ^^   '
)
BIRD_WIDTH=13
BIRD_HEIGHT=${#BIRD[@]}

use_color() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }

# Peacock plumage: cyan, green, blue, magenta — shifted every frame for shimmer.
FAN_COLORS=(36 32 34 35)
BODY_COLOR='1;36'

print_bird() { # $1 = left offset, $2 = color phase
  local offset=$1 phase=$2 pad line i color
  pad=$(printf '%*s' "$offset" '')
  for i in "${!BIRD[@]}"; do
    line="${BIRD[$i]}"
    if use_color; then
      if [ "$i" -lt 3 ]; then
        color="${FAN_COLORS[$(((i + phase) % 4))]}"
      else
        color="$BODY_COLOR"
      fi
      printf '%s\033[%sm%s\033[0m\n' "$pad" "$color" "$line"
    else
      printf '%s%s\n' "$pad" "$line"
    fi
  done
}

strut_tty() {
  local cols frames travel offset bob f
  cols=$(tput cols 2>/dev/null || echo 80)
  travel=$((cols - BIRD_WIDTH - 2))
  [ "$travel" -lt 10 ] && travel=10
  frames=28
  tput civis 2>/dev/null || true
  trap 'tput cnorm 2>/dev/null || true' EXIT
  for ((f = 0; f < frames; f++)); do
    # Triangle wave: strut right, then strut back.
    offset=$((f * 2 * travel / frames))
    [ "$offset" -gt "$travel" ] && offset=$((2 * travel - offset))
    bob=$((f % 2))
    [ "$bob" -eq 1 ] && echo
    print_bird "$offset" "$f"
    [ "$bob" -eq 0 ] && echo
    sleep 0.09
    printf '\033[%dA' $((BIRD_HEIGHT + 1))
  done
  printf '\033[%dB' $((BIRD_HEIGHT + 1))
}

strut_piped() {
  local offsets=(1 9 17 25 17 9 1) f
  for f in "${!offsets[@]}"; do
    print_bird "${offsets[$f]}" "$f"
    echo
    sleep 0.12
  done
}

if [ -t 1 ]; then strut_tty; else strut_piped; fi

if use_color; then
  printf '\033[1;36m  P E A C O C K\033[0m  \033[2m— strutting your code. Go touch grass.\033[0m\n'
else
  printf '  P E A C O C K  — strutting your code. Go touch grass.\n'
fi
