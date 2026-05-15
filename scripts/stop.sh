#!/bin/bash
# ── OpenCode + Agent Vault — stop script ──
# Stops and removes all opencode-sandbox containers.
set -euo pipefail

PROJECT="opencode-sandbox"
CONTAINERS=$(container ls -a 2>/dev/null | grep "^${PROJECT}-" | awk '{print $1}' || true)

if [ -z "${CONTAINERS}" ]; then
  echo "No opencode-sandbox containers found."
  exit 0
fi

for c in ${CONTAINERS}; do
  echo "Stopping and removing: ${c}"
  container stop "${c}" 2>/dev/null || true
  container rm "${c}" 2>/dev/null || true
done

echo "Done."
