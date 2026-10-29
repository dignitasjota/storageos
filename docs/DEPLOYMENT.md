# DEPLOYMENT

> Estado al cierre de **Fase 8C**: pipeline de despliegue productivo completo sobre VPS único con Docker, Nginx Proxy Manager y backups cifrados. Sin staging dedicado todavía (pendiente Fase 8D).

## Topología

```
                            Internet (HTTPS 443)
                                   │
                          ┌────────▼────────┐
                          │  Nginx Proxy    │  (SSL Let's Encrypt)
                          │  Manager (NPM)  │
                          └────┬───────┬────┘
                               │       │
                  app.dominio  │       │  api.dominio
                               │       │
                       ┌───────▼─┐  ┌──▼──────┐
                       │   web   │  │   api   │
                       │ Next 15 │  │ NestJS  │
                       │  :3000  │  │  :3001  │
                       └────┬────┘  └────┬────┘
                            │            │
                            └─────┬──────┘
                                  │  storageos-net
                  ┌───────────────┼───────────────┐
                  │               │               │
            ┌─────▼─────┐  ┌──────▼──────┐  ┌────▼─────┐
            │ postgres  │  │    redis    │  │  minio   │
            │    :5432  │  │     :6379   │  │  :9000   │
            └───────────┘  └─────────────┘  └──────────┘
              postgres-       redis-           minio-
                data           data             data    (volúmenes)
```

- VPS único Hetzner CX22 (Debian 12, 2 vCPU, 4 GB RAM, 40 GB SSD) como mínimo recomendado.
- Solo NPM expone puertos al host (80/443). El resto vive en la red interna `storageos-net`.
- Backups cifrados con GPG hacia Backblaze B2 (S3-compatible).
- Email transaccional via Resend (no autohospedamos SMTP).

---

## 1. Preparación del VPS

### 1.1 Provisión inicial

```bash
# Desde tu máquina local: genera una clave SSH si aún no la tienes
ssh-keygen -t ed25519 -C "storageos-prod"

# Sube la pública al VPS (la primera vez vía consola del proveedor con password root)
ssh-copy-id root@<vps-ip>
ssh root@<vps-ip>
```

### 1.2 Crear usuario sin privilegios

```bash
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

### 1.3 Hardening SSH

Editar `/etc/ssh/sshd_config`:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
```

```bash
systemctl reload ssh
# Probar en OTRA terminal: ssh deploy@<vps-ip>  ANTES de cerrar la actual.
```

### 1.4 Firewall UFW

```bash
apt update && apt install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp     # SSH
ufw allow 80/tcp     # HTTP (LE challenge + redirect a 443)
ufw allow 443/tcp    # HTTPS
ufw enable
ufw status verbose
```

### 1.5 Updates automáticos

```bash
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

### 1.6 Swap (recomendado para CX22 con 4 GB)

```bash
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 2. Instalar Docker + Compose v2

```bash
# Repo oficial
apt update && apt install -y ca-certificates curl gnupg lsb-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Permitir a deploy ejecutar docker sin sudo
usermod -aG docker deploy
# Re-login para que el grupo aplique:
exit && ssh deploy@<vps-ip>

docker --version
docker compose version
```

---

## 3. Portainer (opcional, gestión visual)

```bash
docker volume create portainer_data
docker run -d \
  -p 127.0.0.1:9443:9443 \
  --name portainer \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

Luego exponer `portainer.tu-dominio.com` via NPM (paso 4) con SSL. NUNCA abrir 9443 al exterior directamente.

---

## 4. Nginx Proxy Manager

NPM es la única puerta de entrada HTTPS.

### 4.1 Stack dedicado

```bash
mkdir -p /opt/npm && cd /opt/npm
cat > docker-compose.yml <<'YAML'
name: npm

services:
  npm:
    image: jc21/nginx-proxy-manager:latest
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
      - '127.0.0.1:81:81'   # admin UI: tunel SSH o exposicion via NPM mismo
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
    networks:
      - storageos-net

networks:
  storageos-net:
    external: true
YAML

# Crear la red ANTES (también la crea docker-compose.prod.yml, da igual qué orden):
docker network create storageos-net || true

docker compose up -d
```

### 4.2 Primer login

- Tunel SSH a la admin UI: `ssh -L 8181:127.0.0.1:81 deploy@<vps-ip>` y abrir `http://localhost:8181`.
- Credenciales por defecto: `admin@example.com` / `changeme`. Cambiarlas inmediatamente.

### 4.3 Proxy hosts

Crear dos proxy hosts:

| Domain               | Scheme | Forward Hostname | Forward Port | Cache | Block Common Exploits | Websockets |
| -------------------- | ------ | ---------------- | ------------ | ----- | --------------------- | ---------- |
| `app.tu-dominio.com` | http   | `web`            | 3000         | yes   | yes                   | yes        |
| `api.tu-dominio.com` | http   | `api`            | 3001         | no    | yes                   | yes        |

En cada uno, pestaña **SSL** → Request a new SSL Certificate con Let's Encrypt + Force SSL + HTTP/2.

**IP real del cliente (`TRUST_PROXY_HOPS`)**: NPM añade `X-Forwarded-For`, y la API
lo usa gracias a Express `trust proxy` con `TRUST_PROXY_HOPS` (default `1` = solo NPM
delante). Si pones otro proxy delante de NPM (p. ej. Cloudflare en modo proxy) súbelo a
`2`. Tiene que ser el nº **exacto**: de menos, todas las peticiones comparten la IP de NPM
(el rate limit pasa a ser global: 5 logins/min para toda la plataforma) y los audit logs
registran siempre la misma IP; de más, un cliente puede falsificar su IP con la cabecera.
Comprobación: en `audit_logs.ip_address` deben aparecer IPs públicas, no `172.x.x.x`.

Para `api.tu-dominio.com` añadir un **Custom location** específico para `/webhooks/stripe` con `Request body size` aumentado a 5MB y sin caché (Stripe envía raw body firmado).

---

## 5. Clonar repo y configurar `.env.prod`

```bash
cd /opt
git clone https://github.com/<tu-org>/storageos.git
cd storageos
git checkout main   # o el tag concreto que vayas a desplegar
```

### 5.1 Generar secretos

```bash
# JWTs (3 secretos independientes)
openssl rand -base64 64 | tr -d '\n'    # JWT_ACCESS_SECRET
openssl rand -base64 64 | tr -d '\n'    # JWT_2FA_PENDING_SECRET
openssl rand -base64 64 | tr -d '\n'    # SUPER_ADMIN_JWT_SECRET

# AES-256-GCM master key (32 bytes en base64 exacto)
openssl rand -base64 32

# Passwords de servicios
openssl rand -base64 24    # POSTGRES_PASSWORD (rol admin)
openssl rand -base64 24    # POSTGRES_APP_PASSWORD (rol app, RLS)
openssl rand -base64 24    # REDIS_PASSWORD
openssl rand -base64 24    # MINIO_ROOT_PASSWORD
openssl rand -base64 24    # BACKUP_GPG_PASSPHRASE
```

### 5.2 Crear `/opt/storageos/.env.prod`

La **plantilla completa y mantenida** vive en la raíz del repo como
[`.env.prod.example`](../.env.prod.example) — es la fuente única de verdad
(derivada de `apps/api/src/config/env.schema.ts`, el compose de prod y los
scripts de backup). Cópiala y rellena cada `<PLACEHOLDER>`:

```bash
cd /opt/storageos
cp .env.prod.example .env.prod
$EDITOR .env.prod   # pega los secretos generados en 5.1

chmod 600 /opt/storageos/.env.prod
chown deploy:deploy /opt/storageos/.env.prod
```

Notas:

- Variables marcadas `[OBLIGATORIO]` en la plantilla: el API valida el entorno
  con Zod al arrancar y **no levanta** si falta o es inválida alguna.
- `RELEASE_TAG` etiqueta las imágenes; ponlo al tag de git que despliegas
  (o `main`).
- Para el **primer arranque** puedes empezar con `AEAT_MODE=stub` y claves
  **Stripe test** (`sk_test_`/`pk_test_`), validar todo, y luego cambiar a
  `sandbox`/`production` y claves `live`.
- El compose sobreescribe `DATABASE_URL`, `DATABASE_ADMIN_URL`, `REDIS_*`,
  `MINIO_ENDPOINT/PORT/USE_SSL` y `ENABLE_WORKERS_IN_API` con los hostnames
  internos; aun así déjalas coherentes en el fichero (las usan el servicio
  `migrate`, los backups y clientes manuales).

---

## 6. Primer arranque

```bash
cd /opt/storageos

# 6.1 Crear la red si no existe (NPM la habrá creado ya en su stack)
docker network create storageos-net 2>/dev/null || true

# 6.2 Build de las imagenes (puede tardar 5-10 min la primera vez)
docker compose -f docker-compose.prod.yml --env-file .env.prod build

# 6.3 Arrancar SOLO las dependencias para que las migraciones tengan donde correr
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres redis minio

# 6.4 Esperar a que postgres este healthy
docker compose -f docker-compose.prod.yml --env-file .env.prod ps

# 6.5 Crear el rol restringido storageos_app + extensiones requeridas
docker compose -f docker-compose.prod.yml --env-file .env.prod exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$POSTGRES_APP_USER') THEN
    CREATE ROLE $POSTGRES_APP_USER LOGIN PASSWORD '$POSTGRES_APP_PASSWORD';
  END IF;
END\$\$;
GRANT CONNECT ON DATABASE $POSTGRES_DB TO $POSTGRES_APP_USER;
GRANT USAGE ON SCHEMA public TO $POSTGRES_APP_USER;
SQL

# 6.6 Aplicar migraciones Prisma (servicio one-shot)
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate

# 6.7 Conceder permisos al rol app sobre las tablas recién creadas
docker compose -f docker-compose.prod.yml --env-file .env.prod exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $POSTGRES_APP_USER;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $POSTGRES_APP_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $POSTGRES_APP_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO $POSTGRES_APP_USER;
SQL

# 6.8 Crear los buckets MinIO (OPCIONAL desde 2026-09-26: el `api` los crea al
#     arrancar y deja `storageos-public` como lectura anónima; esto solo lo adelanta)
# IMPORTANTE: `storageos-public` es PUBLIC-READ (anonymous download) porque
# sirve las imágenes de los locales en la landing pública sin auth. Los demás
# buckets quedan PRIVADOS (guardan documentos de clientes y PDFs de contratos).
docker compose -f docker-compose.prod.yml --env-file .env.prod exec minio \
  /bin/sh -c "
    mc alias set local http://localhost:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD &&
    mc mb --ignore-existing local/storageos-uploads &&
    mc mb --ignore-existing local/storageos-invoices &&
    mc mb --ignore-existing local/storageos-plans &&
    mc mb --ignore-existing local/storageos-reports &&
    mc mb --ignore-existing local/storageos-public &&
    mc anonymous set download local/storageos-public
  "

# 6.9 Levantar api + web
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d api web

# 6.10 Comprobar logs
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api web
```

---

## 6B. Despliegue alternativo: Portainer (Git stack, 100% automático)

Si prefieres no usar SSH, `docker-compose.portainer.yml` está pensado para
desplegarse desde Portainer como **stack de tipo Repository**, con las
variables en la sección _Environment variables_ de Portainer (no `.env.prod`).
Automatiza los tres pasos imperativos del arranque:

- **Rol Postgres + extensiones + default privileges** → `scripts/pg-init-prod.sh`
  (init de Postgres, solo en BD virgen). Gracias al `ALTER DEFAULT PRIVILEGES`,
  las tablas que cree `migrate` (rol admin) heredan los permisos del rol app
  automáticamente — sin paso de grants manual.
- **Migraciones** → servicio `migrate`; `api`/`worker` esperan con
  `service_completed_successfully`.
- **Buckets MinIO** → los crea el propio `api` al arrancar (`FilesService.onModuleInit`)
  y deja `storageos-public` como lectura anónima (solo `GetObject`, sin listado).
  Antes lo hacía el init-container `createbuckets` con la imagen `minio/mc`,
  retirado el 2026-09-26 porque MinIO dejó de publicar sus imágenes (Docker Hub
  denegaba el pull: `pull access denied for minio/mc`).

### Pasos

1. **Commitea y pushea** `docker-compose.portainer.yml` y `scripts/pg-init-prod.sh`
   (Portainer clona el repo; los lee de ahí).
2. En Portainer: **Stacks → Add stack → Repository**.
   - Repository URL: tu repo. Reference: `refs/heads/main` (o el tag).
   - Compose path: `docker-compose.portainer.yml`.
3. **Environment variables**: añade las del bloque `x-app-env`/servicios marcadas
   `${...}` sin default — como mínimo: `POSTGRES_USER/PASSWORD/DB`,
   `POSTGRES_APP_USER/PASSWORD`, `REDIS_PASSWORD`, `MINIO_ROOT_USER/PASSWORD`,
   `JWT_ACCESS_SECRET`, `JWT_2FA_PENDING_SECRET`, `MASTER_ENCRYPTION_KEY`,
   `SUPER_ADMIN_JWT_SECRET`, `NEXT_PUBLIC_API_URL`, `WEB_BASE_URL`,
   `ALLOWED_ORIGINS`, `COOKIE_DOMAIN`. Las demás tienen default (las cambias
   cuando actives Stripe/Resend/AEAT). **No** definas `SENTRY_DSN` ni
   `SECURITY_ALERT_EMAIL` vacías (validación de formato estricta: o un valor
   válido, o ausentes).
4. **Deploy**. Portainer construye las imágenes (api/worker/web), levanta la
   infra, corre el init de Postgres + `migrate`, y arranca api/web/worker
   (el `api` crea los buckets). `migrate` queda en `exited (0)`: es normal.
   Si el stack venía de una versión con `createbuckets`, Portainer puede dejar
   ese contenedor huérfano en `exited`: se puede borrar sin más.
5. Conecta NPM a la red (la otra app sigue en `npm-net`):
   `docker network connect storageos-net <contenedor-npm>`.

### Notas

- Los secretos viven en Portainer (su BD), **nunca** en el repo.
- Para actualizar a mano: **Pull and redeploy** (ver §6C para el automático). El
  redeploy hace `git pull` del repo y reconstruye; al traer commits nuevos, la
  capa `COPY apps/web` del Dockerfile se invalida y el **web se reconstruye con
  el código nuevo**. ⚠️ Un "redeploy" **sin** pull efectivo da _cache hit_ del
  `COPY` → sirve la imagen **vieja** del frontend (síntoma típico: ves rutas o
  cambios que faltan, p. ej. un 404 en una página recién añadida). Si pasa,
  fuerza el pull (webhook §6C) o, en el editor del stack, vuelve a desplegar
  asegurando que reconstruye.
- Construir 3 imágenes en un CX22 (4 GB) tira de swap; ten el swapfile de la
  sección 1.6 activo.
- El `migrate dev` nunca; aquí solo corre `migrate deploy` (idempotente).

---

## 6C. Despliegue automático en cada merge (webhook de Portainer)

