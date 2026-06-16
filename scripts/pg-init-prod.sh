#!/bin/sh
# =============================================================================
# scripts/pg-init-prod.sh — init de Postgres para el arranque automatico.
#
# La imagen oficial de Postgres ejecuta los scripts de
# /docker-entrypoint-initdb.d/ UNA sola vez, cuando el volumen de datos esta
# vacio (primer arranque). Aqui creamos:
#   - Extensiones requeridas (pgcrypto, btree_gist para el EXCLUDE anti-overbooking).
#   - El rol restringido $POSTGRES_APP_USER (RLS) que usa el dia a dia del API.
#   - ALTER DEFAULT PRIVILEGES: las tablas/secuencias que cree luego el servicio
#     `migrate` (conectado como el rol admin $POSTGRES_USER) heredan AUTOMATICAMENTE
#     los permisos para el rol app. Asi no hace falta un paso de grants manual
#     post-migracion.
#
# Variables: las inyecta la imagen de Postgres desde su `environment` (mismas
# que POSTGRES_USER/DB; ademas POSTGRES_APP_USER/PASSWORD que añadimos en el
# compose). Las passwords deben ser alfanumericas (sin comillas) — el generador
# de secretos ya las produce asi.
# =============================================================================
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO \$do\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_APP_USER}') THEN
    CREATE ROLE ${POSTGRES_APP_USER} LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}';
  END IF;
END \$do\$;

GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO ${POSTGRES_APP_USER};
GRANT USAGE ON SCHEMA public TO ${POSTGRES_APP_USER};

-- Permisos sobre objetos FUTUROS creados por el rol admin (= los que crea migrate).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_APP_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${POSTGRES_APP_USER};
EOSQL

echo "[pg-init] rol ${POSTGRES_APP_USER} + extensiones + default privileges OK"
