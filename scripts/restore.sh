#!/usr/bin/env bash
# =============================================================================
# scripts/restore.sh - Restaura un backup cifrado a la base de datos productiva.
#
# Uso:
#   ./scripts/restore.sh /ruta/al/postgres-storageos-YYYYMMDD-HHMMSS.dump.gpg
#
#   # o descargando desde B2 primero:
#   aws --endpoint-url "$B2_ENDPOINT" s3 cp \
#     "s3://$B2_BUCKET/postgres/postgres-storageos-XXX.dump.gpg" /tmp/
#   ./scripts/restore.sh /tmp/postgres-storageos-XXX.dump.gpg
#
# Pide confirmación interactiva antes de tocar la BD. En CI/cron usa FORCE=1.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.prod}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

: "${POSTGRES_USER:?Falta POSTGRES_USER}"
: "${POSTGRES_PASSWORD:?Falta POSTGRES_PASSWORD}"
: "${POSTGRES_DB:?Falta POSTGRES_DB}"
: "${BACKUP_GPG_PASSPHRASE:?Falta BACKUP_GPG_PASSPHRASE}"

COMPOSE_FILE="${COMPOSE_FILE:-${REPO_ROOT}/docker-compose.prod.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"

if [[ $# -ne 1 ]]; then
  echo "Uso: $0 <ruta-al-backup.dump.gpg>" >&2
  exit 1
fi

ENC_FILE="$1"
[[ -f "${ENC_FILE}" ]] || { echo "ERROR: no existe ${ENC_FILE}" >&2; exit 1; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# -----------------------------------------------------------------------------
# Confirmación destructiva.
# -----------------------------------------------------------------------------
if [[ "${FORCE:-0}" != "1" ]]; then
  cat <<EOF
ATENCION: vas a RESTAURAR la base de datos productiva.

  Archivo : ${ENC_FILE}
  Destino : ${POSTGRES_DB}@${PG_SERVICE} (compose: ${COMPOSE_FILE})

Esto puede SOBREESCRIBIR datos existentes. Para continuar, escribe el nombre
de la base de datos exacto:
EOF
  read -r CONFIRM
  [[ "${CONFIRM}" == "${POSTGRES_DB}" ]] || { echo "Abortado." >&2; exit 1; }
fi

# -----------------------------------------------------------------------------
# 1. Descifrar a un archivo temporal.
# -----------------------------------------------------------------------------
TMP_DUMP="$(mktemp --suffix=.dump)"
trap 'rm -f "${TMP_DUMP}"' EXIT

log "[1/2] gpg --decrypt..."
gpg --batch --yes --quiet \
  --passphrase "${BACKUP_GPG_PASSPHRASE}" \
  --decrypt --output "${TMP_DUMP}" \
  "${ENC_FILE}"

log "descifrado OK ($(du -h "${TMP_DUMP}" | cut -f1))"

# -----------------------------------------------------------------------------
# 2. pg_restore. Usamos --clean --if-exists para resetear objetos.
#    El dump fue creado con --no-owner --no-privileges, así que el rol
#    receptor (POSTGRES_USER) será el dueño de todo.
# -----------------------------------------------------------------------------
log "[2/2] pg_restore..."
docker compose -f "${COMPOSE_FILE}" exec -T \
  -e PGPASSWORD="${POSTGRES_PASSWORD}" \
  "${PG_SERVICE}" \
  pg_restore \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}" \
    --clean --if-exists \
    --no-owner --no-privileges \
    --exit-on-error \
    --verbose \
  < "${TMP_DUMP}"

log "Restauración completada."
log "Recuerda revisar permisos del rol app y reiniciar el API:"
log "  docker compose -f ${COMPOSE_FILE} restart api"
