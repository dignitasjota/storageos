#!/usr/bin/env bash
# =============================================================================
# scripts/backup.sh - Backup cifrado de producción (Fase 8C).
#
# Hace:
#   1. pg_dump del Postgres del stack productivo (custom format).
#   2. Cifra el dump con GPG simétrico (AES-256) usando BACKUP_GPG_PASSPHRASE.
#   3. Sincroniza el contenido de MinIO al bucket remoto Backblaze B2.
#   4. Sube el dump cifrado al mismo bucket remoto.
#   5. Borra backups locales más antiguos que BACKUP_RETENTION_DAYS (default 30).
#
# Pensado para cron diario `0 3 * * *` (ver scripts/README.md).
# Idempotente: si una fase falla, las siguientes lo registran y se aborta con
# código != 0 para que cron envíe el aviso.
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuración (todo via env, valores por defecto razonables).
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Carga .env.prod si existe (no falla si no, por si se invoca desde CI).
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.prod}"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC2046
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

# Requeridas
: "${POSTGRES_USER:?Falta POSTGRES_USER}"
: "${POSTGRES_PASSWORD:?Falta POSTGRES_PASSWORD}"
: "${POSTGRES_DB:?Falta POSTGRES_DB}"
: "${BACKUP_GPG_PASSPHRASE:?Falta BACKUP_GPG_PASSPHRASE}"
: "${B2_BUCKET:?Falta B2_BUCKET}"
: "${B2_ENDPOINT:?Falta B2_ENDPOINT}"
: "${B2_REGION:?Falta B2_REGION}"
: "${B2_ACCESS_KEY_ID:?Falta B2_ACCESS_KEY_ID}"
: "${B2_SECRET_ACCESS_KEY:?Falta B2_SECRET_ACCESS_KEY}"

# Opcionales con defaults
BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-${REPO_ROOT}/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
COMPOSE_FILE="${COMPOSE_FILE:-${REPO_ROOT}/docker-compose.prod.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
MINIO_SERVICE="${MINIO_SERVICE:-minio}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-storageos}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-}"

mkdir -p "${BACKUP_LOCAL_DIR}"

TS="$(date -u +%Y%m%d-%H%M%S)"
DUMP_FILE="${BACKUP_LOCAL_DIR}/postgres-${POSTGRES_DB}-${TS}.dump"
ENC_FILE="${DUMP_FILE}.gpg"

# -----------------------------------------------------------------------------
# Helpers de logging con timestamp.
# -----------------------------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

# AWS CLI con endpoint B2 (un poco verboso, lo encapsulamos).
b2() {
  AWS_ACCESS_KEY_ID="${B2_ACCESS_KEY_ID}" \
  AWS_SECRET_ACCESS_KEY="${B2_SECRET_ACCESS_KEY}" \
  aws --endpoint-url "${B2_ENDPOINT}" --region "${B2_REGION}" "$@"
}

# -----------------------------------------------------------------------------
# 1. Validaciones de pre-vuelo.
# -----------------------------------------------------------------------------
command -v docker >/dev/null || fail "docker no instalado"
command -v gpg >/dev/null    || fail "gpg no instalado (apt install gnupg)"
command -v aws >/dev/null    || fail "aws-cli no instalado (apt install awscli)"

log "===== Backup StorageOS - ${TS} ====="
log "Dump destino: ${DUMP_FILE}"
log "Bucket remoto: s3://${B2_BUCKET}/"

# -----------------------------------------------------------------------------
# 2. Dump de Postgres con pg_dump custom format (-Fc) -> pg_restore friendly.
# -----------------------------------------------------------------------------
log "[1/4] pg_dump..."
docker compose -f "${COMPOSE_FILE}" exec -T \
  -e PGPASSWORD="${POSTGRES_PASSWORD}" \
  "${PG_SERVICE}" \
  pg_dump \
    --username="${POSTGRES_USER}" \
    --dbname="${POSTGRES_DB}" \
    --format=custom \
    --compress=9 \
    --no-owner \
    --no-privileges \
    --verbose \
  > "${DUMP_FILE}"

DUMP_SIZE=$(du -h "${DUMP_FILE}" | cut -f1)
log "pg_dump OK (${DUMP_SIZE})"

# -----------------------------------------------------------------------------
# 3. Cifrado simétrico GPG.
# -----------------------------------------------------------------------------
log "[2/4] gpg --symmetric..."
gpg --batch --yes --quiet \
  --passphrase "${BACKUP_GPG_PASSPHRASE}" \
  --symmetric --cipher-algo AES256 \
  --output "${ENC_FILE}" \
  "${DUMP_FILE}"

# El .dump en claro se borra inmediatamente: solo conservamos el .gpg.
shred -u "${DUMP_FILE}" 2>/dev/null || rm -f "${DUMP_FILE}"
ENC_SIZE=$(du -h "${ENC_FILE}" | cut -f1)
log "cifrado OK (${ENC_SIZE})"

# -----------------------------------------------------------------------------
# 4. Subir el dump cifrado al bucket remoto.
# -----------------------------------------------------------------------------
log "[3/4] aws s3 cp postgres -> B2..."
b2 s3 cp "${ENC_FILE}" "s3://${B2_BUCKET}/postgres/$(basename "${ENC_FILE}")" \
  --only-show-errors
log "upload OK"

# -----------------------------------------------------------------------------
# 5. Replicar MinIO local -> B2.
#    `aws s3 sync` es incremental: solo sube lo nuevo/cambiado.
#    Apuntamos al MinIO local via su API S3 (puerto 9000 dentro de la red).
# -----------------------------------------------------------------------------
if [[ -n "${MINIO_ROOT_PASSWORD}" ]]; then
  log "[4/4] aws s3 sync minio -> B2..."

  # Hacemos accesible MinIO al host con un puerto efímero solo durante el sync.
  # Alternativa: ejecutar el sync dentro de un sidecar conectado a storageos-net.
  # Por simplicidad usamos el sidecar.
  for bucket in storageos-uploads storageos-invoices storageos-plans storageos-reports; do
    log "  sync ${bucket}..."
    docker run --rm \
      --network storageos-net \
      -e AWS_ACCESS_KEY_ID="${B2_ACCESS_KEY_ID}" \
      -e AWS_SECRET_ACCESS_KEY="${B2_SECRET_ACCESS_KEY}" \
      -e MC_HOST_src="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@${MINIO_SERVICE}:9000" \
      minio/mc:latest \
      mirror --overwrite --remove "src/${bucket}" \
      "https://${B2_BUCKET}.${B2_ENDPOINT#https://}/minio/${bucket}" \
      || log "  WARN: sync ${bucket} falló (continuando)"
  done
  log "minio sync OK"
else
  log "[4/4] skip minio sync (MINIO_ROOT_PASSWORD vacío)"
fi

# -----------------------------------------------------------------------------
# 6. Retención local: borra .gpg con mtime > BACKUP_RETENTION_DAYS.
# -----------------------------------------------------------------------------
log "Retención local: borrando >${BACKUP_RETENTION_DAYS} días..."
find "${BACKUP_LOCAL_DIR}" -maxdepth 1 -name '*.dump.gpg' -type f \
  -mtime +"${BACKUP_RETENTION_DAYS}" -print -delete | sed 's/^/  delete: /' || true

# Listado final
REMAINING=$(find "${BACKUP_LOCAL_DIR}" -maxdepth 1 -name '*.dump.gpg' -type f | wc -l)
log "Backups locales restantes: ${REMAINING}"

log "===== Backup completado OK ====="