Para no tener que entrar a Portainer a redeplegar a mano tras cada merge a
`main` (y evitar olvidarlo, que deja el frontend desactualizado), hay un
workflow de GitHub Actions (`.github/workflows/deploy.yml`) que dispara un
**webhook de redeploy** del stack. Como el webhook hace `git pull` + redeploy,
el web se reconstruye con el código nuevo (resuelve el problema de ver versiones
viejas del frontend).

`main` está protegida (solo avanza con los 4 checks en verde), así que cuando el
workflow se dispara el código ya pasó CI + E2E.

### Configuración (una sola vez)

1. **Crea el webhook en Portainer**: abre el **stack** → pestaña/sección
   **Webhooks** → **Create stack webhook** (o, en versiones nuevas, el icono de
   webhook junto a "Update the stack"). Copia la URL, con forma
   `https://<tu-portainer>/api/stacks/webhooks/<uuid>`.
2. **Guarda la URL en GitHub**: repo → **Settings → Secrets and variables →
   Actions → New repository secret**:
   - Name: `PORTAINER_WEBHOOK_URL`
   - Value: la URL del paso 1.
3. Listo. En el próximo merge a `main`, el job **Deploy (Portainer)** hará
   `POST` a esa URL y Portainer redeplegará. Sin el secret, el workflow no falla:
   registra un aviso y termina (no-op), así que puedes mergear este cambio antes
   de configurarlo.

### Verificación

- Tras un merge, en GitHub → pestaña **Actions** → workflow **Deploy
  (Portainer)** debe salir en verde con "✅ Redeploy disparado".
- En Portainer, el stack debe mostrar un redeploy reciente; cuando termine,
  recarga el panel con **Ctrl/Cmd + Shift + R**.

### Si aun así el web sigue saliendo viejo

El webhook fuerza el `git pull`, que normalmente basta para que el `COPY` del
Dockerfile invalide la caché. Si en algún caso Portainer reutilizara la imagen
del web sin reconstruir, la opción definitiva (determinista, sin caché local) es
**construir las imágenes en CI y publicarlas en un registry** (p. ej. GHCR) y
que el compose use `image:` en vez de `build:`; el webhook entonces solo hace
_pull image + redeploy_. Es un cambio mayor del pipeline; pendiente como
follow-up si el webhook no resultara suficiente.

---

## 7. Bootstrap: planes de suscripción + super admin

`pnpm db:seed` (que crea planes y datos demo) **no puede correr en producción**:
usa `tsx` + los fuentes TS, que no están en la imagen compilada. En su lugar
hay un script de bootstrap idempotente, `apps/api/src/scripts/bootstrap.ts`,
que se compila a `dist/scripts/bootstrap.js` dentro de la imagen del API y:

1. Siembra los planes `free`/`starter`/`pro`. **Imprescindible**: el registro
   de un tenant exige el plan `starter`; sin él, falla con
   _"Configuracion de planes incompleta"_.
2. Crea la serie de facturación por defecto (`A`, prefijo `FA`) en los tenants
   que no tienen ninguna (el registro ya la crea desde el 2026-10-22).
3. Crea el super admin inicial **si** defines `BOOTSTRAP_SUPERADMIN_EMAIL` y
   `BOOTSTRAP_SUPERADMIN_PASSWORD` (no resetea la password si el admin ya
   existe).

### 7.1 Automático (recomendado, Portainer)

`docker-compose.portainer.yml` incluye un servicio one-shot `bootstrap` que
corre tras `migrate` en cada deploy. Define en las _Environment variables_ de
Portainer (ver `.env.prod.example`):

```ini
BOOTSTRAP_SUPERADMIN_EMAIL=tu@correo.com
BOOTSTRAP_SUPERADMIN_PASSWORD=<contraseña fuerte>
BOOTSTRAP_SUPERADMIN_NAME=Owner
```

En el redeploy verás en sus logs `[bootstrap] planes OK: free, starter, pro` y
`[bootstrap] super admin OK: ...`. Es idempotente: correr de nuevo no duplica.

### 7.2 Manual (CLI / consola del contenedor)

```bash
docker exec \
  -e BOOTSTRAP_SUPERADMIN_EMAIL=tu@correo.com \
  -e BOOTSTRAP_SUPERADMIN_PASSWORD='contraseña fuerte' \
  $(docker ps -qf name=api | head -1) node dist/scripts/bootstrap.js
```

(Sin las dos env de super admin, solo siembra los planes.)

Luego entra en `https://app.tu-dominio.com/admin/login`, cambia la contraseña y
**activa el 2FA**.

---

## 8. Verificación

```bash
# Health del API a través de NPM (HTTPS)
curl -sS https://api.tu-dominio.com/health
# -> {"status":"ok","timestamp":"..."}

# Web responde HTML
curl -sS -o /dev/null -w "%{http_code}\n" https://app.tu-dominio.com
# -> 200

# Headers de seguridad
curl -sSI https://app.tu-dominio.com | grep -iE 'strict-transport|x-frame|x-content-type'

# Registro funciona
curl -sS -X POST https://api.tu-dominio.com/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"Test12345!","name":"Test","tenantName":"Test","tenantSlug":"test-tenant"}'
```

---

## 9. Releases (actualizaciones)

```bash
cd /opt/storageos

# 1. Bajar nuevo código y fijar release tag
git fetch --tags
git checkout v0.5.0
sed -i 's/^RELEASE_TAG=.*/RELEASE_TAG=v0.5.0/' .env.prod

# 2. Reconstruir imágenes (cache de capas acelera mucho)
docker compose -f docker-compose.prod.yml --env-file .env.prod build api web

# 3. Aplicar migraciones ANTES del rolling restart
docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrate

# 4. Recrear contenedores con la nueva imagen
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d api web

# 5. Limpiar imagenes huérfanas
docker image prune -f
```

Para hacer rollback: `git checkout <tag-anterior>` + repetir build + restart. Los datos persisten en los volúmenes nombrados.

---

## 10. Backups

Ver `scripts/README.md` para los scripts. Resumen:

- `scripts/backup.sh` cifra el dump con GPG y lo sube a Backblaze B2.
- Cron sugerido `0 3 * * *` (3 AM Europe/Madrid).
- Retención local 30 días, remota ilimitada (gestionada en B2 con object lock).

```bash
# Cron del usuario deploy
crontab -e
# Añadir:
0 3 * * * /opt/storageos/scripts/backup.sh >> /var/log/storageos-backup.log 2>&1
```

### 10.1. Backup DENTRO del stack (recomendado — sin depender del crontab del host)

Además de `scripts/backup.sh` (que corre en el host y usa `docker compose exec`),
el compose de producción incluye un servicio **`backup`** (perfil `backup`, opt-in)
que respalda **Postgres** a diario **desde dentro del stack** — sobrevive a un
reprovisionamiento del host y no depende de que alguien configure el crontab. Se
conecta directo a `postgres` por la red interna (sin docker socket): `pg_dump`
custom → cifrado GPG AES-256 → subida a Backblaze B2 (S3-compatible), con
retención local `BACKUP_RETENTION_DAYS`.

Activar (Portainer: añadir `backup` a **COMPOSE_PROFILES** en el Environment del
stack; o CLI):

```bash
COMPOSE_PROFILES=backup docker compose -f docker-compose.prod.yml up -d backup
docker compose logs -f backup   # ver "[backup] subido a B2"
```

Variables necesarias (Environment del stack o `.env.prod`): `BACKUP_GPG_PASSPHRASE`,
`B2_ENDPOINT`, `B2_BUCKET`, `B2_REGION`, `B2_ACCESS_KEY_ID`, `B2_SECRET_ACCESS_KEY`
(y opcionales `BACKUP_RETENTION_DAYS`, `BACKUP_INTERVAL_SECONDS`). El servicio
respalda **Postgres** (los datos transaccionales críticos); para respaldar además
los **archivos de MinIO** (documentos, PDFs) usa `scripts/backup.sh` desde el host
(paso 4 del script) o añade un sidecar de sincronización a B2.

> El intervalo por defecto es 24 h desde el arranque del servicio. Para forzar un
> backup inmediato: `docker compose restart backup`.

---

## 10.4. Email con Brevo (recomendado)

La app envía por la **API transaccional de Brevo** (`EMAIL_PROVIDER=brevo`). Una
sola cuenta de la plataforma sirve para todos los tenants.

1. En Brevo → **Senders, domains & dedicated IPs → Domains**, añade `trasteros.pro`
   y pon en el DNS los registros que indica (código de verificación, DKIM y
   DMARC). Pulsa **Authenticate** hasta que salga verificado.
2. Brevo → **SMTP & API → API keys** → crea una clave.
3. Variables de Portainer (en `api` **y** `worker`, que es quien envía las colas):
   ```
   EMAIL_PROVIDER=brevo
   BREVO_API_KEY=xkeysib-...
   EMAIL_FROM_NAME=TrasterOS
   EMAIL_FROM_ADDRESS=no-reply@trasteros.pro
   ```
4. Redeploy y prueba con «¿Olvidaste la contraseña?».

**Brevo y Resend a la vez** (para sumar los cupos gratuitos de ambos): pon
`BREVO_API_KEY` **y** `RESEND_API_KEY`, y autentica `trasteros.pro` en los dos
(cada uno usa sus propios registros DKIM; conviven). En el panel de super admin
→ **Comunicación → Correo saliente** eliges el principal y si, al fallar (p. ej.
cupo diario agotado), se reintenta con el otro; hay un botón de correo de
prueba. El cambio se aplica en menos de un minuto en `api` y `worker`.
`EMAIL_PROVIDER` queda como valor por defecto si en el panel no se elige nada
(déjala en `brevo`; si la quitas vale `smtp`, que en producción no tiene
servidor).

**Dominio propio de correo de cada tenant** (funcionalidad «Dominio propio»):
el tenant indica su dominio en Ajustes → Correo; la app lo da de alta en la
**misma cuenta Brevo de la plataforma** (`BREVO_API_KEY`) y le muestra los
registros DNS. Al verificarlo, sus correos a inquilinos salen desde
`<dirección>@<su-dominio>` y **siempre por Brevo** (aunque en el panel el
principal sea Resend). Un cron diario verifica los pendientes y avisa si uno
verificado deja de estarlo (vuelve al remitente de la plataforma). Sin
`BREVO_API_KEY` la opción responde 503.

- Además de los registros de Brevo, el tenant publica un TXT propio
  `_trasteros.<dominio>` = `trasteros-verification=<código>`: Brevo solo prueba
  que el dominio apunta a nuestra cuenta, no de qué tenant es. Sin ese TXT no se
  verifica (evita que un tenant use el dominio de otro).
- Si el dominio ya existía en la cuenta Brevo (p. ej. creado a mano), se adopta
  (la app consulta primero si existe; Brevo no avisa de duplicados al crear).
- Los nombres de los registros se muestran **relativos al dominio**
  (`_trasteros`, `brevo1._domainkey`, `@` para la raíz), que es lo que piden los
  paneles DNS: añaden el dominio solos.
- Con un dominio ya puesto, el tenant no puede cambiarlo desde el formulario:
  tiene que quitarlo y añadir el nuevo (y volver a poner sus DNS).
- La app **nunca borra dominios de Brevo** (ni al quitarlos ni al cambiarlos):
  si fue un error, volver a añadirlo no obliga a rehacer los DNS. Los que ya no
  usa ningún tenant aparecen en el panel admin → Comunicación → Correo saliente
  → «Dominios en Brevo sin uso», con un botón para borrarlos de Brevo.

**Avisos de entrega (recomendado).** Brevo y Resend aceptan un correo y pueden
rechazarlo o rebotarlo después (p. ej. remitente sin autenticar): sin estos
avisos la app lo da por enviado. Con ellos, cada comunicación pasa a
«entregada», «rebotada» o «fallida», el tenant recibe un aviso en la app y los
rechazos de correos de la plataforma llegan al super admin. Las URLs están en el
panel admin → Correo saliente → «Avisos de entrega».

- **Brevo** → Transactional → Settings → Webhook → URL
  `https://api.trasteros.pro/webhooks/email-events/brevo?token=<EMAIL_WEBHOOK_TOKEN>`,
  eventos Delivered, Hard bounce, Invalid email, Blocked y Error. En Portainer,
  `EMAIL_WEBHOOK_TOKEN` = un valor aleatorio largo (el mismo de la URL).
- **Resend** → Webhooks → Add endpoint
  `https://api.trasteros.pro/webhooks/email-events/resend`, eventos
  `email.delivered`, `email.bounced`, `email.failed`; su «Signing secret»
  (`whsec_…`) va en `RESEND_WEBHOOK_SECRET`.
- Sin la variable, el endpoint responde 404 (el aviso queda desactivado).

**Alternativa por SMTP** (mismo resultado): `EMAIL_PROVIDER=smtp`,
`SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER=<login SMTP de
Brevo>`, `SMTP_PASSWORD=<clave SMTP>`, `SMTP_SECURE=false`. Sin `SMTP_USER` el
envío SMTP va sin autenticación ni TLS (solo vale para Mailpit en local).

**Remitente de los correos a inquilinos**: los que un tenant envía a sus
inquilinos (recordatorios, campañas, automatizaciones, enlaces del portal, lista
de espera, ofertas de retención) salen con **el nombre del tenant** como
remitente visible, desde `EMAIL_FROM_ADDRESS`, y las respuestas van al email de
facturación del tenant (o al del propietario). Los correos de cuenta y los
avisos de la plataforma al tenant salen como `EMAIL_FROM_NAME`.

## 10.5. Setup de Resend producción

Necesario **antes** del primer envío real desde producción. Sin SPF/DKIM/DMARC, los emails caen en spam o se rechazan.

### 10.5.1 Crear cuenta y dominio en Resend

1. Ir a https://resend.com/signup, crear cuenta con el email del owner.
2. Ir a **Domains** → **Add Domain** → introducir `tu-dominio.com` (NO el subdominio del email).
3. Resend muestra 3 registros DNS que hay que añadir en tu proveedor (Cloudflare, Namecheap, Hetzner DNS, etc.):

   | Tipo  | Host                | Valor                                               | Notas         |
   | ----- | ------------------- | --------------------------------------------------- | ------------- |
   | TXT   | `send`              | `v=spf1 include:amazonses.com ~all`                 | SPF           |
   | CNAME | `resend._domainkey` | `<valor que da Resend>`                             | DKIM          |
   | TXT   | `_dmarc`            | `v=DMARC1; p=none; rua=mailto:dmarc@tu-dominio.com` | DMARC monitor |

   El subdominio `send.tu-dominio.com` se usa como `from` de los emails.

4. En el panel de Resend pulsa **Verify**. Tarda 1-30 minutos según el TTL DNS.

### 10.5.2 Crear API key

1. **API Keys** → **Create API Key** → nombre `storageos-prod`, dominio `tu-dominio.com`, permission `sending_access`.
2. Copia el `re_xxxxx`. Solo se muestra una vez.

### 10.5.3 Configurar `.env.prod`

