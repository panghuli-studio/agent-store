#!/usr/bin/env bash
# Times key pages and API endpoints of a deployed environment against a budget (#216).
#
#   scripts/latency-budget.sh https://agent-store.tail1eafd1.ts.net
#
# Each path is fetched RUNS times (default 3) like a browser would (compressed). The
# median time to first byte and the median total are compared with the budget; with
# ENFORCE=0 the table is printed and the exit status is always 0. The API's own time
# comes from its Server-Timing header, so a slow row shows whether the network or the
# API spent it.
set -euo pipefail

base=${1:?usage: latency-budget.sh <base-url>}
runs=${RUNS:-3}
enforce=${ENFORCE:-1}

# path, then the budget in seconds for the median first byte and the median total.
budgets=(
  '/api/auth/ok 0.40 0.40'
  '/api/search/supplement?q= 0.40 0.40'
  '/ 0.60 1.20'
  '/store 0.60 1.20'
  '/pricing 0.60 1.20'
  '/docs 0.60 1.20'
)

median() { tr ' ' '\n' | grep -v '^$' | sort -g | awk '{v[NR]=$1} END {printf "%.3f", v[int((NR+1)/2)]}'; }

headers=$(mktemp)
trap 'rm -f "$headers"' EXIT

rows=()
failed=0
for entry in "${budgets[@]}"; do
  read -r path ttfb_budget total_budget <<<"$entry"
  ttfbs='' totals='' apps='' codes=''
  for _ in $(seq "$runs"); do
    out=$(curl -s -o /dev/null -D "$headers" --compressed --max-time 30 \
      -w '%{http_code} %{time_starttransfer} %{time_total}' "$base$path") || out='000 30 30'
    read -r code ttfb total <<<"$out"
    ttfb=$(printf '%.3f' "$ttfb") total=$(printf '%.3f' "$total")
    app=$(tr -d '\r' <"$headers" | awk -F'dur=' 'tolower($0) ~ /^server-timing:/ {split($2, a, /[;,]/); printf "%.3f", a[1] / 1000}')
    ttfbs+=" $ttfb" totals+=" $total" codes+=" $code" apps+=" ${app:--}"
  done
  ttfb_m=$(median <<<"$ttfbs")
  total_m=$(median <<<"$totals")
  verdict=ok
  if awk -v t="$ttfb_m" -v tb="$ttfb_budget" -v o="$total_m" -v ob="$total_budget" 'BEGIN {exit !(t > tb || o > ob)}'; then
    verdict=over
    failed=1
  fi
  for code in $codes; do
    if [ "$code" != 200 ]; then verdict="$verdict, status$codes"; failed=1; break; fi
  done
  rows+=("| \`$path\` | $ttfb_m / $ttfb_budget | $total_m / $total_budget |$ttfbs |$totals |$apps | $verdict |")
done

{
  echo "Budget for $base, median of $runs runs, seconds"
  echo
  echo '| path | first byte / budget | total / budget | first byte per run | total per run | API Server-Timing | result |'
  echo '|---|---|---|---|---|---|---|'
  printf '%s\n' "${rows[@]}"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$failed" = 1 ] && [ "$enforce" = 1 ]; then
  echo "over budget" >&2
  exit 1
fi
