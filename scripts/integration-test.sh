#!/usr/bin/env bash
set -euo pipefail

base_url="${BASE_URL:-http://localhost:3000}"

health="$(curl --fail --silent --show-error "${base_url}/health")"
test "$(jq -r '.status' <<<"${health}")" = "ok"

invalid_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -H 'content-type: application/json' \
  -d '{}' "${base_url}/shorten")"
test "${invalid_status}" = "400"

shortened="$(curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' "${base_url}/shorten")"
code="$(jq -er '.code | select(type == "string" and length > 0)' <<<"${shortened}")"

ttl="$(docker compose exec -T redis redis-cli TTL "short:${code}" | tr -d '\r')"
test "${ttl}" -gt 0
test "${ttl}" -le 3600

for _ in 1 2; do
  headers="$(curl --silent --show-error --dump-header - --output /dev/null "${base_url}/${code}")"
  grep -Eq '^HTTP/[0-9.]+ 302' <<<"${headers}"
  grep -Eiq '^location: https://example\.com/?\r?$' <<<"${headers}"
done

analytics=""
for _ in $(seq 1 30); do
  analytics="$(curl --fail --silent --show-error "${base_url}/analytics/${code}")"
  if test "$(jq -r '.clicks' <<<"${analytics}")" -eq 2; then
    break
  fi
  sleep 1
done
test "$(jq -r '.code' <<<"${analytics}")" = "${code}"
test "$(jq -r '.clicks' <<<"${analytics}")" -eq 2
jq -e '.last_clicked | type == "string" and test("^[0-9]{4}-")' >/dev/null <<<"${analytics}"

not_found_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "${base_url}/does-not-exist")"
test "${not_found_status}" = "404"

trace_response="$(curl --fail --silent --show-error "${base_url}/trace-test")"
jq -e '.status == "ok" and (.trace_id | test("^[0-9a-f]{32}$"))' \
  >/dev/null <<<"${trace_response}"
trace_id="$(jq -r '.trace_id' <<<"${trace_response}")"

trace_count=0
for _ in $(seq 1 30); do
  trace_count="$(curl --silent --show-error \
    "http://localhost:16686/api/traces/${trace_id}" \
    | jq '.data | length')"
  if test "${trace_count}" -gt 0; then
    break
  fi
  sleep 1
done
test "${trace_count}" -gt 0

echo "Integration test passed for short code ${code}."
