#!/bin/sh
# ------------------------------------------------------------------
# bootstrap-agent-vault.sh
#
# One-shot bootstrap: reads opencode's auth.json and configures
# agent-vault with credentials + service rules.
#
# Required env vars:
#   AGENT_VAULT_ADDR       server URL (used automatically by CLI)
#   AGENT_VAULT_EMAIL      admin email (register/login)
#   AGENT_VAULT_PASSWORD   admin password (register/login)
#   AGENT_VAULT_VAULT      vault name (default: default)
#   AGENT_VAULT_TOKEN_FILE path to write the agent token (default: /token/agent-token)
# ------------------------------------------------------------------
set -e

ADDR="${AGENT_VAULT_ADDR:-http://agent-vault:14321}"
EMAIL="${AGENT_VAULT_EMAIL:?AGENT_VAULT_EMAIL is required}"
PASSWORD="${AGENT_VAULT_PASSWORD:?AGENT_VAULT_PASSWORD is required}"
VAULT="${AGENT_VAULT_VAULT:-default}"
AUTH_FILE="/tmp/auth.json"
TOKEN_FILE="${AGENT_VAULT_TOKEN_FILE:-/token/agent-token}"
SERVICES_YAML="/tmp/services.yaml"

# -- helpers --
log() { echo "[bootstrap] $*" >&2; }
die()  { log "FATAL: $*"; exit 1; }

# Track which providers exist
HAS_GOOGLE=false; HAS_OPENAI=false; HAS_GITHUB=false; HAS_OPENCODE=false

# -- install jq if missing --
if ! command -v jq >/dev/null 2>&1; then
  log "installing jq..."
  apk add --no-cache jq >&2
fi

# -- check auth.json --
[ -f "$AUTH_FILE" ] || die "auth.json not found at $AUTH_FILE"

# ==================================================================
# Auth: register + login
# ==================================================================
log "authenticating to agent-vault at $ADDR..."

# Register (first user becomes owner; fails gracefully if already exists)
echo "$PASSWORD" | agent-vault auth register \
  --address "$ADDR" \
  --email "$EMAIL" \
  --password-stdin 2>/dev/null || true

# Login (--address is valid for auth login)
echo "$PASSWORD" | agent-vault auth login \
  --address "$ADDR" \
  --email "$EMAIL" \
  --password-stdin || die "Failed to log into agent-vault"

# ==================================================================
# Vault: ensure it exists
# ==================================================================
if ! agent-vault vault list 2>/dev/null | grep -q "^$VAULT$"; then
  log "creating vault '$VAULT'..."
  agent-vault vault create "$VAULT" || true
fi

# ==================================================================
# Phase 1: Static API keys (push to agent-vault)
# ==================================================================
log "--- Static credentials ---"

push_static() {
  local cred_key="$1" cred_val="$2" label="$3"
  log "  $label → $cred_key"
  agent-vault vault credential set "${cred_key}=${cred_val}" --vault "$VAULT"
}

# Google Gemini — API key
GOOGLE_KEY=$(jq -r '.google.key // empty' "$AUTH_FILE")
if [ -n "$GOOGLE_KEY" ] && [ "$GOOGLE_KEY" != "null" ]; then
  push_static "GEMINI_API_KEY" "$GOOGLE_KEY" "google"
  HAS_GOOGLE=true
fi

# OpenCode SaaS — API key
OC_KEY=$(jq -r '."opencode-go".key // empty' "$AUTH_FILE")
if [ -n "$OC_KEY" ] && [ "$OC_KEY" != "null" ]; then
  push_static "OPENCODE_API_KEY" "$OC_KEY" "opencode-go"
  HAS_OPENCODE=true
fi

# GitHub Copilot — static (tokens never expire, expires: 0)
GH_ACCESS=$(jq -r '."github-copilot".access // empty' "$AUTH_FILE")
if [ -n "$GH_ACCESS" ] && [ "$GH_ACCESS" != "null" ]; then
  push_static "GITHUB_TOKEN" "$GH_ACCESS" "github-copilot"
  HAS_GITHUB=true
fi

# ==================================================================
# Phase 2: OAuth tokens (OpenAI — requires periodic refresh)
# ==================================================================
log "--- OAuth tokens ---"

OA_REFRESH=$(jq -r '.openai.refresh // empty' "$AUTH_FILE")
OA_ACCESS=$(jq -r '.openai.access // empty' "$AUTH_FILE")
if [ -n "$OA_REFRESH" ] && [ "$OA_REFRESH" != "null" ]; then
  push_static "OPENAI_REFRESH_TOKEN" "$OA_REFRESH" "openai (refresh)"
  if [ -n "$OA_ACCESS" ] && [ "$OA_ACCESS" != "null" ]; then
    push_static "OPENAI_ACCESS_TOKEN" "$OA_ACCESS" "openai (access)"
  fi
  HAS_OPENAI=true
fi

# ==================================================================
# Phase 3: Service rules
# ==================================================================
log "writing service rules..."
cat > "$SERVICES_YAML" << 'YAMLEOF'
services:
YAMLEOF

if $HAS_GOOGLE; then
  cat >> "$SERVICES_YAML" << 'YAMLEOF'
  - name: google-gemini
    host: generativelanguage.googleapis.com
    auth:
      type: api-key
      key: GEMINI_API_KEY
      header: x-goog-api-key
YAMLEOF
fi

if $HAS_OPENCODE; then
  cat >> "$SERVICES_YAML" << 'YAMLEOF'
  - name: opencode
    host: api.opencode.ai
    auth:
      type: bearer
      token: OPENCODE_API_KEY
YAMLEOF
fi

if $HAS_OPENAI; then
  cat >> "$SERVICES_YAML" << 'YAMLEOF'
  - name: openai
    host: api.openai.com
    auth:
      type: bearer
      token: OPENAI_ACCESS_TOKEN
YAMLEOF
fi

if $HAS_GITHUB; then
  cat >> "$SERVICES_YAML" << 'YAMLEOF'
  - name: github
    host: "*.github.com"
    auth:
      type: bearer
      token: GITHUB_TOKEN
YAMLEOF
fi

log "applying service rules..."
agent-vault vault service set -f "$SERVICES_YAML" --vault "$VAULT"

# ==================================================================
# Phase 4: Mint agent token
# ==================================================================
log "minting agent token..."
AGENT_TOKEN=$(agent-vault vault token --vault "$VAULT" --address "$ADDR")
echo "$AGENT_TOKEN" > "$TOKEN_FILE"

log ""
log "=============================================="
log "  Bootstrap complete!"
log "=============================================="
log ""
log "  Agent token:    $AGENT_TOKEN"
log "  Vault:          $VAULT"
log ""
log "  Credentials:"
$HAS_GOOGLE  && log "    google         → agent-vault injects (static api key)"
$HAS_OPENCODE && log "    opencode-go    → agent-vault injects (static api key)"
$HAS_GITHUB  && log "    github-copilot → agent-vault injects (static — tokens never expire)"
$HAS_OPENAI  && log "    openai         → agent-vault injects (OAuth — refreshed every 15 min)"
log ""
log "  Next: container-compose up -d && opencode attach http://localhost:4096 --password <OPENCODE_SERVER_PASSWORD>"
