#!/usr/bin/env bash
# Peacock strut — a zero-dependency terminal mascot for pipeline startup.
set -euo pipefail

readonly BIRD_WIDTH=25
readonly FRAME_DELAY_SECONDS='0.08'
readonly FRAME_COUNT=24
readonly -a FAN_COLORS=(36 32 34 35 36 32 34)
readonly -a BIRD=(
'       .  .  .       '
'    .  [v][v]  .    '
'  [v][v][v][v][v]  '
'      \\  |  /      '
'       ,(o)>         '
'      / /\\         '
'     _/  \\_        '
)
readonly BIRD_HEIGHT=${#BIRD[@]}

can_animate() {
  [ -t 1 ] &&
    [ "${TERM:-dumb}" != 'dumb' ] &&
    [ -z "${CI:-}" ] &&
    [ "${PEACOCK_ANIMATION:-1}" != '0' ]
}

can_color() {
  [ -t 1 ] && [ "${TERM:-dumb}" != 'dumb' ] && [ -z "${NO_COLOR:-}" ]
}

print_line() {
  local padding=$1 color=$2 line=$3
  if can_color; then
    printf '%s\033[%sm%s\033[0m\n' "$padding" "$color" "$line"
    return
  fi
  printf '%s%s\n' "$padding" "$line"
}

print_bird() {
  local offset=$1 color_phase=$2 padding line_index color
  padding=$(printf '%*s' "$offset" '')
  for line_index in "${!BIRD[@]}"; do
    color='1;36'
    if [ "$line_index" -lt 3 ]; then
      color="${FAN_COLORS[$(((line_index + color_phase) % ${#FAN_COLORS[@]}))]}"
    fi
    print_line "$padding" "$color" "${BIRD[$line_index]}"
  done
}

restore_cursor() {
  tput cnorm 2>/dev/null || true
}

strut() {
  local columns travel frame offset bob
  columns=$(tput cols 2>/dev/null || printf '80')
  travel=$((columns - BIRD_WIDTH - 2))
  [ "$travel" -lt 8 ] && travel=8

  tput civis 2>/dev/null || true
  trap restore_cursor EXIT INT TERM
  for ((frame = 0; frame < FRAME_COUNT; frame++)); do
    offset=$((frame * 2 * travel / FRAME_COUNT))
    [ "$offset" -gt "$travel" ] && offset=$((2 * travel - offset))
    bob=$((frame % 2))
    [ "$bob" -eq 1 ] && printf '\n'
    print_bird "$offset" "$frame"
    [ "$bob" -eq 0 ] && printf '\n'
    sleep "$FRAME_DELAY_SECONDS"
    printf '\033[%dA' $((BIRD_HEIGHT + 1))
  done
  printf '\033[%dB' $((BIRD_HEIGHT + 1))
  restore_cursor
  trap - EXIT INT TERM
}

print_wordmark() {
  if can_color; then
    printf '\033[1;36m  P E A C O C K\033[0m  \033[2m— evidence, not vibes.\033[0m\n'
    return
  fi
  printf '  P E A C O C K  — evidence, not vibes.\n'
}

if can_animate; then
  strut
else
  print_bird 0 0
fi
print_wordmark