```env
EMAIL_PROVIDER=resend
EMAIL_FROM_NAME=TrasterOS
EMAIL_FROM_ADDRESS=no-reply@send.tu-dominio.com   # el subdominio que verificaste
RESEND_API_KEY=re_xxxxxxxx
```

Reinicia la api: `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d api`.

### 10.5.4 Verificar el envío

```bash
curl -X POST https://api.tu-dominio.com/auth/password/forgot \
  -H 'Content-Type: application/json' \
  -d '{"email":"tu-email-personal@gmail.com","tenantSlug":"tu-tenant"}'
```

Si recibes el email en gmail/outlook (no en spam), el setup está bien. Revisa el header `Authentication-Results` — debe decir `spf=pass dkim=pass dmarc=pass`.

### 10.5.5 Endurecer DMARC (después de 7 días sin problemas)

```dns
_dmarc TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@tu-dominio.com; pct=100"
```

Y eventualmente `p=reject`.

### 10.5.6 Webhooks de Resend (post-MVP)

Resend puede notificar `delivered`/`bounced`/`complained` para que actualicemos `communications.status`. Configurarlo cuando exista el endpoint `POST /webhooks/resend` (pendiente backlog post-MVP).

---

## 11. Activar Veri\*Factu en producción

A partir de **2026-07-01** entra en vigor el RD 1007/2023 (Veri\*Factu). Cualquier factura emitida por un tenant español debe enviarse al AEAT en tiempo real. La Fase 10 cierra esta integración con cliente real (mTLS + SOAP) por tenant. Pasos para activarla en una instalación productiva.

### 11.1. Pre-requisitos del tenant

- Cada tenant debe disponer de un **certificado digital** válido para AEAT:
  - **FNMT-CERES** persona física o jurídica (gratuito, descarga desde la sede de FNMT).
  - **Camerfirma**, **ANCERT**, **EDICOM** o cualquier otro PSC reconocido por AEAT.
  - Formato: PKCS#12 (`.p12` o `.pfx`) con clave privada exportable + password.
  - Periodo de validez: como mínimo 3 meses por delante.
- El **NIF del certificado debe coincidir** con `tenants.tax_id` (validación implícita al firmar registros).

### 11.2. Subir certificado al panel

- El owner del tenant accede a `/settings/billing/verifactu` (rol-gated `owner|manager`).
- Pulsa "Subir certificado", selecciona el `.p12`/`.pfx`, introduce la password del certificado, elige `environment` (`sandbox` o `production`).
- El backend parsea el PKCS#12 con `node-forge`, valida vigencia, extrae `CN`/`NIF`/`issuer`, cifra el binario con `MASTER_ENCRYPTION_KEY` (AES-256-GCM) y persiste en `tenant_aeat_credentials`. La password se cifra con el mismo mecanismo.
- El badge muestra estado (vigente, próximo a expirar < 30d, expirado) y permite revocarlo con confirmación.

### 11.3. Cambiar `AEAT_MODE` a `sandbox` o `production`

En `/opt/storageos/.env.prod` añadir/ajustar:

```env
# Veri*Factu modo real (sandbox = preproducción AEAT, production = real)
AEAT_MODE=sandbox

# Endpoints oficiales AEAT
AEAT_SANDBOX_ENDPOINT=https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/SistemaFacturacionV1
AEAT_PRODUCTION_ENDPOINT=https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/SistemaFacturacionV1
AEAT_TIMEOUT_MS=30000

# Identificación del Sistema Informático (TrasterOS) — comunes a todos los tenants
AEAT_SISTEMA_NIF=B12345678         # NIF del desarrollador/operador del software
AEAT_SISTEMA_NOMBRE=TrasterOS
AEAT_SISTEMA_VERSION=1.0.0
AEAT_SISTEMA_INSTALACION=001
```

Reinicia el contenedor API para recoger los cambios:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate api
```

> `AEAT_MODE=stub` sigue disponible para entornos de demo internos (sin envío real, hashes/QR sintéticos).

### 11.4. Verificar el flujo

1. Emite una factura desde el panel (`/invoices/new` → `issue`).
2. En `/invoices/[id]`, el `<VerifactuBadge>` muestra:
   - `Pendiente` durante los primeros segundos mientras el worker procesa.
   - `Aceptada (CSV: <código>)` con badge verde cuando AEAT responde correctamente.
3. Si aparece `Rechazada` o `Error de envío`, abre el modal "Ver respuesta AEAT" para diagnosticar el error.

### 11.5. Monitoreo

- Logs estructurados con `pino` y tags `[Verifactu]`, `[RealAeatClient]`, `[VerifactuProcessor]`.
- En Grafana/Loki (cuando estén montados): filtro `service="api" component=~"Verifactu.*"`.
- Cola BullMQ visible en BullBoard si está montado (Fase 8); job `send-to-aeat` con `attempts: 3` y backoff exponencial de 60s base.
- `aeat_status` por factura visible en BD. Query útil para diagnosticar rechazos:

  ```sql
  SELECT invoice_number, aeat_status, aeat_sent_at, aeat_response->>'message'
  FROM invoices
  WHERE tenant_id = '...' AND aeat_status IN ('error', 'rejected')
  ORDER BY aeat_sent_at DESC
  LIMIT 50;
  ```

### 11.6. Reenviar manualmente

- En `/invoices/[id]`, botón "Reenviar a AEAT" disponible cuando `aeatStatus IN (NULL, 'error', 'rejected')`.
- Llama a `POST /billing/invoices/:id/resend-aeat` → resetea el estado y reencola el job en la cola `verifactu`.
- Útil tras incidencias del lado AEAT o tras corregir datos del cliente (NIF, dirección).

### 11.7. Incidencias conocidas

- **Mantenimiento AEAT**: la sede tiene ventanas de mantenimiento programadas (ver `https://sede.agenciatributaria.gob.es/Sede/incidencias-comunicaciones.html`). Durante una ventana, los envíos pueden fallar; el retry BullMQ los recoge automáticamente.
- **Versión del sistema informático**: si actualizas TrasterOS a una versión que altera el comportamiento del registro (campos, hash, formato XML), incrementa `AEAT_SISTEMA_VERSION` para que el campo declarado en el XML refleje la versión real desplegada.
- **NIF mal formado**: si AEAT rechaza con error de validación, verifica que `customers.documentNumber` esté bien formateado (DNI sin guiones, CIF con letra inicial + 8 dígitos). El builder XML escapa pero no normaliza.
- **Certificado caducado**: si el certificado del tenant expira, todas las facturas quedan en `error` con mensaje `cert_expired`. El tenant debe subir uno nuevo desde `/settings/billing/verifactu`. Las facturas en error se pueden reenviar manualmente una vez actualizado.

---

## 12. Activar separación API/worker en producción (Sub-bloque 14A.1)

Por defecto, el API y el worker comparten el mismo grafo de módulos, lo que significa que ambos procesos ejecutarían los `@Cron` y los `@Processor` BullMQ. Si esto se deja activo en producción, los crons (facturación recurrente diaria, dunning, alertas de seguridad...) se disparan DOS veces y generan facturas, emails y bloqueos duplicados.

El flag `ENABLE_WORKERS_IN_API` controla este comportamiento.

### 12.1. Configuración

1. **En `.env.prod` del API**, asegurarse de que está:

   ```ini
   # API HTTP-only: no ejecuta workers BullMQ ni crons.
   ENABLE_WORKERS_IN_API=false
   ```

   `docker-compose.prod.yml` ya lo fija defensivamente en el servicio `api` por si se olvida en `.env.prod`. El worker NO necesita esta variable: su `main.ts` la fuerza a `'true'` antes de cualquier import, así que siempre registra Processors y Crons aunque comparta `.env.prod` con el API.

2. **Verificar que `apps/worker` está corriendo**:

   ```bash
   docker compose -f docker-compose.prod.yml ps worker
   # Estado esperado: Up (healthy)
   ```

3. **Comprobar logs**:

   ```bash
   docker compose -f docker-compose.prod.yml logs -f worker
   # Debes ver: "TrasterOS worker started"
   ```

### 12.2. Riesgo si el worker está caído

Si `ENABLE_WORKERS_IN_API=false` y el contenedor `worker` está caído, los jobs encolados por el API (facturas a Veri\*Factu, comunicaciones, etc.) se acumulan en Redis SIN procesarse. No se pierden — BullMQ los conserva — pero no se ejecutan hasta que el worker vuelva.

Mitigación: el panel de admin (`/admin`) muestra el contador de jobs `waiting` por cola; pasar de cero a >50 sostenido es señal de worker parado. Como cinturón adicional:

```bash
# Conexión rapida a Redis para inspeccionar colas BullMQ.
docker compose -f docker-compose.prod.yml exec redis \
  redis-cli -a "$REDIS_PASSWORD" LLEN bull:verifactu:wait
```

### 12.3. Rollback

Si por cualquier motivo necesitas que el API vuelva a ejecutar los workers (por ejemplo, durante una migración en la que el contenedor `worker` no está disponible), basta con:

```bash
# 1. Editar /opt/storageos/.env.prod -> ENABLE_WORKERS_IN_API=true
# 2. Recrear solo el API (el worker no se ve afectado, pero conviene
#    pararlo para no duplicar):
docker compose -f docker-compose.prod.yml stop worker
docker compose -f docker-compose.prod.yml up -d api
```

Cuando se restaure el worker, revertir `ENABLE_WORKERS_IN_API` a `false` y `up -d` ambos servicios.

---

## 12B. Verificar cobros SEPA (Stripe test mode)

El cobro por domiciliación SEPA usa el mismo `StripeGateway` que tarjeta (payment method `sepa_debit`). Antes de pasar a claves live, validar el ciclo completo en test mode:

