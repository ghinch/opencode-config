#!/bin/bash
# ── OpenCode + Agent Vault — start script ──
# Uses `container run` directly (bypasses container-compose bugs).
#
# Prerequisites:
#   1. container system start (Apple Container service running)
#   2. .env file with real values (cp .env.example .env && edit)
#   3. docker.io/infisical/agent-vault:0.20.1 image pulled
#   4. container network create internal (run once)
#
# Usage:
#   source .env
#   ./scripts/start.sh [service...]
#
#   ./scripts/start.sh              # start all
#   ./scripts/start.sh agent-vault  # start just agent-vault

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT="opencode-sandbox"
VOLUME_DIR="${HOME}/.containers/Volumes/${PROJECT}"
NETWORK="internal"

# ── helpers ──
log()  { echo "[start] $*" >&2; }
die()  { log "FATAL: $*"; exit 1; }

# ── check prerequisites ──
command -v container >/dev/null 2>&1 || die "container CLI not found — install Apple Container"
[ -n "${AGENT_VAULT_MASTER_PASSWORD:-}" ] || die "AGENT_VAULT_MASTER_PASSWORD is not set (source .env)"
[ -n "${AGENT_VAULT_EMAIL:-}" ] || die "AGENT_VAULT_EMAIL is not set (source .env)"
[ -n "${AGENT_VAULT_PASSWORD:-}" ] || die "AGENT_VAULT_PASSWORD is not set (source .env)"

# ── ensure network exists ──
if ! container network ls 2>/dev/null | grep -q "^${NETWORK}$"; then
  log "creating network: ${NETWORK}..."
  container network create "${NETWORK}" || die "failed to create network"
fi

# ── ensure volume directories exist ──
mkdir -p "${VOLUME_DIR}/agent-vault-data"
mkdir -p "${VOLUME_DIR}/opencode-home"
mkdir -p "${HOME}/.config/opencode/agent-token"

# ── determine which services to start ──
SERVICES="${@:-agent-vault token-refresher opencode}"

for SERVICE in ${SERVICES}; do
  case "${SERVICE}" in
    agent-vault)
      CONTAINER="${PROJECT}-agent-vault"
      # Remove existing if stopped
      if container ls -a 2>/dev/null | grep -q "^${CONTAINER}"; then
        STATE=$(container ls -a 2>/dev/null | grep "^${CONTAINER}" | awk '{print $5}')
        if [ "${STATE}" = "stopped" ]; then
          log "removing stopped container: ${CONTAINER}"
          container rm "${CONTAINER}" 2>/dev/null || true
        else
          log "agent-vault already running"
          continue
        fi
      fi
      log "starting agent-vault..."
      container run -d \
        --name "${CONTAINER}" \
        --network "${NETWORK}" \
        -v "${VOLUME_DIR}/agent-vault-data:/data" \
        -e AGENT_VAULT_MASTER_PASSWORD="${AGENT_VAULT_MASTER_PASSWORD}" \
        -e AGENT_VAULT_DATA_DIR=/data \
        -p 14321:14321 \
        -p 14322:14322 \
        docker.io/infisical/agent-vault:0.20.1
      ;;

    token-refresher)
      CONTAINER="${PROJECT}-token-refresher"
      if container ls -a 2>/dev/null | grep -q "^${CONTAINER}"; then
        STATE=$(container ls -a 2>/dev/null | grep "^${CONTAINER}" | awk '{print $5}')
        if [ "${STATE}" = "stopped" ]; then
          container rm "${CONTAINER}" 2>/dev/null || true
        else
          log "token-refresher already running"
          continue
        fi
      fi
      log "starting token-refresher..."
      container run -d \
        --name "${CONTAINER}" \
        --network "${NETWORK}" \
        --user root \
        -v "${PROJECT_DIR}/scripts/refresh-oauth-tokens.sh:/scripts/refresh-oauth-tokens.sh:ro" \
        -e AGENT_VAULT_ADDR="http://agent-vault:14321" \
        -e AGENT_VAULT_VAULT="${AGENT_VAULT_VAULT:-default}" \
        -e AGENT_VAULT_EMAIL="${AGENT_VAULT_EMAIL}" \
        -e AGENT_VAULT_PASSWORD="${AGENT_VAULT_PASSWORD}" \
        --entrypoint /bin/sh \
        docker.io/infisical/agent-vault:0.20.1 \
        -c '
          apk add --no-cache jq curl >&2
          echo "${AGENT_VAULT_PASSWORD}" | agent-vault auth login \
            --address "${AGENT_VAULT_ADDR}" \
            --email "${AGENT_VAULT_EMAIL}" \
            --password-stdin || { echo "[refresher] FATAL: login failed" >&2; exit 1; }
          echo "[refresher] starting OAuth token refresh loop..."
          while true; do
            /scripts/refresh-oauth-tokens.sh || echo "[refresher] errors — will retry" >&2
            sleep 900
          done
        '
      ;;

    opencode)
      CONTAINER="${PROJECT}-opencode"
      if container ls -a 2>/dev/null | grep -q "^${CONTAINER}"; then
        STATE=$(container ls -a 2>/dev/null | grep "^${CONTAINER}" | awk '{print $5}')
        if [ "${STATE}" = "stopped" ]; then
          container rm "${CONTAINER}" 2>/dev/null || true
        else
          log "opencode already running"
          continue
        fi
      fi
      log "starting opencode server..."
      container run -d \
        --name "${CONTAINER}" \
        --network "${NETWORK}" \
        -v "${PROJECT_DIR}:/workspace" \
        -v "${HOME}/.config/opencode:/home/opencode/.config/opencode:ro" \
        -v "${VOLUME_DIR}/opencode-home:/home/opencode" \
        -v "${HOME}/.config/opencode/agent-token:/token:ro" \
        -e AGENT_VAULT_ADDR="http://agent-vault:14321" \
        -e AGENT_VAULT_TOKEN_FILE="/token/agent-token" \
        -e AGENT_VAULT_VAULT="${AGENT_VAULT_VAULT:-default}" \
        -e OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-}" \
        -e GEMINI_API_KEY="__gemini_api_key__" \
        -e OPENAI_API_KEY="__openai_api_key__" \
        -e GITHUB_TOKEN="__github_token__" \
        -e ANTHROPIC_API_KEY="__anthropic_api_key__" \
        -p 127.0.0.1:4096:4096 \
        opencode-sandbox:latest \
        /usr/local/bin/opencode-entrypoint.sh
      ;;

    *)
      die "unknown service: ${SERVICE} (valid: agent-vault, token-refresher, opencode)"
      ;;
  esac
done

log ""
log "All services started. Check status:"
log "  container ls"
log ""
log "Attach: opencode attach http://localhost:4096 --password <OPENCODE_SERVER_PASSWORD>"
