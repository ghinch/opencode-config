#!/bin/sh
# -- OpenCode server entrypoint --
# 1. Reads AGENT_VAULT_TOKEN from the shared volume
#    (populated by the bootstrap container) or falls back to env var.
# 2. Launches `opencode serve` wrapped by agent-vault so all outbound
#    LLM API calls are proxied through agent-vault for credential injection.
#
# The opencode server listens on 0.0.0.0:4096 (configurable via env vars).
# Connect from your host with:
#   opencode attach http://localhost:4096

set -e

SERVER_PORT="${OPENCODE_SERVER_PORT:-4096}"
SERVER_HOST="${OPENCODE_SERVER_HOST:-0.0.0.0}"

# -- Load agent token --
if [ -n "${AGENT_VAULT_TOKEN_FILE:-}" ] && [ -f "$AGENT_VAULT_TOKEN_FILE" ]; then
  export AGENT_VAULT_TOKEN=$(cat "$AGENT_VAULT_TOKEN_FILE")
  echo "[opencode] loaded agent token from $AGENT_VAULT_TOKEN_FILE"
elif [ -n "${AGENT_VAULT_TOKEN:-}" ]; then
  echo "[opencode] using AGENT_VAULT_TOKEN from environment"
else
  echo "[opencode] WARNING: no AGENT_VAULT_TOKEN set — run the bootstrap container first:"
  echo "  container run --rm \\"
  echo "    --volume ~/.local/share/opencode/auth.json:/tmp/auth.json:ro \\"
  echo "    --volume ~/.config/opencode/agent-token:/token \\"
  echo "    --network opencode-sandbox_internal \\"
  echo "    -e AGENT_VAULT_ADDR=http://agent-vault:14321 \\"
  echo "    -e AGENT_VAULT_EMAIL=<email> \\"
  echo "    -e AGENT_VAULT_PASSWORD=<password> \\"
  echo "    agent-vault-bootstrap:latest"
fi

echo "[opencode] starting server on ${SERVER_HOST}:${SERVER_PORT}..."
echo "[opencode] connect from your host: opencode attach http://localhost:${SERVER_PORT}"

# agent-vault sets up HTTPS_PROXY, HTTP_PROXY, SSL_CERT_FILE etc.
# then execs `opencode serve` which runs the headless HTTP server.
exec agent-vault run -- opencode serve \
  --hostname "$SERVER_HOST" \
  --port "$SERVER_PORT"
