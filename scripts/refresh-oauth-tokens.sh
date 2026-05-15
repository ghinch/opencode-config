#!/bin/sh
# ------------------------------------------------------------------
# refresh-oauth-tokens.sh
#
# Periodically refreshes OAuth access tokens and pushes them to
# agent-vault. Handles the token lifecycle so the opencode server
# never needs direct access to auth.json.
#
# Architecture:
#   refresh token (stored in agent-vault, updated rarely)
#        │
#        ▼
#   this script (runs on cron)
#        │
#        ├── reads refresh token from agent-vault
#        ├── calls OAuth provider's token endpoint
#        ├── extracts new access token
#        └── pushes new access token to agent-vault
#             │
#             ▼
#   agent-vault injects access token into opencode's outbound requests
#
# Configuration (env vars):
#   AGENT_VAULT_ADDR              agent-vault server URL
#   AGENT_VAULT_VAULT             vault name
#   OAUTH_PROVIDERS               JSON array of provider configs (see below)
#
# NOTE: This script assumes the agent-vault CLI is already authenticated
# (via `agent-vault auth login`). The CLI session at ~/.agent-vault/
# must be valid and have member+ access to the vault.
#
# Each provider in OAUTH_PROVIDERS:
#   {
#     "name": "openai",                  // label for logging
#     "refresh_key": "OPENAI_REFRESH",   // agent-vault credential holding refresh token
#     "access_key": "OPENAI_ACCESS",     // agent-vault credential to update with new access token
#     "endpoint": "https://oauth2.googleapis.com/token",  // OAuth token endpoint
#     "client_id": "",                   // optional OAuth client ID
#     "extra_params": ""                 // optional extra POST params (e.g., "scope=...")
#   }
#
# Default providers are configured for OpenAI and GitHub Copilot OAuth.
# ------------------------------------------------------------------
set -e

ADDR="${AGENT_VAULT_ADDR:-http://agent-vault:14321}"
VAULT="${AGENT_VAULT_VAULT:-default}"

log()  { echo "[refresher] $(date -Iseconds) $*" >&2; }
warn() { echo "[refresher] $(date -Iseconds) WARN: $*" >&2; }
die()  { log "FATAL: $*"; exit 1; }

# -- default provider configs (correct endpoints from opencode source) --
#
# OpenAI Codex OAuth:
#   Endpoint: https://auth.openai.com/oauth/token
#   Client ID: app_EMoamEEZ73f0CkXaXp7hrann
#   Source: opencode/packages/opencode/src/plugin/codex.ts
#
# GitHub Copilot:
#   Tokens never expire (expires: 0) — treated as static keys.
#   No refresh needed. The bootstrap pushes the access token directly.
#   Source: opencode/packages/opencode/src/plugin/github-copilot/copilot.ts
DEFAULT_PROVIDERS='[
  {
    "name": "openai",
    "refresh_key": "OPENAI_REFRESH_TOKEN",
    "access_key": "OPENAI_ACCESS_TOKEN",
    "endpoint": "https://auth.openai.com/oauth/token",
    "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
    "extra_params": ""
  }
]'

PROVIDERS="${OAUTH_PROVIDERS:-$DEFAULT_PROVIDERS}"
PROVIDER_COUNT=$(echo "$PROVIDERS" | jq 'length')
if [ "$PROVIDER_COUNT" -eq 0 ]; then
  log "no OAuth providers configured, exiting"
  exit 0
fi

log "refreshing tokens for $PROVIDER_COUNT OAuth provider(s)..."

# -- refresh each provider --
for i in $(seq 0 $((PROVIDER_COUNT - 1))); do
  NAME=$(echo "$PROVIDERS" | jq -r ".[$i].name")
  REFRESH_KEY=$(echo "$PROVIDERS" | jq -r ".[$i].refresh_key")
  ACCESS_KEY=$(echo "$PROVIDERS" | jq -r ".[$i].access_key")
  ENDPOINT=$(echo "$PROVIDERS" | jq -r ".[$i].endpoint")
  CLIENT_ID=$(echo "$PROVIDERS" | jq -r ".[$i].client_id // empty")
  EXTRA_PARAMS=$(echo "$PROVIDERS" | jq -r ".[$i].extra_params // empty")

  log "--- $NAME ---"

  # -- read refresh token from agent-vault --
  REFRESH_TOKEN=$(agent-vault vault credential get "$REFRESH_KEY" \
    --vault "$VAULT" --address "$ADDR" 2>/dev/null) || {
    warn "  could not read refresh token for $NAME (credential key: $REFRESH_KEY) — skipping"
    continue
  }

  if [ -z "$REFRESH_TOKEN" ]; then
    warn "  refresh token for $NAME is empty — skipping"
    continue
  fi

  # -- build request body --
  BODY="grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}"
  if [ -n "$CLIENT_ID" ]; then
    BODY="${BODY}&client_id=${CLIENT_ID}"
  fi
  if [ -n "$EXTRA_PARAMS" ]; then
    BODY="${BODY}&${EXTRA_PARAMS}"
  fi

  # -- call OAuth endpoint --
  log "  calling $ENDPOINT..."
  RESPONSE=$(curl -sS -X POST "$ENDPOINT" \
    -H "Accept: application/json" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "$BODY" 2>&1) || {
    warn "  curl failed for $NAME: $RESPONSE"
    continue
  }

  # -- extract access token --
  # Try standard OAuth2 fields first
  NEW_TOKEN=$(echo "$RESPONSE" | jq -r '.access_token // empty' 2>/dev/null)

  if [ -z "$NEW_TOKEN" ] || [ "$NEW_TOKEN" = "null" ]; then
    # If no access_token, check for error
    ERROR_MSG=$(echo "$RESPONSE" | jq -r '.error_description // .error // empty' 2>/dev/null)
    if [ -n "$ERROR_MSG" ]; then
      warn "  token refresh failed for $NAME: $ERROR_MSG"
    else
      warn "  unexpected response for $NAME (no access_token in response)"
    fi
    continue
  fi

  # -- extract expiry (for logging) --
  EXPIRES_IN=$(echo "$RESPONSE" | jq -r '.expires_in // 0' 2>/dev/null)
  if [ "$EXPIRES_IN" != "0" ] && [ "$EXPIRES_IN" != "null" ]; then
    log "  got new access token (expires in ${EXPIRES_IN}s)"
  else
    log "  got new access token"
  fi

  # -- also check if a new refresh token was issued --
  NEW_REFRESH=$(echo "$RESPONSE" | jq -r '.refresh_token // empty' 2>/dev/null)
  if [ -n "$NEW_REFRESH" ] && [ "$NEW_REFRESH" != "null" ]; then
    log "  rotating refresh token..."
    agent-vault vault credential set "${REFRESH_KEY}=${NEW_REFRESH}" \
      --vault "$VAULT" --address "$ADDR" || warn "  failed to update refresh token"
  fi

  # -- push new access token to agent-vault --
  log "  pushing new access token to agent-vault..."
  agent-vault vault credential set "${ACCESS_KEY}=${NEW_TOKEN}" \
    --vault "$VAULT" --address "$ADDR" || {
    warn "  failed to update access token for $NAME"
    continue
  }

  log "  ✅ $NAME token refreshed successfully"
done

log "refresh cycle complete"