1. **Claves test**: `STRIPE_SECRET_KEY=sk_test_...` + `STRIPE_PUBLISHABLE_KEY=pk_test_...` en el `.env` del API.
2. **Webhook local**: `stripe listen --forward-to localhost:4000/webhooks/stripe` (Stripe CLI); copiar el `whsec_...` que imprime a `STRIPE_WEBHOOK_SECRET`.
3. **Registrar IBAN**: en el panel, ficha del cliente → pestaña **Pagos** → "Añadir método de pago" → pestaña SEPA del formulario. IBANs de test de Stripe para España (doc oficial: https://docs.stripe.com/payments/sepa-debit/accept-a-payment):
   - `ES0700120345030000067890` — el cobro **liquida OK** (en segundos en test mode).
   - `ES9121000418450200051332` — el cobro **falla** al liquidar (`payment_intent.payment_failed`).
   - `ES5000120345030000067892` — **dispute inmediato** (`charge.dispute.created`), que debe revertir el pago y devolver la factura a `overdue`.
4. **Cobrar**: factura `issued` → "Cobrar (auto)". El toast debe avisar "Cobro SEPA iniciado…" y el payment quedar `processing`.
5. **Confirmar**: al llegar el webhook, la factura pasa a `paid` (o el payment a `failed`). Con el IBAN de chargeback, verificar que el payment vuelve a `failed` con `failureReason: disputed: ...` y la factura a `overdue`.

El mandato SEPA lo muestra el formulario de Stripe (texto legal estándar); en el flujo staff el operador debe tener el mandato firmado por el cliente (papel o contrato) antes de registrar el IBAN.

**Self-service desde el portal**: el inquilino puede registrar su propio IBAN/tarjeta y pagar facturas pendientes desde el portal (magic link → card "Método de pago" → "Añadir IBAN o tarjeta"; el mandato SEPA lo acepta online el propio pagador en el formulario). Para validarlo en test mode: pedir magic link con el email del customer de prueba, añadir un IBAN de test y pulsar "Pagar" en una factura `issued` — debe quedar `processing` y resolverse vía webhook igual que el flujo staff.

**Cobro automático al emitir** (opt-in por tenant): activar el switch "Cobro automático" en `/settings/billing` (solo owner). Para validarlo en test mode: con el flag activo y un customer con IBAN de test guardado, emitir una factura — sin tocar ningún botón debe aparecer un payment `processing` (cola BullMQ `payments`; en producción la consume el worker, así que el worker debe estar arriba). Las facturas de customers sin método quedan `issued` sin error (skip con log `[auto-charge] skip`).

---

## 12C. Stripe live (producción) — cobro de las suscripciones

La cuenta de Stripe es **la de la plataforma** y cobra la cuota de los tenants (plan + extras). Los tenants que quieran cobrar con tarjeta por Stripe conectan **su propia cuenta** (Stripe Connect, §12D): ese dinero va a su cuenta, no a la tuya. `TENANT_CARD_PAYMENTS_ENABLED` se queda en `false` (no ponerla en Portainer): con ella, los cobros de los tenants sin cuenta conectada irían a la cuenta de la plataforma.

1. **Activar la cuenta** en Stripe (datos fiscales y bancarios) y pasar el dashboard a **modo live**.
2. **Productos y precios**: en Stripe → Product catalog, un producto por plan (Starter, Pro, Administrador) con un precio recurrente mensual y, si se ofrece, otro anual, en EUR. Si los precios de `/admin/plans` son «IVA incluido» (Facturación SaaS → ajustes), el precio de Stripe es el final; si son «+IVA», el precio sin IVA (la app crea sola el TaxRate del IVA y lo añade a las suscripciones nuevas). Copiar cada `price_...` en `/admin/plans` (Stripe Price ID mensual / anual). Los extras no necesitan nada: su precio se crea solo al pasarlos a «Cobrar por Stripe».
3. **Portal de cliente**: Settings → Billing → Customer portal → guardar la configuración en modo live (sin ella el botón «Gestionar suscripción» falla). Permitir actualizar el método de pago, ver facturas y cancelar; no permitir cambiar de plan desde el portal (el cambio lo hace la app).
4. **Claves** → Portainer, variables del servicio **api**: `STRIPE_SECRET_KEY=sk_live_...` y `STRIPE_PUBLISHABLE_KEY=pk_live_...` (el web no necesita nada: el pago se hace en la página de Stripe Checkout).
5. **Webhook** (Developers → Webhooks → Add endpoint), URL `https://api.<dominio>/webhooks/stripe`, eventos:
   - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - `invoice.payment_succeeded`, `invoice.payment_failed`
   - `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`
   - Copiar el **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET` (api).
6. **Nginx Proxy Manager**: la _Custom location_ de `/webhooks/stripe` con `Request body size` ≥ 5MB y sin caché (Stripe firma el cuerpo tal cual).
7. **Redeploy** del stack para que el api coja las variables.
8. **Prueba**: con un tenant de prueba, Ajustes → Suscripción → Suscribirse → pagar. Comprobar en Stripe que la entrega del webhook da `200` y en el panel admin que el tenant pasa a `active` con el periodo, el pago aparece en su pestaña Pagos y se emite su factura. Luego reembolsar desde Stripe y comprobar que la factura recibe su abono.

> Los tenants exentos o con pago manual/SEPA no pasan por Stripe. Un tenant que ya paga por Stripe cambia de plan desde la app (con prorrateo); para pasarlo a transferencia, «Pasar a pago manual» en su ficha.

---

## 12D. Stripe Connect — los tenants cobran con tarjeta en su propia cuenta

Cada tenant conecta su cuenta de Stripe (tipo Express) desde Configuración → Cobros y elige si la tarjeta se cobra con Redsys o con Stripe. Los cobros se hacen **en su cuenta** y la plataforma se queda la comisión (`/admin/payments`, 2 % por defecto).

1. **Activar Connect** en la cuenta de Stripe de la plataforma (Connect → Get started): plataforma de tipo «marketplace/plataforma», cuentas **Express**, país España. Rellenar el perfil de la plataforma (nombre, web, icono y color: es lo que ve el tenant en el registro de Stripe).
2. **Webhook de Connect** (Developers → Webhooks → Add endpoint → «Events on Connected accounts»), URL `https://api.<dominio>/webhooks/stripe-connect`, eventos:
   - `account.updated`, `account.application.deauthorized`
   - `payment_intent.succeeded`, `payment_intent.payment_failed`
   - `charge.refunded`, `charge.dispute.created`
   - Copiar su **Signing secret** → `STRIPE_CONNECT_WEBHOOK_SECRET` (api). Es distinto del de §12C.
3. **Nginx Proxy Manager**: la misma _Custom location_ que `/webhooks/stripe` (cuerpo ≥ 5MB, sin caché) también para `/webhooks/stripe-connect`.
4. **Redeploy** y prueba con un tenant: Configuración → Cobros → «Conectar Stripe» → completar el registro → al volver, «Lista para cobrar» → elegir Stripe → en el portal del inquilino, guardar una tarjeta y pagar una factura. En el panel de Stripe del tenant debe verse el cobro y en el de la plataforma la comisión (Connect → Collected fees).

> Las disputas de un cobro de una cuenta Express las paga la cuenta del tenant, pero si su saldo no cubre la pérdida la responde la plataforma (así funciona Express).

---

## 12E. Redsys con pago por referencia (cobro automático con el TPV del tenant)

Para que la tarjeta guardada en Redsys se cobre sola cada mes:

1. El tenant pide a **su banco** que active en su TPV virtual el **pago por referencia** (también lo llaman «pago con referencia», «tokenización» o COF) y las operaciones **sin el cliente presente (MIT)** por la API REST. Sin eso, Redsys rechaza los cobros automáticos.
2. En Configuración → Cobros → Redsys marca «Pago por referencia» y, en la misma pantalla, el **cobro automático** al emitir (y si quiere, los reintentos).
3. El inquilino, al pagar con tarjeta desde el portal o al firmar la reserva, deja marcada «Guardar mi tarjeta…». A partir de ahí las cuotas se cobran solas; si el banco la rechaza o caduca, el cobro queda fallido, el inquilino recibe el aviso y entra el proceso de impago.

No hay variables nuevas en producción (el endpoint REST de Redsys sale del entorno test/live del tenant).

---

## 13. Observabilidad (mínima)

- **Sentry**: definir `SENTRY_DSN` en `.env.prod` (misma variable para `api` y `worker`; ambos la leen en su `instrument.ts`). Sin DSN, Sentry es un no-op. El API reporta los errores 5xx desde `HttpExceptionFilter`; el worker captura unhandled rejections/exceptions. Opcional: `SENTRY_TRACES_SAMPLE_RATE` (default `0`, solo errores).
- **Uptime Kuma**: contenedor adicional monitoreando `https://app.tu-dominio.com`, `https://api.tu-dominio.com/health/ready` y `https://api.tu-dominio.com/health/worker`. `/health/ready` comprueba Postgres + Redis (503 con `details` si algo cae); `/health/worker` comprueba el heartbeat que el proceso de workers escribe en Redis cada minuto (503 `worker_stale` si lleva >3 min sin latir — worker caído o colgado, los crons no corren). `/health` es solo liveness.
- **Colas BullMQ**: página `/admin/queues` del panel super admin con counts por cola (waiting/active/failed/...) y los últimos jobs fallidos con su motivo. Los failed se retienen 30 días en Redis.
- **Logs**: `docker compose ... logs -f api` para inspección puntual, o el stack Loki + Grafana de abajo para agregación + dashboards + alertas.

### 13.1 Loki + Grafana + Promtail (logs agregados + dashboards + alertas)

Stack **autohospedado y opcional** (perfil `observability`, apagado por defecto). Los logs no salen del VPS. Config versionada en [`observability/`](../observability/) (ver su `README.md`).

- **Qué hace**: Promtail descubre los contenedores por el socket de Docker y envía sus logs a Loki, etiquetados por servicio (`api`/`worker`/`web`). Grafana provisiona automáticamente datasources (Loki + Postgres), el dashboard **TrasterOS — Overview** y dos reglas de alerta.
- **Dashboard**: volumen de logs por servicio, errores API/worker (24h), violaciones CSP (24h), intentos de login fallidos (sobre `security_events`), top emails/IP con login fallido, y logs de errores + violaciones CSP recientes.
- **Alertas por email** (contact point provisionado, reutiliza tu SMTP):
  - _Pico de violaciones CSP_ — > 50 en 5 min.
  - _Pico de errores API/worker_ — > 20 logs de error en 5 min.
  - El brute-force de login ya lo alerta `SecurityAlertsService` por separado; Grafana añade visibilidad histórica.
- **Activar**:
  - Compose directo: `docker compose -f docker-compose.prod.yml --profile observability up -d`.
  - Portainer: añade `COMPOSE_PROFILES=observability` en la sección Environment del stack y vuelve a desplegar.
- **Exponer Grafana**: Proxy Host en NPM (`grafana.tu-dominio.com` → `grafana:3000`). **No** publiques Loki ni Promtail.
- **Variables nuevas** (Portainer / `.env.prod`): `GF_ADMIN_PASSWORD` (obligatoria), `GF_SERVER_ROOT_URL`, `GF_ALERT_EMAIL` (cae a `SECURITY_ALERT_EMAIL`), y para que envíe emails `GF_SMTP_ENABLED=true` + `GF_SMTP_HOST` + `GF_SMTP_USER` + `GF_SMTP_PASSWORD` + `GF_SMTP_FROM_ADDRESS`. El datasource Postgres reutiliza `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` (solo `SELECT`).
- **Coste**: ~300-500 MB RAM extra. Si el VPS va justo, deja el perfil apagado y usa `logs -f` puntual.

---

## 15. Activar WhatsApp Business (Meta Cloud API)

El envío de WhatsApp (recordatorios de dunning, avisos) usa el `WhatsAppProvider` abstracto. En dev/test el provider es `stub` (solo loggea). Para enviar de verdad:

1. **Alta en Meta**: crear una app en [Meta for Developers](https://developers.facebook.com/) con el producto **WhatsApp**, asociar un **número de teléfono de empresa** y obtener su `Phone number ID`.
2. **Token permanente**: generar un _System User_ con un token de acceso permanente con permisos `whatsapp_business_messaging`.
3. **Variables** (Portainer / `.env.prod`):
   - `WHATSAPP_PROVIDER=meta_waba`
   - `WHATSAPP_FROM_PHONE_ID=<phone number id>`
   - `WHATSAPP_ACCESS_TOKEN=<token permanente>`
   - Redeploy del `api` (y `worker`).
4. **Plantillas aprobadas (clave)**: los mensajes **iniciados por el negocio** (dunning, avisos proactivos) SOLO se pueden enviar con una **plantilla aprobada** por Meta — el texto libre únicamente vale dentro de la ventana de 24h tras un mensaje del cliente. Da de alta y aprueba las plantillas en _WhatsApp Manager → Plantillas_ antes de usarlas.
5. **Conectar la plantilla WABA a una `message_template`** (Layer B): en la plantilla de TrasterOS del canal `whatsapp`, rellena por API (`PATCH /v1/message-templates/:id`):
   - `whatsappTemplateName`: nombre exacto de la plantilla aprobada en Meta.
   - `whatsappTemplateLanguage`: código de idioma (e.g. `es`).
   - `whatsappTemplateVariables`: lista **ordenada** de nombres de variable que mapean a los parámetros posicionales `{{1}}`, `{{2}}`… de la plantilla.
     Al encolar un envío `whatsapp` con esa plantilla, el outbox snapshotea nombre/idioma y resuelve los parámetros posicionales, y `MetaWabaProvider` envía por plantilla. Sin `whatsappTemplateName` se envía como texto libre (solo válido dentro de la ventana de 24h).

> Estado: provider real (`MetaWabaProvider`) + selección por `WHATSAPP_PROVIDER` + envío por plantilla aprobada conectado al outbox y a `message_templates` (Layer B). Tests: `meta-waba-provider.spec` 4/4 + `whatsapp-template-util.spec` 3/3. Pendiente menor: editor de plantillas en el panel (hoy los campos WABA se fijan por API/seed; el catálogo del frontend es de solo lectura).

---

## 16. Integración contable Holded

Copia contable de las facturas en el Holded de cada tenant (no requiere variables de entorno; la API key se configura por tenant desde el panel). **TrasterOS emite las facturas y las registra en Veri\*Factu; Holded solo las contabiliza.** Usa la API v2 de Holded (`https://api.holded.com/api/v2`, `Authorization: Bearer`): la v1 está obsoleta y las claves nuevas (`pat_…`) solo funcionan con la v2.

1. En Holded: **Configuración → Numeración** → crear una serie de **facturas** y otra de **rectificativas** solo para TrasterOS y marcarlas **«No enviar a Verifactu»**. Imprescindible: si Holded enviara también estas facturas, quedarían registradas dos veces en la AEAT.
2. En Holded: **Configuración → Desarrolladores → API** → crear una API key (`pat_…`).
3. En TrasterOS: **Ajustes → Facturación → Contabilidad — Holded** → pegar la API key y **Guardar** → elegir las dos series (solo se pueden elegir las marcadas «No enviar a Verifactu»; el API lo comprueba contra Holded y rechaza las demás con `holded_series_not_excluded`) → marcar «Copiar las facturas a Holded automáticamente» → **Guardar** → **Probar conexión**.
4. Hasta que haya una serie de facturas elegida **no se envía nada** (la tarjeta lo indica).

Qué se copia:

- **Factura emitida** → factura aprobada en la serie elegida, con el contacto (buscado por NIF/email o creado) y cada línea con la clave de IVA de Holded de su porcentaje (`s_iva_21`, …). El **número legal de TrasterOS** va en la descripción y en las notas internas (en Holded el número es el de su serie).
- **Simplificada (F2, sin cliente)** → al contacto genérico «Clientes varios (facturas simplificadas)».
- **Rectificativa con importe negativo** → rectificativa (credit note) en la serie de rectificativas, indicando la factura que rectifica. Sin esa serie no se copia (queda el error en la tarjeta).
- **Cobro** → pago registrado en la factura de Holded (`payments.holded_synced_at` evita duplicarlo).
- **Anulación** → factura cancelada en Holded (`invoices.holded_cancelled_at`).

> La API key se guarda **cifrada** (AES-256-GCM) en `holded_settings`. La copia es best-effort sobre los eventos de factura emitida/cobrada/anulada; los fallos quedan en «Último error» y se reintentan con **«Enviar pendientes»** (facturas sin copiar, cobros y anulaciones pendientes) o con el botón de cada factura. Las anulaciones que lanza el worker (bookings impagados) se recogen con «Enviar pendientes».

## 17. Pago con tarjeta — Redsys (TPV bancario)

Permite a los inquilinos pagar facturas con tarjeta vía la pasarela alojada del banco. Config por tenant (no requiere variables salvo `API_BASE_URL`).

1. **`API_BASE_URL`** (variable de entorno del API): URL pública del API, p. ej. `https://api.tu-dominio.com`. Redsys envía ahí la notificación servidor-a-servidor (`/webhooks/redsys`).
2. En TrasterOS: **Ajustes → Facturación → Pago con tarjeta — Redsys** → introducir **código de comercio (FUC)**, **terminal**, **clave secreta** del comercio (la da el banco), **entorno** (Pruebas/Producción) y activar. La clave se guarda **cifrada** (AES-256-GCM).
3. El inquilino paga desde su **portal** ("Pagar con tarjeta") o el staff desde la factura ("Pagar con Redsys"): se genera un formulario firmado (`HMAC_SHA256_V1`) y el navegador se redirige a la pasarela del banco.
4. Al completar el pago, Redsys hace POST a `/webhooks/redsys`; TrasterOS **verifica la firma** y marca la factura pagada (idempotente). El cliente vuelve a `/pay/redsys/ok` o `/pay/redsys/ko`.

> En el panel del banco/Redsys hay que configurar la **clave secreta del comercio** y, si aplica, la URL de notificación. Entorno de pruebas: `sis-t.redsys.es`; producción: `sis.redsys.es` (lo elige el campo "entorno"). Verificación de firma + flujo testeados (`redsys-signature` 5/5, `redsys.e2e` 4/4); el pago real se valida en el entorno de pruebas del banco.

---

## 18. Dominio propio por tenant (white-label)

Un tenant del plan **`pro`** (o con la feature `custom_domain` activada por override) puede servir su web pública bajo **su propio dominio** (`trasteros-garcia.com`) en vez de `app.tu-dominio.com/s/garcia`. La landing, las páginas por local y la reserva (`/reservar`, o `/reservar/<centro>` con el local ya elegido, p. ej. `/reservar/mislata`; en inglés `…/l/en`) se sirven bajo su marca, y hay direcciones fijas para campañas (Google Ads): `/precios` y `/contacto` (la web de una página bajando sola a esa sección, con título propio) y `/<local>` (la página de cada local); el panel del staff y el portal siguen en el dominio de la plataforma.

**Cómo funciona**: el middleware del web (`apps/web/src/middleware.ts`) mira la cabecera `Host`. Si no es el de la plataforma (`NEXT_PUBLIC_SITE_URL`), consulta `GET /public/landing/resolve-domain?host=<host>` (con caché 60 s); si el dominio está **verificado**, reescribe internamente `/` → `/s/<slug>` (la URL del usuario queda limpia) y redirige el panel/admin al dominio de la plataforma. El CORS del API permite además los dominios verificados.

### 18.1 Flujo de alta (por dominio)

1. **El tenant** introduce su dominio en **Ajustes → Marca del portal y la web pública → Dominio propio** (`/settings/branding`). Queda **pendiente de activación** (`custom_domain_verified_at` nulo). Requiere el plan/feature (si no, 403).
2. **El tenant** crea en su proveedor de DNS un registro que apunte su dominio al VPS:
   - `A` → la IP pública del VPS (recomendado para el dominio raíz), o
   - `CNAME` → `app.tu-dominio.com` (para un subdominio como `www.` o `reservas.`).
3. **El super admin**, cuando el DNS ya resuelve al VPS, crea el **Proxy Host en NPM** para ese dominio:

   | Domain                 | Scheme | Forward Hostname | Forward Port | Cache | Block Common Exploits | Websockets |
   | ---------------------- | ------ | ---------------- | ------------ | ----- | --------------------- | ---------- |
   | `trasteros-garcia.com` | http   | `web`            | 3000         | yes   | yes                   | yes        |

   Pestaña **SSL** → Request a new SSL Certificate (Let's Encrypt) + Force SSL + HTTP/2. **No** hace falta un Proxy Host para el API: el navegador del inquilino llama al `api.tu-dominio.com` de siempre (el CORS ya permite el dominio custom una vez verificado).

4. **El super admin** entra en **`/admin/custom-domains`** (menú → Tenants → Dominios propios), comprueba el dominio en la lista de pendientes y pulsa **Activar**. A partir de ahí, `resolve-domain` lo resuelve y la web del tenant se sirve bajo su dominio (propagación ≤ 60 s por la caché del middleware).

Para desactivarlo: botón **Desactivar** en `/admin/custom-domains` (o el tenant lo borra en su branding). El dominio deja de servirse en ≤ 60 s.

### 18.2 Requisitos e infra

- **No hay wildcard posible** (son dominios de terceros): cada dominio necesita su propio Proxy Host + certificado Let's Encrypt. Let's Encrypt limita a ~50 certificados por semana y por dominio registrable — suficiente para el alta manual.
- El certificado **solo emite si el DNS ya resuelve al VPS**; por eso el flujo es pending → (DNS + NPM) → activar. Si NPM falla al emitir el certificado, casi siempre es que el DNS aún no ha propagado (esperar y reintentar).
- El dominio se guarda en minúsculas y es **único** a nivel de plataforma (409 `domain_taken` si otro tenant lo reclama).

### 18.3 Troubleshooting

- **La web del tenant carga la landing de la plataforma / 404**: el dominio no está verificado (`/admin/custom-domains` → Activar) o el Host no llega bien (revisar el Proxy Host y que `NEXT_PUBLIC_SITE_URL` sea el dominio de plataforma, no el custom).
- **CORS bloquea las llamadas al API desde el dominio custom**: el dominio no está verificado (el CORS solo permite los `custom_domain_verified_at` no nulos) — activar y esperar ≤ 5 min (caché del CORS).
- **Cambió el dominio y dejó de funcionar**: cambiar el dominio en el branding **resetea la verificación** → hay que reconfigurar el Proxy Host + reactivar.

> **Pendiente (v2)**: automatizar la creación del Proxy Host + certificado vía la API de NPM al activar, y verificación DNS por registro TXT sin intervención del admin. El email saliente sigue usando el dominio de la plataforma (SPF/DKIM por tenant es un bloque aparte).

---

## 19. Dominio de producción de la PLATAFORMA (`trasteros.pro`) + checklist de cambio de dominio

> Desde 2026-07-16 la plataforma vive en **`trasteros.pro`** (web) y
> **`api.trasteros.pro`** (API). Esta sección documenta el checklist completo
> para un cambio de dominio de plataforma y los 2 gotchas que costaron el
> primer despliegue.

### 19.1 DNS + Nginx Proxy Manager

Por cada hostname hace falta **su registro A y su Proxy Host con certificado
propio** (NPM emite un cert por hostname, no wildcard):

| Hostname            | A →        | Proxy Host (Scheme http) | SSL                       |
| ------------------- | ---------- | ------------------------ | ------------------------- |
| `trasteros.pro`     | IP del VPS | `web:3000`               | Let's Encrypt + Force SSL |
| `api.trasteros.pro` | IP del VPS | `api:3001`               | Let's Encrypt + Force SSL |

### 19.2 Variables del stack (Portainer)

| Variable                 | Valor                                                | Nota                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_API_URL`    | `https://api.trasteros.pro`                          | **Origen pelado, SIN `/v1`** (el frontend lo añade). ⚠️ Build-time, ver 19.3                                                                                 |
| `NEXT_PUBLIC_SITE_URL`   | `https://trasteros.pro`                              | Canonical/OG/sitemap. ⚠️ Build-time                                                                                                                          |
| `MINIO_PUBLIC_URL` (web) | el mismo que el API                                  | Fotos de las webs optimizadas (`next/image`, AVIF/WebP por tamaño de pantalla). El compose se lo pasa al build del web; vacío = sin optimizar. ⚠️ Build-time |
| `WEB_BASE_URL`           | `https://trasteros.pro`                              | Enlaces en emails                                                                                                                                            |
| `API_BASE_URL`           | `https://api.trasteros.pro`                          | Notificaciones Redsys / URLs absolutas                                                                                                                       |
| `ALLOWED_ORIGINS`        | `https://trasteros.pro`                              | CORS del API                                                                                                                                                 |
| `COOKIE_DOMAIN`          | `.trasteros.pro`                                     | Cookie de refresh                                                                                                                                            |
| `COOKIE_SAMESITE`        | `lax`                                                | Web y API comparten dominio raíz (same-site)                                                                                                                 |
| `COOKIE_SECURE`          | `true`                                               | HTTPS                                                                                                                                                        |
| `MINIO_PUBLIC_URL`       | `https://files.trasteros.pro` (o el que sirva MinIO) | URLs públicas de ficheros                                                                                                                                    |

Tras cambiarlas: **reiniciar api y worker** (las leen en runtime).

> **`MINIO_PUBLIC_URL` es también la URL con la que se firman las subidas y descargas del navegador** (planos, fotos, documentos, PDFs privados). Debe ser **https**, apuntar a la raíz de MinIO (Proxy Host en NPM, p. ej. `files.trasteros.pro` → `minio:9000`, sin ruta extra) y el proxy debe reenviar el `Host` original (NPM lo hace por defecto). Si falta o apunta a otro sitio, el navegador intenta subir a `http://minio:9000/…` y la CSP lo bloquea («violates … connect-src»).

### 19.3 ⚠️ Gotcha 1 — `NEXT_PUBLIC_*` se hornean en el bundle en `next build`

Las `NEXT_PUBLIC_*` son **build-args del Dockerfile del web** (quedan inline en
el JS del cliente). Cambiarlas en Portainer **NO afecta al contenedor en
marcha**: hay que **reconstruir la imagen del web** (redeploy con pull efectivo
— el webhook de deploy ya invalida la capa `COPY`; si no hay commits nuevos,
forzar el rebuild o hacer un commit trivial). **Síntoma** de bundle viejo: la
web carga pero el login «no hace nada» y en el log del API **solo aparecen
`/health`** (las peticiones van al dominio antiguo — verificar en la pestaña
Network del navegador la Request URL real del `POST /v1/auth/login`).

### 19.4 ⚠️ Gotcha 2 — `ERR_SSL_UNRECOGNIZED_NAME_ALERT` en el login

Si el navegador da `net::ERR_SSL_UNRECOGNIZED_NAME_ALERT` al llamar a
`api.<dominio>`: **nginx no tiene vhost 443 para ese hostname** → el
certificado del subdominio `api` **no está emitido/asignado** en NPM (típico:
se creó el Proxy Host pero la pestaña SSL quedó en «None», o la emisión falló
en silencio). Diagnóstico:

```bash
dig +short api.trasteros.pro          # ¿resuelve a la IP del VPS?
curl -I http://api.trasteros.pro/.well-known/acme-challenge/test
#   → 404 con "Server: openresty" = el challenge HTTP-01 SÍ llega a NPM
openssl s_client -connect api.trasteros.pro:443 -servername api.trasteros.pro </dev/null \
  | openssl x509 -noout -subject      # debe decir CN=api.trasteros.pro
```

Arreglo: Proxy Host de `api.<dominio>` → pestaña SSL → **Request a new SSL
Certificate** + Force SSL. Resuelto cuando el `openssl s_client` devuelve el
subject correcto y `curl -I https://api.<dominio>/health` da 200.

### 19.5 Post-cambio (SEO)

- **Google Search Console**: verificar el dominio nuevo + enviar
  `https://trasteros.pro/sitemap.xml` (dispara la indexación de la landing y
  las páginas públicas `/s/<tenant>`).
- **Bing Webmaster Tools**: mismo sitemap.
- **Google Business Profile** de TrasterOS (categoría «Empresa de software»).

---

## 20. Cobro de la suscripción SaaS por SEPA directo (BBVA)

Distinto de §12B/§17 (esos son cobros del TENANT a sus inquilinos). Esto es
**nosotros cobrando la cuota a los tenants**, como alternativa a Stripe sin
su comisión — ver `CLAUDE.md` → sesión de cobro SaaS por SEPA (PRs
#503-#505) para el diseño completo.

1. **Configurar el acreedor** (una sola vez, panel super admin → `Config.
de plataforma → SEPA (BBVA)`, ruta `/admin/platform-sepa`): nombre del
   acreedor, **identificador de acreedor SEPA** (lo asigna el Banco de
   España al dar de alta el CSB de la cuenta), **IBAN de la cuenta BBVA**,
   BIC, y activar. El IBAN se guarda cifrado (AES-256-GCM); es una fila
   **única** para todos los tenants en modo SEPA — cambiar de banco más
   adelante es editar esta misma pantalla, sin tocar nada por tenant.
2. **Pasar un tenant a modo SEPA**: el tenant da de alta su propio mandato
   (IBAN de su empresa) desde `Ajustes → Suscripción` en su panel — nunca
   lo crea el super admin en su nombre. Con el mandato activo, desde la
   ficha del tenant (`/admin/tenants/:id`) el botón «Pasar a SEPA» cambia
   su `billingMode`.
3. **Generar y subir la remesa** (`/admin/platform-sepa/remittances`):
   «Nueva remesa» → previsualiza los tenants elegibles (periodo a ≤5 días
   vista, D+2 mínimo de SEPA CORE) → «Generar remesa» → «XML» descarga el
   fichero pain.008.001.02 → **subirlo a mano a la banca online de
   empresa de BBVA** (no hay API pública de domiciliación entre bancos
   españoles, es el mismo patrón que las remesas SEPA del tenant a sus
   inquilinos).
4. **Confirmar el cobro** cuando el banco liquide (2-5 días hábiles
   típico): botón «Confirmar cobro» en la remesa — extiende el periodo de
   cada tenant (mismo mecanismo que un pago manual) y rota sus mandatos de
   `FRST` a `RCUR`.
5. **Si el banco devuelve un adeudo** (R-transaction, cuenta cerrada/sin
   fondos/etc.): en el detalle de la remesa confirmada, «Marcar como
   devuelto» sobre el item afectado — el tenant vuelve a `past_due` y el
   dunning de plataforma ya existente (`/admin/platform-dunning`) lo
   recoge sin configuración adicional.

Sin variables de entorno nuevas: toda la config vive en BD, gestionada
desde el panel.

---

## 21. Facturas de suscripción y exportación para la asesoría

**Datos obligatorios** (art. 6 del Reglamento de facturación): la app pone número, serie, fechas, desglose e IVA; faltan solo los datos que rellena alguien.

1. **Emisor** — panel admin → Facturación SaaS → «Datos del emisor»: razón social, NIF/CIF (se valida el dígito de control), dirección, código postal y población. Sin ellos no se puede activar la facturación (400 `platform_billing_incomplete`).
2. **Destinatario (cada tenant)** — razón social, NIF y domicilio fiscal: el propio tenant los rellena en Ajustes → Suscripción → «Datos de facturación», o el super admin en la ficha del tenant → Editar. Si al cobrar faltan, la factura se emite igual (el cobro ya está hecho), queda marcada «(incompleta)» y llega una notificación al super admin. La ficha del tenant avisa antes.

**Rectificar una factura de suscripción** — ficha del tenant → Pagos → «Facturas de suscripción» → «Rectificar»:

- **Datos del cliente** (sustitución): emite una rectificativa con los mismos importes y los datos fiscales **actuales** del tenant (complétalos antes); la original queda «Sustituida». Una sola sustitución por factura.
- **Importe** (abono): rectificativa en negativo, parcial o total; si se abona todo, la original queda «Abonada». El reembolso del dinero, si procede, se hace aparte.
- Serie propia (`SAAS-R-<año>-0001`), tipo R4 por defecto (R1 si es un error fundado en derecho), motivo obligatorio; se envía al tenant por email y aparece en su panel y en la exportación de la asesoría con la factura que rectifica. Aún no se copian a Holded.

**Exportación para la asesoría** — panel admin → Facturación SaaS → «Exportación para la asesoría»:

- En «Negocio propio» se indica el identificador (slug) de la empresa con la que la propia SL alquila trasteros. Sus facturas a inquilinos se suman a las de suscripción.
- Se elige año y periodo (año, trimestre o mes). Se ve un resumen (facturas, base, IVA, cobrado) y las facturas sin datos obligatorios.
- Descargas:
  - **Excel**: dos hojas, facturas y cobros.
  - **CSV**: uno por tabla, con `;` y coma decimal.
  - Facturas: una fila por factura y tipo de IVA, con columna «Actividad» (Suscripciones / Negocio propio), tipo, factura rectificada, NIF, cliente, domicilio, base, cuota y totales.
  - Cobros: fecha, factura, cliente, importe, forma de cobro y referencia. Las devoluciones aparecen en negativo.
- El asesor configura el formato una vez en el importador de su programa y lo reutiliza cada periodo.

**Copia en Holded de las facturas de suscripción (opcional)** — panel admin → Facturación SaaS → «Copia en Holded». Viene desactivada; no envía nada hasta que la actives.

1. En Holded, crea una serie de facturas solo para las suscripciones (p. ej. `SUS-`), distinta de la de tu negocio de trasteros, y márcala **«No enviar a Verifactu»**.
2. Pega la API key (`pat_…`), guarda, elige esa serie y activa. La app comprueba la marca contra Holded: una serie que se envía a Verifactu no se puede elegir.
3. Cada factura de suscripción nueva se copia a Holded aprobada y con su cobro. El número legal va en la descripción.
4. Las facturas emitidas antes de activarla se envían con «Enviar pendientes».

## 14. Pendiente (Fase 8D)

- Pipeline CI/CD con GitHub Actions construyendo imágenes a GHCR y desplegando vía SSH.
- Staging dedicado (`develop` branch → `staging.tu-dominio.com`).
- ~~Loki + Grafana para logs agregados.~~ ✅ Implementado — perfil `observability` (ver §13.1).
- Política formal de rotación de secretos cada 90 días.
- Runbook de recuperación ante desastre (RTO/RPO documentados).

## 22. Antes de activar la facturación real (Veri\*Factu en producción)

1. **Negocio propio**: en el panel admin → Facturación SaaS, «Negocio propio» = identificador del tenant de TrasterOS SL (mismo NIF que el emisor). Sin él y con `AEAT_MODE` real, las facturas de suscripción no se emiten (`own_tenant_required`). Recomendado: marcarlo como **exento de facturación**.
2. **Certificados**: cada tenant que emita desde la app sube el suyo en Ajustes → Facturación → Veri\*Factu (incluido el negocio propio). Sin certificado, emitir en modo real da `aeat_certificate_required`.
3. **Modo de emisión**: cada tenant elige app o Holded en Ajustes → Facturación (bloqueado durante el año natural si ya emitió).
4. **Stripe**: configurar según §12C (el TaxRate del IVA, con precios «+IVA», lo crea la app sola; el webhook debe llevar `charge.dispute.closed` además de `charge.refunded` y `charge.dispute.created`).
5. **Variables**: `TENANT_CARD_PAYMENTS_ENABLED` (por defecto `false`, déjalo así mientras no haya Stripe Connect) y `RETENTION_SEPA_PRENOTICE_DAYS` (430 por defecto).
6. Las facturas emitidas antes de la cadena nueva (2026-10-05) llevan la huella antigua: revisarlo con la asesoría antes del primer envío real.

## 23. Tras desplegar las novedades de octubre de 2026 (#617–#656)

1. **Migraciones**: el redespliegue aplica las de `20261007100000` a `20261014100000` (todas aditivas). El bootstrap crea el plan **Administrador** y el extra **Viviendas**.
2. **Panel admin → Planes**: revisar el precio del plan Administrador (349 €/mes, 3.490 €/año) si en la instancia viva se editan los precios a mano.
3. **Panel admin → Web de TrasterOS**: poner el **email que recibe el formulario de contacto** (sin él no se muestra), revisar el pie (enlaces, teléfono, dirección, redes), subir el logo si se quiere otro y decidir si se muestra la oferta fundador (desactivada por defecto).
4. **Tareas programadas**: la tabla de Sistema y colas se llena cuando arrancan el API y el worker con esta versión.
5. **Almacenamiento por tenant**: se mide de madrugada; para verlo antes, «Medir ahora» en Uso por tenant.
6. **Coste de la IA**: opcionalmente `AI_COST_INPUT_PER_MTOK_USD` / `AI_COST_OUTPUT_PER_MTOK_USD` (3 y 15 por defecto) para el coste estimado en Uso por tenant.
7. **Pendiente de la asesoría**: confirmar si las facturas con retención de IRPF salen del modelo 347 y cómo copiar la retención a Holded.
8. **SEO de la web** (Web de TrasterOS → SEO de la web): dar de alta trasteros.pro en **Google Search Console** y **Bing Webmaster Tools** con la «etiqueta HTML», pegar los códigos, guardar y, cuando verifiquen, enviar `https://trasteros.pro/sitemap.xml`. Si se pone el ID de Google Analytics 4, añadirlo a la Política de Cookies (Comunicación → Páginas legales).

## 24. WhatsApp Business de los tenants (extra)

> Migraciones `20261016100000_tenant_web_seo` → `20261022100000_whatsapp_conversation_language` (aditivas). Redesplegar **API, web y worker** (el worker ejecuta el recordatorio de reservas y la limpieza de conversaciones).

1. **Migración** `20261017100000_whatsapp_business` (aditiva). El bootstrap crea el extra **WhatsApp Business** (29 €/mes, editable en `/admin/addons`).
2. **App de Meta**: la misma que recibe el webhook `https://api.trasteros.pro/webhooks/whatsapp` (suscrita al campo `messages`). Hacen falta `WHATSAPP_VERIFY_TOKEN` y **`WHATSAPP_APP_SECRET`** en el API (sin el secreto, en producción el webhook rechaza todo).
3. **Cada tenant** (con el extra activo) pega en Configuración → Comunicación → WhatsApp el ID de su número y un token permanente; al activarlo se comprueba contra Meta. Los mensajes a su número entran en su bandeja (menú Mensajería → WhatsApp) y quien no es inquilino se crea como contacto con origen «whatsapp».
4. **No poner** `WHATSAPP_BUSINESS_MODE=stub` en producción (simula los envíos).
5. **Número en la app de Meta del propio tenant** (hasta tener el alta con coexistencia): en Configuración → WhatsApp → «Si usas tu propia app de Meta» se le muestran la URL del webhook y un **token de verificación propio**, y pega la **clave secreta de su app**. En su app configura el webhook de WhatsApp con esos datos y lo suscribe a `messages`; los avisos firmados con su secreto se aceptan solo para sus números. Sin la clave secreta, sus avisos se rechazan. **Limitación conocida**: el número conectado así deja de funcionar en la app de WhatsApp del móvil.
6. **Asistente de IA** (migración `20261018100000_whatsapp_assistant`): en el panel admin → Comunicación → **IA de WhatsApp** elegir proveedor, modelo y clave, el límite de respuestas al mes por tenant (300 por defecto) y activarla; «Probar» hace una llamada real. Es una IA distinta de la del asistente del panel (`ANTHROPIC_API_KEY`). En la ficha de cada tenant se elige «IA de TrasterOS» o «su propia clave» y, si hace falta, otro límite. Si el proveedor está fuera de la UE (p. ej. MiniMax), recogerlo en la política de privacidad y en el contrato de encargo con los tenants.
7. **Reservas y recordatorios** (migración `20261019100000_whatsapp_bookings`): el asistente prepara reservas (desactivable por tenant). Para recordar por WhatsApp las reservas sin terminar pasadas 24 h, cada tenant crea en su WhatsApp Manager una plantilla con {{1}} = nombre y {{2}} = enlace, espera a que Meta la apruebe y pone su nombre en Configuración → WhatsApp. El recordatorio corre en el **worker** cada hora.
8. **Privacidad y revisión de Meta** (migración `20261020100000_whatsapp_privacy_url`): en la app de Meta (Configuración básica) poner como **URL de la política de privacidad** `https://trasteros.pro/privacidad` y como **URL de instrucciones de eliminación de datos** `https://trasteros.pro/eliminar-datos`. Los textos por defecto ya llevan el apartado de WhatsApp e IA y las instrucciones de borrado; **si la política de privacidad ya se había guardado en `/admin/legal`, la versión guardada manda**: añadir a mano el apartado «WhatsApp y asistente automático» (o copiarlo del texto por defecto). La primera respuesta del asistente en cada conversación avisa de que es automática y, si el tenant pone su política en Configuración → WhatsApp, la enlaza. Las conversaciones se borran tras `RETENTION_WHATSAPP_DAYS` (365) sin movimiento.
9. **Archivos y plantillas** (migraciones `20261021100000_whatsapp_media` y `20261022100000_whatsapp_conversation_language`): las fotos, audios, vídeos y documentos que envían los contactos se descargan de Meta con el token del tenant y se guardan en el bucket privado `uploads` (`<tenant>/whatsapp/<conversación>/…`); se borran al anonimizar y con la limpieza por antigüedad. Para elegir las plantillas aprobadas de una lista, cada tenant pone el **ID de su cuenta de WhatsApp Business** en Configuración → WhatsApp. Probarlo con el número de prueba de Meta (foto, audio y PDF en ambos sentidos).

## 25. Tras desplegar cobro con tarjeta, cupones y landings (#674–#691)

> Migraciones `20261023100000_whatsapp_own_app` → `20261026140000_promo_landing_tracking` (aditivas). Redesplegar **API, web y worker**.

1. **Stripe Connect** (si el tenant va a cobrar por su Stripe): activar Connect en la cuenta de Stripe de la plataforma y crear el endpoint **«Connect»** `https://api.trasteros.pro/webhooks/stripe-connect` con sus eventos (§12C/§12D); poner su secreto en **`STRIPE_CONNECT_WEBHOOK_SECRET`**. `TENANT_CARD_PAYMENTS_ENABLED` sigue en `false`. **No** poner `STRIPE_CONNECT_MODE=stub`.
2. **Comisión de la plataforma**: panel admin → Facturación → «Cobros de los tenants» (2 % por defecto).
3. **Redsys con pago por referencia** (§12E): el banco del tenant tiene que tener activado el pago por referencia (COF) en su TPV; el tenant marca la casilla en Configuración → Cobros. **No** poner `REDSYS_MODE=stub`.
4. **Cupones y landings**: sin configuración de plataforma. Las landings solo se ven con Web Premium; con dominio propio la dirección es `/promo/<nombre>`. Probar una landing con un enlace corto de un flyer y una reserva con cupón hasta el pago.

## 26. Límites de peticiones de las webs públicas (INTERNAL_API_TOKEN)

Las páginas públicas (webs de los tenants, reserva, firma, landings) se generan en el servidor del web, que pide los datos al API. Sin configurar nada, todas esas peticiones llegan al API desde la misma IP y comparten un único límite (30-120/min según el endpoint): con tráfico, la reserva muestra «no disponible» y alguna web da 404.

1. Generar un secreto: `openssl rand -hex 32`.
2. En Portainer → stack → Environment, añadir **`INTERNAL_API_TOKEN`** con ese valor (lo usan el API y el web; el compose ya pasa `INTERNAL_API_URL=http://api:3001` al web).
3. Redesplegar. Comprobar que la web de un tenant y `/book/<slug>` cargan.

Sin la variable todo funciona como antes (URL pública, con límite compartido). Con `docker-compose.prod.yml`, ponerla en `apps/api/.env.production` y en el `.env` del compose.

## 27. Tras desplegar la revisión de la web pública (#705–#712)

- **Migración** `20261028100000_tenant_web_legal` (la aplica el api al arrancar).
- El web se construye con **`MINIO_PUBLIC_URL`** como argumento de build (fotos optimizadas por `/_next/image`, solo de ese dominio). La variable ya existe en Portainer; basta con redesplegar el web con pull efectivo. Si las fotos de la web salen rotas, el build no la recibió.
- Comprobar: pie de la web de un tenant con «Aviso legal · Privacidad · Cookies»; con GA4, el aviso de cookies y que Google no carga hasta aceptar; Configuración → Textos legales avisa si faltan NIF o domicilio (Suscripción → Datos de facturación).
- `/l/en` en una plantilla propia, una ficha de local con el aspecto de su plantilla, `/trasteros-en-<ciudad>` en un tenant con varios locales y `/sitemap.xml` con las versiones en inglés y las landings indexables.

## 28. Tras desplegar las mejoras del panel super admin (#718–#725)

- **Migraciones** `20261029100000_impersonation_read_only`, `20261029120000_platform_chat_alerts` y `20261029140000_admin_approval_requests` (las aplica el api al arrancar). Redesplegar **api y web** con pull efectivo.
- Comprobar con un super admin de rol `support`: los botones de cobros y configuración global aparecen desactivados y en la ficha de un tenant sale «Pedir aprobación»; la solicitud aparece en «Hoy» del super admin con Aprobar / Rechazar.
- Impersonación: abrir un tenant → ⋮ → Impersonar (solo lectura marcado) → entra en el panel del tenant con el banner; «Salir de la sesión de soporte» vuelve a la pantalla de fin.
- **Avisos por chat (opcional)**: panel admin → Comunicación → Alertas → «Avisos por Telegram y Slack». Telegram: crear un bot con @BotFather, añadirlo al grupo o canal y pegar su token y el id del chat. Slack: crear un webhook entrante y pegar su URL. «Enviar prueba» y activar el aviso diario y/o el resumen semanal. No necesita variables de entorno.

## 29. Tras desplegar la revisión de pagos y suscripciones (#727–#732)

- **Migración** `20261030100000_platform_sepa_retry_bounced` (la aplica el api al arrancar). Redesplegar **api y web** con pull efectivo.
- **Pruebas vencidas**: al día siguiente del despliegue, el cron `tenant-lifecycle.daily` (08:00) pasa al plan Free todas las pruebas ya vencidas que no pagan (antes nadie lo hacía). Si alguna debe seguir probando, ampliarle la prueba **antes** desde su ficha. Con «Recordatorios de prueba» activados en Alertas, sus propietarios reciben el correo «Tu prueba de TrasterOS ha terminado».
- **Suscripciones de Stripe ya canceladas**: las que quedaron `cancelled` antes de este cambio no se tocan solas (el arreglo actúa al llegar el aviso). Revisar en Tenants las de estado de suscripción «Cancelada» y pasarlas a Free con «Cambiar plan».
- **Comprobación**: con Stripe live, cambiar de plan desde Ajustes → Suscripción y, tras unos segundos, confirmar en la ficha del tenant que el plan sigue siendo el nuevo.

## 30. Tras desplegar el análisis completo de la aplicación (#735–#744)

- **Migraciones** `20261031100000_auto_end_contracts` y `20261031120000_suspension_holds` (las aplica el api al arrancar). Redesplegar **api, worker y web** con pull efectivo (el worker gana el cron de los descuentos de retención y dos crons nuevos: `contracts.auto-end` 05:30 y `waitlist.notice-expiry` cada hora).
- **Bajas que ya pasaron su fecha**: a la mañana siguiente del despliegue, `contracts.auto-end` finaliza todos los contratos en baja con la fecha de fin ya pasada (y los que se pidieron desde el panel sin fecha no se tocan: no tenían fecha). Si algún tenant prefiere cerrar las bajas a mano, que lo desactive antes en Configuración → Plantilla de contrato → «Bajas».
- **Descuentos de retención caducados**: el cron `retention.discount-expiry` empieza a correr en el worker y retira de golpe los descuentos de oferta de retención que ya vencieron; la siguiente factura recurrente sale al precio sin descuento.
- **Tenants suspendidos**: desde el despliegue su equipo queda en solo lectura y su web deja de aceptar reservas. Revisar en Tenants los que estén «Suspendido» por si alguno no debería estarlo.
- **Ficheros**: el primer `data-retention.cleanup` (04:00) borra de MinIO los informes con el enlace caducado y las exportaciones de datos de más de 2 días.
- **Tenant suspendido (#743–#744)**: cron nuevo `suspension-holds.release` (cada hora, worker) que cobra lo retenido y manda los correos en espera al reactivarse. Los avisos al propietario (días 0, 7 y 14) salen con el cron `tenant-lifecycle.daily` aunque los correos de ciclo de vida estén apagados. **Un tenant suspendido desde hace 15 días o más deja de tener web pública nada más desplegar**: reactivar antes los que no deban estarlo. Su fecha de suspensión es `tenants.canceled_at` (o la última actualización si está vacía).

## 31. Tras desplegar las mejoras del panel admin (#745–#752)

- **Migraciones** (las aplica el api al arrancar): `web_header_branded`, `feature_override_expiry`, `feature_interest` (con RLS), `chat_commercial_alerts`, `activation_nudges`. Redesplegar **api y web** con pull efectivo.
- **Tareas nuevas en el API** (ligeras, una réplica por día o por hora): `feature-overrides.expiry` (07:45, quita cortesías y pruebas caducadas y avisa) y `chat-alerts.commercial` (cada hora, solo si se activa en Alertas).
- **Ayuda para arrancar**: viene **activada** dentro de los correos de ciclo de vida. Si los correos de ciclo de vida están encendidos, la primera mañana los tenants en prueba sin locales, inquilinos o facturas recibirán un correo (uno por tenant). Desactivarla en Alertas si no se quiere.
- **Avisos comerciales por chat**: apagados por defecto; se activan en Alertas → Telegram y Slack (empiezan desde ese momento).
- **Interés**: las señales empiezan a contar al desplegar el web (las pantallas «no está en tu plan» las envían).

## 32. Tras desplegar las mejoras del panel del tenant (#754–#759)

- **Migraciones** (las aplica el api al arrancar): `payment_plans` y `customer_interest_events` (las dos con RLS). Redesplegar **api, worker y web** con pull efectivo.
- **Tarea nueva en el API**: `payment-plans.daily` (07:00, una réplica por día) cierra los planes de pago cumplidos y marca como rotos los que llevan una cuota vencida más de los días de gracia.
- **Señales del portal**: empiezan a contar al desplegar el web (cuando el inquilino abre el seguro, otro trastero o el pase nocturno sin contratar).
- Nada se envía solo: los presupuestos y las propuestas salen cuando el equipo pulsa «Enviar».

## 33. Tras desplegar las mejoras del portal del inquilino (#761–#766)

- **Migraciones** (las aplica el api al arrancar): `customer_offers` (con RLS) y `customer_portal_last_seen`. Redesplegar **api y web** con pull efectivo.
- **Columna «Portal»** en Inquilinos: empieza vacía y se va llenando a medida que los inquilinos entran. Conviene esperar unas semanas antes de enviar el acceso en bloque a los que «nunca han entrado».
- **Ofertas**: solo las propuestas enviadas desde Oportunidades a partir de este despliegue aparecen en el portal; «Me interesa» avisa al equipo y no contrata nada.

## 34. Extra «SEO local»: IA y Search Console

1. **IA en producción.** El compose de Portainer no pasaba `AI_PROVIDER` ni `ANTHROPIC_API_KEY` a los contenedores: hasta ahora la IA (asistente del panel, sugerencias y textos de las páginas de zona) funcionaba en modo demo. Pon en las variables del stack `AI_PROVIDER=anthropic` y `ANTHROPIC_API_KEY=…` (opcional `AI_MODEL`) y redespliega api y worker.
2. **Cuenta de servicio de Search Console.**
   - En Google Cloud Console crea un proyecto (o usa uno), activa **Google Search Console API** y crea una **cuenta de servicio** sin roles.
   - En la cuenta de servicio → Claves → Añadir clave → JSON. Descarga el fichero.
   - Pega el JSON completo (en una línea) en la variable `GSC_SERVICE_ACCOUNT_JSON` del stack y redespliega api y worker.
   - Cada tenant añade el `client_email` de la cuenta como usuario «Restringido» de su propiedad en Search Console y la conecta en **Análisis → Posiciones en Google**. El worker descarga los datos cada día (cron `search-console.daily`).
3. Revisa el precio del extra «SEO local» (12 €/mes) en `/admin/addons` y, si lo vendes también por Stripe, crea su Price.
4. Quien tenía páginas de zona publicadas conserva el extra como cortesía (migración `20261106100000_local_seo_courtesy`); quítasela desde la ficha del tenant si procede.

## 35. Analítica de la web del tenant y Google Analytics 4

1. **Analítica propia** (migración `20261108100000_web_events`): no necesita nada. Las webs de los tenants empiezan a medir visitas y clics de contacto al desplegar el web; se ven en **Marketing → Visitas de la web**. Se guardan `RETENTION_WEB_EVENTS_DAYS` días (480 por defecto).
2. **Google Analytics 4** (migración `20261108120000_ga4`, dentro de Web Premium): usa la **misma cuenta de servicio** que Search Console (`GSC_SERVICE_ACCOUNT_JSON`).
   - En el mismo proyecto de Google Cloud activa **Google Analytics Data API**.
   - Cada tenant añade el `client_email` de la cuenta como **Lector** en Google Analytics → Administrar → Gestión del acceso a la propiedad y pega el ID de la propiedad (el número, no el «G-…») en **Marketing → Visitas de la web**. El worker descarga los datos cada día (cron `ga4.daily`).
3. **Rendimiento de los anuncios** (migración `20261108140000_ad_metrics_daily`): nada que configurar. La siguiente sincronización de cada canal de Google Ads o Meta Ads (el cron trae los 3 últimos días; «Sincronizar gasto» en el canal, los 7 últimos) empieza a guardar impresiones, clics y conversiones.
4. **Resumen de marketing** (migración `20261108160000_marketing_monthly_report`): nada que configurar. El día 4 de cada mes a las 09:00 el worker (cron `marketing-summary.monthly`) envía «Tu marketing en <mes>» a los propietarios de cada tenant activo o en prueba con el correo activado (por defecto sí) y actividad ese mes; se apaga en **Marketing → Resumen**.
5. **Instagram y Facebook orgánico** (migración `20261108180000_social_insights`, Web Premium): nada que configurar en la plataforma. Cada tenant pega en **Marketing → Redes sociales** un token de un usuario del sistema de su Business Manager con `pages_show_list`, `pages_read_engagement`, `read_insights`, `instagram_basic` e `instagram_manage_insights`. El worker descarga cada día a las 07:15 (cron `social.daily`). `SOCIAL_MODE=stub` simula Meta en desarrollo.

## 36. Variables que el compose de Portainer no pasaba (y avisos push)

Hasta esta versión, `docker-compose.portainer.yml` no pasaba al API ni al worker varias variables: aunque estuvieran en las variables del stack de Portainer, **no llegaban a los contenedores**. Ahora sí. Revisa en Portainer → Stacks → storageos → Environment variables:

| Variable                                                 | Qué hace                                                                                                                                                                                                                                                                         | Valor                                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL`                                           | URL pública del API. Sin ella, el API usaba `http://localhost:3001` en la **notificación de Redsys** (el banco no podía avisar de los pagos), en la **baja en un clic** de los correos comerciales y en las direcciones de webhook que se enseñan al tenant (WhatsApp, cámaras). | `https://api.trasteros.pro`                                                                                                                              |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Avisos push del inquilino, del equipo y del super admin. Sin claves, desactivados.                                                                                                                                                                                               | Generar una vez con `npx web-push generate-vapid-keys`; `VAPID_SUBJECT=mailto:<tu email>`. **No cambiarlas después**: invalidan todas las suscripciones. |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_FROM_PHONE_ID`        | Número de WhatsApp de la plataforma (Meta Cloud API) con `WHATSAPP_PROVIDER=meta_waba`.                                                                                                                                                                                          | Los de Meta                                                                                                                                              |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`           | Verificación y firma del webhook `/webhooks/whatsapp` (también para los tenants con WhatsApp Business en la app de la plataforma). Sin el secreto, la firma no se comprueba.                                                                                                     | Los de la app de Meta                                                                                                                                    |
| `EMAIL_INBOUND_SECRET`                                   | Respuestas por correo que entran al chat del inquilino.                                                                                                                                                                                                                          | Un secreto largo, el mismo que en el reenvío del proveedor                                                                                               |
| `TRUST_PROXY_HOPS`                                       | Proxies delante del API (por defecto 1, Nginx Proxy Manager).                                                                                                                                                                                                                    | `1`                                                                                                                                                      |

Tras cambiarlas, «Update the stack» con _Re-pull image_ desactivado basta (son variables, no código).

**Comprobar**: en el panel de un tenant, Configuración → WhatsApp → «Si usas tu propia app de Meta» debe mostrar `https://api.trasteros.pro/webhooks/whatsapp`, no `localhost`. Y en Configuración → Perfil → Avisos (equipo) o Notificaciones (super admin), «Avisos en este dispositivo» debe ofrecer «Activar» en lugar de «aún no están disponibles».

## 37. Logo subido y marca del tenant en las apps (2026-10-22, #801–#806)

Al redesplegar api y web:

- **Migraciones**: `tenant_logo_upload` (`tenants.portal_logo_key`) y `branded_panel_feature` (añade la función `branded_panel` a los planes Pro y Administrador ya existentes).
- **Comprobar**: Configuración → Marca y SEO permite subir el logo (PNG/JPG); con un tenant Pro, el menú del panel muestra su logo y «con TrasterOS» abajo; en `/portal/app/<slug>/icon/192` sale el logo sobre blanco (sin logo subido, las iniciales).
- Menús: el panel del tenant y el del admin cambian de agrupación (solo web); las direcciones de las páginas no cambian.

## 38. Mensajería admin↔tenant y tenant↔inquilino (2026-10-23, #808–#813)

Al redesplegar api, worker y web:

- **Migraciones**: `customer_message_reads` (leído por usuario en la bandeja «Mensajes»; lo ya leído queda leído para todos), `tenant_platform_messages` (mensajes de TrasterOS en el panel del tenant) y `message_attachments` (adjuntos en tickets y chat).
- **Comprobar**: responder un ticket desde el admin → el tenant ve el aviso y recibe el correo; escribir desde el portal → el equipo recibe el correo y aparece en **Operativa → Mensajes**; enviar un correo directo a un tenant desde el admin → aparece en su Soporte → «Mensajes de TrasterOS» con un ticket para responder; adjuntar una imagen en el chat.
- Los avisos al móvil siguen necesitando las claves VAPID (§36); sin ellas, el correo es lo que asegura que el mensaje llegue.

## 39. Adeudos SEPA conformes al contrato del banco (2026-10-23, #815–#818)

Revisión frente al contrato de adeudos directos SEPA CORE (BBVA). Migraciones (se aplican solas al desplegar el api): `20261110100000_sepa_mandate_signature`, `20261110120000_platform_sepa_mandate_signature`, `20261110140000_sepa_mandate_last_collected`.

- **Mandatos que ya existen**: quedan como «firmados fuera» (`external`) y siguen entrando en las remesas. Ten a mano el papel o la prueba de la firma de cada uno: el banco puede pedirla si un deudor reclama (hasta 13 meses).
- **Tras desplegar, rellena el domicilio del acreedor** en Configuración → Cobros (tenants) y en Admin → SEPA de la plataforma (y revisa el preaviso: 5 días en la plataforma). Sin domicilio no se puede pedir la firma de un mandato nuevo.
- **Mandatos nuevos**: el inquilino los firma por un enlace (le llega por correo) y el tenant firma el suyo en Suscripción. Hasta que firman no entran en la remesa.
- **Fecha de cobro**: tiene que respetar el preaviso, ser día hábil TARGET2 y estar a menos de un año; si no, la remesa da 400 con la primera fecha válida.
- **Caducidad**: un mandato sin cobros en 36 meses pasa a «caducado» y sale de la remesa (hay que firmar otro). Los que ya eran recurrentes cuentan desde su alta en la app.
- **Antes de la primera remesa real**: sube el fichero al validador de ficheros de BBVA net cash para confirmar que lo acepta.
- **Revisión del mandato** (migración `20261110160000_sepa_mandate_review`): el identificador del acreedor se comprueba con sus dígitos de control. **Si el que tienes guardado no cuadra, la remesa da 400 `invalid_creditor_id`**: corrígelo en Configuración → Cobros / Admin → SEPA de la plataforma (con un identificador incorrecto el cambio no se bloquea). Una vez hay mandatos firmados, el identificador ya no se puede cambiar. Cada mandato conserva el preaviso que firmó: bajar el ajuste solo afecta a los mandatos nuevos. En la plataforma, una remesa sin confirmar se puede cancelar y reenviar sus preavisos.
- **En el validador de BBVA, comprueba además**: que acepta `pain.008.001.02` (el fichero valida contra el XSD oficial de ISO 20022), la hora de corte para la fecha de cobro (con preaviso de 1 día, deja al menos 2 días hábiles) y que el presentador (`InitgPty/Id` = identificador del acreedor) coincide con el del contrato.

## 40. Revisión de facturación (2026-10-23)

Migración `20261111100000_invoice_numbering_year` (se aplica sola al desplegar el api).

- **Numeración por año**: las series «por año» (`FA/2026/…`) vuelven a `00001` con la primera factura de 2027. La migración guarda en cada serie el año de su última factura, así que este año no cambia nada. Las series sin año (`FA/00001`) siguen seguidas.
- **Vencimiento**: el pago de varios meses (primer pago de 3/6/12 meses o prepago semestral/anual) vence a los 15 días del inicio del periodo (antes, al final: un anual no entraba en impagos en un año). El mensual no cambia.
- **Primera factura**: si no se puede emitir (un NIF que la AEAT no admite, falta de certificado…), el equipo recibe la notificación «No se pudo emitir la primera factura» con el motivo.
- **Reserva online con envío real a la AEAT** (`AEAT_MODE` distinto de `stub`): el DNI/NIE tiene que ser válido (400 `invalid_tax_id`).

## 41. Sesión del panel en el móvil (2026-10-24)

- La sesión ya no se cierra en el móvil cuando iOS congela la app a mitad de una renovación, ni manda al login sin conexión (muestra «Sin conexión» y entra sola al volver la red).
- **App instalada (pantalla de inicio)**: la sesión del panel dura 90 días y se renueva al usarla (en el navegador, 7). Variable nueva opcional `JWT_REFRESH_APP_TTL_SECONDS` (por defecto `7776000`), ya en el compose de Portainer. Migración `20261111120000_session_installed_app` (se aplica sola). Las sesiones abiertas antes de desplegar siguen con 7 días: hay que volver a iniciar sesión una vez desde la app para que pase a 90.
- **Bloqueo de la app (PR 3)**: tras 15 min sin uso la app instalada pide Face ID / huella o un PIN (lo configura cada usuario en Perfil → App del móvil). Migración `20261111140000_staff_app_lock` (se aplica sola). Face ID / huella usa llaves de acceso ligadas al dominio de `WEB_BASE_URL`: si el panel cambia de dominio, cada usuario tendrá que volver a activarlo. Necesita https (en producción ya lo es).

## 42. TPV Redsys de la plataforma (cobro de la suscripción)

- Panel admin → **Cobros → TPV Redsys**: código de comercio (FUC), terminal, entorno y clave SHA-256 del TPV virtual de TrasterOS (los mismos datos con cualquier banco que use Redsys). Bizum solo si el banco lo tiene activo en el TPV.
- En el TPV, la notificación online debe ser «HTTP» síncrona. La dirección de aviso (`<API_BASE_URL>/webhooks/redsys/platform`) la manda la aplicación en cada pago; `API_BASE_URL` tiene que ser la pública (`https://api.trasteros.pro`).
- Los tenants que pagan a mano ven «Pagar con tarjeta» (y «Pagar con Bizum») en Ajustes → Suscripción; cada pago cubre un mes del plan. Migración `20261111160000_platform_redsys` (se aplica sola). Para probar: entorno de pruebas con el comercio público de Redsys (`999008881`, terminal `1`, clave `sq7HjrUOBfKmC576ILgskD5srU870gJ7`) y la tarjeta de pruebas `4548810000000003`.
- **Cobro automático (PR 2)**: con «Pago por referencia» marcado en el TPV de la plataforma (el banco tiene que haber habilitado el pago por referencia / COF), el tenant puede «Guardar la tarjeta y cobrar automáticamente cada mes»: su suscripción pasa al modo de cobro «Tarjeta (Redsys)» y el cron `platform-redsys.auto-charge` (06:00, antes del control de impagos) la cobra el día que vence. Si el banco la rechaza se reintenta a los 2 días, hasta 3 veces por periodo; al tercero llega un aviso al super admin y el tenant queda con el pago pendiente. Migración `20261111180000_platform_redsys_card_on_file` (se aplica sola).

## 43. Revisión del CRM (2026-10-24)

- Migración `20261112100000_crm_review` (se aplica sola): recompensa de referidos guardada en el referido y aplicada como descuento en la siguiente factura del que recomienda (`referrals.reward_*`), y `reviews.published_on_web` (las respondidas con NPS ≥ 9 y comentario quedan publicadas, para no vaciar la web de nadie).
- Tras desplegar, revisar en **Valoraciones** qué testimonios se muestran en la web: a partir de ahora solo salen los marcados «En la web».
- Las recompensas de referidos ya concedidas como código `REF-…` siguen valiendo como antes.

## 44. Funcionalidades del CRM (2026-10-25)

- Migración `20261112120000_crm_features` (se aplica sola): seguimientos y actividad de contactos, reparto y plazo de respuesta por tenant, enlaces y clics de campañas, plantillas de campaña, reseña en Google pedida y win-back en dos pasos.
- Los enlaces de las campañas pasan por `API_BASE_URL` (`/v1/public/campaign-click/…`): tiene que ser la URL pública del API.
- El aviso de contactos sin atender corre cada hora en el API; el reparto automático está apagado hasta que el tenant lo active en Leads → Atención.

## 45. Inventario (2026-10-25)

- Migración `20261113100000_inventory_features` (se aplica sola): movimientos y stock mínimo de productos, documentos de los locales y fecha prevista de mantenimiento.
- Cron nuevo `facility-documents.expiry` (07:30, en el worker): avisa de los documentos de un local que caducan en 30 días.
- Tras desplegar la PR de arreglos, las ventas en el mostrador piden la forma de pago: por defecto efectivo, con el cobro en su factura.

## 46. Revisión de la Operativa (2026-10-25)

- Sin migración. El cron `contracts.auto-end` (05:30, worker) ahora también trata los contratos activos que ya pasaron su fecha de fin: los que tienen renovación automática se prorrogan y los demás pasan a baja. La primera ejecución tras desplegar puede mover de golpe los contratos que llevaban tiempo vencidos: revisa «Contratos» al día siguiente.

## 47. Funcionalidades de la Operativa (2026-10-25)

- Migración `20261114100000_operations_features` (se aplica sola al arrancar). Redesplegar api, worker y web: el worker escucha ahora los eventos de contrato para las tareas automáticas.
- Las tareas automáticas están apagadas en todos los tenants hasta que se activen en Tareas → «Tareas automáticas».
- Una reserva con señal emite su factura al confirmarla: hace falta una serie de facturación por defecto (si no, se puede emitir después desde Reservas → «Facturar la señal»).

## 48. «Hoy» y Resumen (2026-10-26)

- Migración `20261115100000_today_daily_summary` (se aplica sola): `tenants.daily_summary_last_date`.
- Cron nuevo `today.daily-summary` (cada hora en el minuto 5, en el API): a las 8:00 en la zona horaria de cada negocio envía el resumen del día a los usuarios que lo activen en Ajustes → Perfil → Avisos (apagado por defecto). Usa la cola `email`, así que lo entrega el worker.

## 49. Configuración (2026-10-28)

- Migración `20261116100000_settings_features` (se aplica sola): contacto del negocio y aviso del dominio en `tenants`, cambio de email pendiente en `users`.
- Cron nuevo `custom-domains.dns-check` (cada hora, en el API): cuando el DNS de un dominio propio pendiente ya apunta a la plataforma, llega un aviso al panel del super admin para crear el Proxy Host y activarlo.
- El cron de retención borra además las invitaciones sin aceptar caducadas o revocadas hace más de 90 días.

## 50. Primer pago al entrar a final de mes (2026-10-28)

- Migración `20261117100000_first_payment_next_month` (se aplica sola): `tenants.first_payment_next_month_from_day`, 20 por defecto para todos los tenants.
- Desde el despliegue, un contrato mensual que empiece a partir del día 20 paga en su primera factura los días que quedan del mes más el mes siguiente completo. Cada negocio puede cambiar el día o desactivarlo en Configuración → Facturación → «Primer pago al entrar a final de mes».
- No cambia nada en contratos ya firmados ni en los que pagan varios meses por adelantado.

## 51. Reservas antes de la apertura (2026-10-28)

- Migración `20261118100000_pre_opening_reservations` (se aplica sola): `facilities.pre_opening/opening_date/pre_opening_max_months` y `contracts.pre_opening*`. No cambia nada en locales ni contratos existentes.
- Cron nuevo `contracts.pre-opening` (min. 15 de cada hora, en el **worker**): el día de apertura (en la hora del local) empiezan las reservas; tres días antes avisa a los inquilinos. Redesplegar también el worker.
- Para usarlo: ficha del local → Ajustes → «Próxima apertura».
- **Revisar con la asesoría** el texto de las condiciones de la reserva (arras penitenciales del art. 1454 CC tras los 14 días de desistimiento).
- Revisión y extras: migraciones `20261119100000_pre_opening_review` (`contracts.pre_opening_deadline_notified_at`) y `20261120100000_pre_opening_coupons` (`coupons.pre_opening_only`), se aplican solas. Aviso nuevo al equipo «Apertura de un local» (activado por defecto para propietarios y gestores). Redesplegar api, worker y web.

## 52. Otras formas de pago para el inquilino: transferencia, en el local y domiciliación (2026-10-28)

- Migración `20261121100000_offline_payment_options` (se aplica sola): `tenants.offline_transfer_enabled/offline_cash_enabled/offline_sepa_enabled` (apagadas) y `contracts.offline_payment_method/offline_payment_chosen_at`. No cambia nada hasta que el tenant las active.
- Redesplegar api, worker y web.
- Para usarlo: Configuración → Cobros → «Otras formas de pago para el inquilino». La transferencia exige el IBAN para transferencias; la domiciliación, las remesas SEPA activas con el domicilio del acreedor (y el plan con SEPA).
- Al reservar online (tras firmar) o al pagar una factura desde el área de clientes, el inquilino ve solo las activadas:
  - **Transferencia**: le llega por correo el IBAN, el importe (factura y fianza) y el concepto; la reserva se guarda 24 h más.
  - **En el local**: la reserva se guarda 24 h más.
  - **Domiciliación**: pone su IBAN y firma el mandato; con el mandato firmado la reserva ya no caduca y se cobra en la próxima remesa SEPA.
  - En los tres casos el equipo recibe un aviso (campana y push) y no se le manda el recordatorio de «paga online».
- Al cobrar, «Marcar pagada» en la factura propone la forma que eligió el inquilino y admite efectivo, transferencia, domiciliación SEPA, tarjeta u otro.

## 53. Revisión del área de clientes, arreglos (2026-10-28)

- Migración `20261122100000_portal_review` (se aplica sola): `contracts.end_date_before_ending`. Redesplegar api y web.
- Contratar otro trastero desde el área de clientes ya no firma solo: lleva a la página del contrato (`/sign/<token>`) para leerlo, firmarlo y pagar, igual que la reserva online; mientras tanto el trastero queda reservado (se libera a las 72 h si no firma y paga).
- Las sesiones abiertas del portal no cambian; los tokens nuevos llevan un identificador para poder cerrar cada sesión al salir.

## 54. Mejoras del área de clientes (2026-10-28)

- Migración `20261123100000_portal_improvements` (se aplica sola). Dependencia nueva del API: `jszip` (ZIP de las facturas del año). Redesplegar api, worker y web.
- Sin variables nuevas. El cambio de email del inquilino guarda el enlace en Redis 24 h (`portal:emailchange:<id>`).
- Los ZIP de facturas se guardan en `reports` bajo `<tenant>/exports/` y los borra el cron de limpieza a los 2 días.

## 55. Vencimientos y avisos (2026-10-29)

- Migración `20261124100000_business_reminders` (se aplica sola). Añade la función a los planes Starter, Pro y Administrador de la instancia viva; el bootstrap la mantiene en cada despliegue. Redesplegar api, worker y web.
- Sin variables nuevas. El enlace del calendario usa `API_BASE_URL` (`https://api.trasteros.pro/v1/public/reminders-calendar/<token>`): comprobar que esa URL es pública (el Proxy Host del API ya lo cubre).
- Los avisos salen del API (cron horario, a partir de las 8:00 de cada negocio). El correo al equipo usa el remitente «Avisos al equipo» de Correo saliente; el de los correos de fuera (asesoría), el del negocio.
- Tras desplegar: entrar en un tenant de pago → Operaciones diarias → Vencimientos, añadir una plantilla y comprobar que llega el aviso al día siguiente a las 8:00.

## 56. Revisión de «Negocio» del panel admin, arreglos (2026-10-29)

- Migración `20261125100000_trial_ended_at`: columna `tenants.trial_ended_at` y el disparador `tenants_trial_ended_at` (función `tenants_set_trial_ended_at`). Se aplica sola al arrancar el API. Rellena una fecha aproximada a los tenants que ya no están en prueba (fin de la prueba o alta + 30 días).
- Tras redesplegar cambian algunas cifras del panel admin, a propósito: el MRR deja fuera a los tenants suspendidos, los ingresos son netos de reembolsos, las bajas cuentan suspendidos y anonimizados, y el coste de IA no incluye las claves propias de los tenants.
- El snapshot de MRR del mes en curso se recalcula en la tarea diaria `mrr.daily-snapshot` (03:00): hasta entonces los movimientos de este mes pueden no llevar los extras.
- Sin variables nuevas.

## 57. «Negocio» del panel admin: funcionalidades (2026-10-29)

- Migración `20261126100000_admin_business_features`: tablas globales `platform_business_goals` y `tenant_health_snapshots` (con `REVOKE` al rol de la app) y umbrales de los avisos de negocio en `platform_alert_settings`. Se aplica sola.
- Los avisos de negocio vienen activados con umbrales por defecto (caída del MRR 10 %, churn 5 %, tenant grande desde 100 €/mes, IA 20 $ en 7 días) y solo salen si el resumen semanal (correo o Telegram/Slack) está activado. Se cambian en Métricas → «Avisos de negocio».
- La tendencia de la salud necesita la foto del mes anterior: hasta el mes que viene no hay tendencia.
- El informe mensual en PDF usa Chromium como el resto de PDF del API.

## 58. Condiciones generales de contratación con aceptación obligatoria (2026-10-29)

- Migración `20261127100000_legal_doc_versions` (versiones y aceptaciones, con RLS). Se aplica sola.
- Desde este despliegue, quien firma una reserva online (o paga un contrato ya firmado) tiene que marcar la casilla de las Condiciones Generales de Contratación. El texto por defecto se genera con los datos de cada negocio; conviene que cada tenant lo revise en Configuración → Textos legales.
- En el área de clientes, el primer pago de un contrato que nunca las aceptó (firmado en papel o antes de esto) también pide la casilla; los contratos que ya pagaron alguna factura no.
- Sin variables nuevas.

## 59. Vaciar los datos de prueba de un tenant (2026-10-29)

- Sin migración ni variables nuevas.
- Panel admin → ficha del tenant → «⋮» → «Vaciar los datos de prueba» (solo rol superadmin). Borra inquilinos, contratos, reservas, facturas, cobros, ventas, gastos y todo lo que cuelga de ellos (también sus ficheros en MinIO, salvo las exportaciones) y deja las series en 1. Conserva locales, trasteros (los alquilados vuelven a libres), productos con su stock, contactos, usuarios y configuración.
- Bloqueado si hay facturas aceptadas por la AEAT con `AEAT_MODE=production` o si es el negocio que emite las facturas de la plataforma. Avisa de facturas copiadas en Holded y de cobros por pasarela (devuélvelos antes si alguno fue real).
- Exporta los datos antes desde el propio diálogo. No se puede deshacer.

## 60. Asistente IA: clave desde el panel admin y límite de consultas (2026-10-29)

- **Migración** `20261128100000_ai_limits` (se aplica sola): tabla global `platform_ai_settings` (REVOKE), `ai_usage_events.counts_as_query`, `subscription_addons.grants_ai_queries`, `tenants.ai_monthly_limit` y `tenants.ai_limit_notified`.
- **Clave y modelo**: panel admin → Plataforma → **Asistente IA**. Lo que se guarde ahí manda; si no hay clave en el panel, se siguen usando `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (y `AI_MODEL`) de Portainer, así que **no hay que tocar nada al desplegar**. Un cambio en el panel llega a todos los procesos en menos de un minuto. «Probar conexión» hace una llamada mínima al modelo.
- **Límite**: 300 consultas al mes por tenant y 50 al día por persona por defecto (editables en esa página). Una consulta es una pregunta; las vueltas para consultar datos no cuentan, y las «Sugerencias de hoy» tampoco. Al 80 % y al 100 % se avisa al equipo del tenant (campana).
- **Extra «IA ampliada»** (`addon-ai-extra`, 15 €/mes, +500 consultas): lo crea el bootstrap. Revisar precio en `/admin/addons`. Para un caso puntual, límite propio en la ficha del tenant (tarjeta «Asistente IA»).

## 61. Revisión del asistente IA y del vaciado de datos de prueba (2026-10-29)

- **Migración** `20261129100000_ai_portal_limit` (se aplica sola): `ai_usage_events.customer_id` y `platform_ai_settings.portal_daily_limit` (20).
- **Vaciar los datos de prueba**: antes de borrar, los accesos de los inquilinos se quitan de los terminales de las puertas (Dahua). Si un terminal no responde, no se borra nada (409 `terminal_revoke_failed`): revisa su conexión y vuelve a intentarlo. Con `AEAT_MODE=production` bloquea cualquier factura enviada a la AEAT (también pendientes o con error) y siempre bloquea las facturas emitidas en Holded.
- **Asistente IA**: tope diario por inquilino en el chatbot del área de clientes (panel admin → Asistente IA, 20 por defecto). Las consultas se reservan antes de llamar al modelo y se devuelven si falla.

## 62. Clave de IA propia del tenant y mejoras del vaciado (2026-10-29)

- **Migración** `20261130100000_ai_own_key` (se aplica sola): `tenants.ai_mode` / `ai_own_api_key_encrypted` / `ai_own_model` y `ai_usage_events.own_key`.
- **Clave propia del tenant** (Configuración → Asistente IA): con ella, al gastar las consultas del mes el asistente sigue respondiendo y esas consultas no cuentan ni cuestan a la plataforma. En la ficha del tenant (panel admin) se puede poner «Siempre su propia clave».
- Al llegar al límite se avisa también **por correo** a los propietarios.
- **Vaciar los datos de prueba**: la vista previa dice cuántos ficheros se borran por tipo y, al terminar, llega un aviso al panel admin y un resumen al email de alertas (Alertas al admin).
- Nada que configurar en Portainer.

## 63. Revisión del apartado Tenants del panel admin (2026-10-29)

- Sin migración ni variables nuevas. Redesplegar api, worker y web.
- Anonimizar un tenant (RGPD) ahora también borra sus secretos (certificado de la AEAT, pasarelas, Holded, claves de API) y los datos de los inquilinos que antes se quedaban; antes de usarlo, exporta sus datos si el cliente los pide.
