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
- Para actualizar a mano: **Pull and redeploy** con **Re-pull image** marcado
  (ver §6C para el automático). El servidor **no compila**: las imágenes de
  api, worker y web las compila GitHub Actions en cada fusión a `main` y las
  sube a `ghcr.io/dignitasjota/storageos-<servicio>` (§124); el compose las
  descarga (`pull_policy: always`). Antes se compilaban aquí y, con 4 GB, el
  servidor se quedaba sin memoria y la web dejaba de responder.
- Para volver a una versión anterior: variable del stack
  `IMAGE_TAG=sha-<commit>` y redeploy (vacía = `latest`).
- El `migrate dev` nunca; aquí solo corre `migrate deploy` (idempotente).

---

## 6C. Despliegue automático en cada merge (webhook de Portainer)

Para no tener que entrar a Portainer a redeplegar a mano tras cada merge a
`main`, hay un workflow de GitHub Actions (`.github/workflows/deploy.yml`) que
dispara un **webhook de redeploy** del stack **cuando «Imágenes Docker (GHCR)»
termina bien** (es decir, con las tres imágenes nuevas ya subidas). Portainer
las descarga y vuelve a arrancar los contenedores; no compila nada.

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
3. Listo. En el próximo merge a `main`, cuando terminen las imágenes, el job
   **Deploy (Portainer)** hará `POST` a esa URL y Portainer redeplegará. Sin el secret, el workflow no falla:
   registra un aviso y termina (no-op), así que puedes mergear este cambio antes
   de configurarlo.

### Verificación

- Tras un merge, en GitHub → pestaña **Actions** → workflow **Deploy
  (Portainer)** debe salir en verde con "✅ Redeploy disparado".
- En Portainer, el stack debe mostrar un redeploy reciente; cuando termine,
  recarga el panel con **Ctrl/Cmd + Shift + R**.

### Si el web sigue saliendo viejo

Comprueba en GitHub → Actions que «Imágenes Docker (GHCR)» terminó en verde
para ese commit y que el redeploy descargó la imagen (Portainer → Images:
`storageos-web` con fecha de hoy). Recarga con **Ctrl/Cmd + Shift + R**.

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
```

Los datos del sistema informático (fabricante Urbanbox Soluciones SL, TrasterOS, código y versión) no son variables: van en `VERIFACTU_SYSTEM` (`packages/shared/src/billing/verifactu.ts`) y tienen que coincidir con la declaración responsable (§110).

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
- **Versión del sistema informático**: si cambia la parte de facturación (campos, huella, formato del registro), sube `VERIFACTU_SYSTEM.version` en `packages/shared/src/billing/verifactu.ts` y firma la declaración responsable de esa versión.
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

## 64. Mejoras del apartado Tenants del panel admin (2026-10-29)

- **Migración** `20261201100000_admin_tenants_improvements` (se aplica sola). Sin variables nuevas. Redesplegar api, worker y web.
- Las vistas guardadas de la lista de tenants pasan del navegador al servidor la primera vez que se abre la lista (se suben las de ese navegador).
- «Anonimizar» pide ahora marcar «Ya he exportado sus datos».

## 65. Asistente IA con todo el negocio y chat de la web (2026-10-29)

- **Migración** `20261202100000_web_chat` (se aplica sola). Sin variables nuevas. Redesplegar api, worker y web.
- El chat aparece solo en la web de los tenants con el asistente IA (plan Pro o extra), activado por defecto; el tenant lo apaga en Configuración → Asistente IA.
- Panel admin → Asistente IA → «Chat de la web de los tenants»: modelo (por defecto `claude-haiku-5-5`; si la cuenta de Anthropic no tiene acceso a él, poner otro), 300 respuestas al mes por tenant y 15 preguntas al día por visitante. Sin clave de IA en la plataforma el chat no responde con IA (enseña el contacto del negocio).
- Las respuestas de la web no gastan las consultas del panel. Sus tokens salen en «Uso por tenant» y Finanzas como el resto de la IA.

## 66. Revisión del chat con IA de la web (2026-10-29)

- **Migración** `20261203100000_web_chat_review` (se aplica sola): `web_chat_messages.fallback` y `tenants.web_chat_key_notified`. Sin variables nuevas. Redesplegar api, worker y web.
- La política de privacidad generada de los tenants con el chat añade el apartado «Chat de la web» y Anthropic entre los proveedores. Quien tenga una política propia en Configuración → Textos legales debe añadirlo a mano.
- Las conversaciones anteriores no tienen respuestas de respaldo guardadas (solo las nuevas).

## 67. Chat de la web y WhatsApp: mejoras (2026-10-29)

- **Migración** `20261204100000_web_chat_whatsapp_improvements` (se aplica sola). Sin variables nuevas. Redesplegar api, worker y web.
- **Chat de la web**: reserva y lista de espera desde el chat (activado por defecto; se apaga en Configuración → Asistente IA), paso a una persona (el equipo responde en Marketing → Chat de la web; aviso en la campana y en el móvil), preguntas sugeridas, valoración 👍/👎, «Seguir por WhatsApp», streaming y ayuda proactiva en la página de reserva. La respuesta del equipo llega al visitante si tiene la web abierta o cuando vuelva (no hay aviso por correo).
- **Caché de prompts de Anthropic** en el asistente del panel, el chat de la web y el asistente de WhatsApp: la parte fija se cobra a un 10 % cuando se repite en 5 minutos. No hay que hacer nada.
- **WhatsApp**: horario del asistente (siempre / fuera / dentro del horario del equipo), aviso por intención (reclamación y baja por defecto), resumen al pasar a una persona, «Sugerir respuesta» en la bandeja (gasta una consulta del asistente del panel) y seguimiento a las 24 h con una plantilla aprobada (apagado por defecto; corre en el worker, en el mismo cron que los recordatorios de reserva). La plantilla de seguimiento debe estar aprobada en Meta con `{{1}}` = nombre.

## 68. Fotos de la portada de la web del tenant (2026-10-30)

- **Migración** `20261205100000_web_hero_images` (se aplica sola): `tenants.web_hero_image_key` y `tenants.web_hero_background_key`. Sin variables nuevas. Redesplegar api y web.
- Las fotos se suben al bucket público (`<tenant>/web-hero/…`), como el logo y el favicon. Sin fotos, la portada se ve como antes.

## 69. Landings de promoción: nueva estructura (2026-10-30)

- **Migración** `20261206100000_promo_landing_content` (se aplica sola): `promo_landings.content` (jsonb) y paso a él de los textos de las landings existentes (oferta, ventajas, texto, condiciones —una por línea—, botón y secciones). Las columnas antiguas se conservan pero ya no se usan. Sin variables nuevas. Redesplegar api y web.
- Conviene que cada tenant con landings las revise en Configuración → Web pública → Landings de promoción: el antiguo «texto» pasa al bloque de la promoción y las condiciones a una lista.
- **Dirección corta** (opcional, por landing y solo con dominio propio): `tu-dominio/<nombre>` además de `/promo/<nombre>`. No hace falta tocar NPM: la sirve la misma web.
- Las páginas de las landings ya no se guardan en caché: apagar o caducar una landing se nota al momento (antes seguía visible hasta el siguiente despliegue, porque Next solo cachea las respuestas 200).
- **Enlaces cortos de los carteles**: con dominio propio verificado salen como `tu-dominio/g/<código>` (los QR ya impresos con `trasteros.pro/g/…` siguen funcionando). En Marketing → Canales hay un botón «QR» por canal con descarga en PNG.
- El formulario de la landing crea contactos con origen «Landing de promoción» (5 envíos por minuto e IP). La vista previa usa `MASTER_ENCRYPTION_KEY` y `WEB_BASE_URL` (ya configuradas).

## 70. Cobros del panel admin: revisión (2026-10-30)

- **Sin migración ni variables nuevas.** Redesplegar api, worker y web.
- El escalado de impagos solo actúa sobre tenants activos con un plan de pago: ya no suspende a quien se pasó a Free, a quien está suspendido o de baja a mano (respeta su motivo y fecha de baja) ni a uno en prueba. Los avisos van también a los propietarios con el email verificado; si no hay nadie, aviso al super admin (`platform_dunning.no_recipient`).
- La remesa SEPA de la plataforma no incluye cuentas exentas ni anonimizadas aunque sigan en modo SEPA.
- Cobros pendientes y la ficha del tenant enseñan la deuda real (una cuota por cada periodo vencido) y, con Stripe, los días desde el cobro que falló. Lo que ya va en una remesa SEPA se lista pero no suma como pendiente.
- Un cobro automático de Redsys sin respuesta (hasta 48 h) no pasa la cuota a «pago pendiente».
- La numeración de las facturas de suscripción y la exportación por año van por el año de España (antes, de 00:00 a 01:00 del 1 de enero, en el año anterior).

## 71. Cobros del panel admin: mejoras (2026-10-30)

- **Migración** `20261207100000_admin_billing_features` (se aplica sola). Sin variables nuevas. Redesplegar api, worker y web.
- Los avisos de impago a los tenants dicen cuánto deben (todas las cuotas vencidas) y cómo pagar según su forma de cobro. En Cobros pendientes hay «Registrar pago» en un diálogo, «Enviar recordatorio», filtros y CSV.
- El tenant con la cuota pendiente puede pagar varios meses de una vez con tarjeta o Bizum. **Cambio**: con el cobro automático con tarjeta (Redsys), cada cargo lleva también los extras de pago a mano (como la remesa SEPA) y esos extras dejan de salir en «Hoy» para cobrarlos aparte.
- Página nueva **Cobros → Facturas emitidas** (`/admin/platform-invoices`): buscar, PDF, reenviar, rectificar y totales por mes. Los datos del emisor y la exportación siguen en `/admin/platform-billing` (enlazada desde la página).
- **Remesa SEPA automática** (opcional, en Cuenta SEPA): cada mañana a las 07:30 se prepara con la primera fecha que respeta el preaviso y se envía el preaviso a los tenants. Queda sin confirmar: hay que descargar el fichero, subirlo al banco y confirmarla. Si a los 3 días de la fecha de cobro sigue sin confirmar, aviso al super admin.
- Avisos nuevos al super admin: tenant con la cuota pendiente (uno por impago) y cuenta exenta o anonimizada que sigue en SEPA o con tarjeta guardada (cada 30 días). Al marcar un adeudo como devuelto, el tenant recibe un correo con cómo pagar.
- El calendario de cobros filtra por forma de cobro (pulsando las tarjetas) y enseña los reintentos de los cobros con tarjeta rechazados.

## 72. Catálogo y precios del panel admin: arreglos (2026-11-01)

Sin migración ni variables nuevas.

- **Cambio de comportamiento**: un plan creado desde `/admin/plans` sin funciones marcadas ya no tiene funciones premium (antes recibía todas, también las que solo se venden como extra). Si existe un plan así en producción, revisarlo y marcar sus funciones antes de desplegar.
- **Pago manual con cupón**: el importe que se teclea es el precio de lista; se registra y factura el neto (precio − descuento del cupón).
- Los planes `free` y `starter` no se pueden desactivar y los sembrados (`free`, `starter`, `pro`, `administrador`) no se pueden renombrar.
- La portada de trasteros.pro toma los precios y la anualidad del catálogo (un plan desactivado deja de verse) y la nota de IVA según «Precios con IVA incluido» de Facturación SaaS. Los textos y las funciones de cada tarjeta siguen en `messages/es.json`.

## 73. Catálogo y precios del panel admin: mejoras (2026-11-01)

Migración `20261208100000_admin_catalog_features` (se aplica sola). Sin variables nuevas.

- **Cupones en Stripe**: con Stripe configurado, cada cupón activo se crea también en Stripe y se puede usar al suscribirse o cambiar de plan con tarjeta (campo «Cupón de descuento» en Suscripción). Los cupones que ya existían no están en Stripe: edítalos y guárdalos una vez para crearlos (badge «Solo a mano» → «Stripe ✓»). En Stripe un cupón no se edita: al cambiar lo que descuenta se sustituye por uno nuevo.
- Un plan con tenants no se desactiva (409 `plan_in_use`): pásalos antes a otro. Los planes ocultos no salen en la web ni en el autoservicio.
- Los precios por tramos de un extra se aplican al asignarlo a mano y en el simulador; el cobro por Stripe sigue con el precio mensual.
- El correo de una propuesta de cuota lleva un enlace a Suscripción con el plan, la periodicidad y el cupón ya elegidos. La propuesta se marca aceptada sola al contratar ese plan, cambiar a él o registrar un pago.
- Comisión por tenant y comisiones cobradas por mes en «Comisión por cobros con tarjeta» y en Finanzas.

## 74. Blog del tenant: herramientas de SEO (2026-11-02)

Migración `20261209100000_blog_seo_tools` (se aplica sola). Sin variables nuevas.

- El listado y las entradas del blog, las fichas de local, las páginas de ciudad y zona, los textos legales y las landings de promoción llevan la cabecera y el pie de la portada de su plantilla (antes un marco común con el logo más pequeño). Si la portada no se puede cargar, se usa el marco común.
- Las portadas que ya estaban subidas conservan su nombre aleatorio: para que Google vea un nombre con sentido, vuelve a subirlas con «Nombre del archivo» relleno.

## 75. Comunicación del panel admin: arreglos (2026-11-02)

Migración `20261210100000_admin_comms_review` (se aplica sola). Sin variables nuevas.

- Los correos que el super admin envía a un tenant ya no cuentan en los tiempos de respuesta del soporte ni como «esperando tu respuesta» mientras el tenant no conteste; los que siguen sin respuesta a los 14 días se cierran solos (tarea `support.admin-messages-autoclose`, 05:20, en el API). La migración marca como «abiertos por el admin» los que ya había.
- Si un correo directo no llega a ningún destinatario, no se guarda nada (antes el tenant veía el mensaje y el ticket).
- Los anuncios y correos del admin salen con la cabecera y el pie de TrasterOS y admiten formato sencillo (negrita, listas, títulos y enlaces).
- Casilla «Comunicación comercial» en los anuncios: llevan enlace de baja y no llegan a quien se dio de baja (`users.platform_news_opt_out_at`). Los avisos de servicio no la llevan.
- El correo a los tenants seleccionados ya no llega a los dados de baja.
- El banner tiene fecha de fin, se puede cerrar (salvo el crítico) y se ve en un minuto, no en cinco.
- Revisar en «Novedades» las ya publicadas: la fecha de publicación es ahora la de la primera vez.

## 76. Comunicación del panel admin: mejoras (2026-11-02)

Migración `20261211100000_admin_comms_features` (se aplica sola). Sin variables nuevas.

- **El banner pasa a ser una lista** (`platform_banners`): la migración copia el que hubiera (si tenía texto) y borra la tabla antigua. Revisa en «Banners y avisos» que sigue como querías.
- **Anuncios con historial**: se pueden guardar como borrador, programar (la tarea `admin.announcements-scheduled` del API los envía cada 5 minutos), duplicar y reenviar a quien no los recibió. Los correos de cada anuncio quedan enlazados en «Correos enviados».
- «Correos enviados» guarda también el HTML de los correos (no el de los de acceso a la cuenta), así que se pueden ver y reenviar; los anteriores a esta versión no.
- **Correos automáticos** (bienvenida, fin de la prueba, impago): sus textos se editan en Comunicación → Correos automáticos. Sin cambios, sale el texto de serie (el mismo que antes, sin «responde a este correo»).
- **Encuestas NPS** a los propietarios: Comunicación → Encuestas NPS. El enlace del correo lleva a `/nps/<token>` (sin sesión, no indexable).

## 77. Plataforma del panel admin: arreglos (2026-11-02)

Sin migración. Variable nueva opcional `RETENTION_CONTACT_MESSAGES_DAYS` (730 por defecto): días que se guardan los mensajes del formulario de contacto de trasteros.pro; la IP del visitante se borra a los 90 días.

- Los avisos al super admin (aviso diario, resumen semanal y el correo de prueba de Correo saliente) salen ahora por el servicio común: quedan en «Correos enviados» con el tipo «Alertas y resumen al administrador», respetan las direcciones bloqueadas y llevan la marca de TrasterOS. Si quieres otro remitente para ellos, está en Correo saliente → «Avisos al equipo».
- El aviso diario, el resumen semanal y los correos automáticos a los tenants salen a su hora de España (antes, una o dos horas más tarde).
- Los interruptores de los correos automáticos a los tenants están ahora en Comunicación → Correos automáticos.

## 78. Plataforma del panel admin: mejoras (2026-11-03)

Migración `20261212100000_admin_platform_features` (sin variables nuevas). Tras desplegar:

- **Alertas al admin**: elige la hora del aviso diario (hora de España) y, si quieres, varios emails separados por comas. El aviso diario incluye también el gasto de IA del mes cuando pasa del aviso que pongas en Asistente IA.
- **Asistente IA**: si quieres un límite distinto por plan, rellénalo en «Consultas al mes por plan» (vacío = el general).
- **Páginas legales**: al guardar los términos o la privacidad con «Es un cambio importante», se manda un correo a los propietarios de todos los tenants activos y en prueba y les sale un aviso para aceptarlo en su panel. Úsalo solo para cambios que de verdad lo requieran.
- **Mensajes de la web**: llegan también por Telegram/Slack si están configurados (se puede apagar en Alertas al admin).

## 79. Seguridad y sistema del panel admin: arreglos (2026-11-04)

Migración `20261213100000_admin_security_review`. Variables opcionales con valor por defecto: `RETENTION_SECURITY_EVENTS_DAYS` (90), `RETENTION_ADMIN_SESSIONS_DAYS` (30), `RETENTION_IMPERSONATION_LOGS_DAYS` (730) y `RETENTION_SUPER_ADMIN_AUDIT_DAYS` (730). Tras desplegar:

- **Alertas de fuerza bruta**: salen ahora a los emails de Alertas al admin, a Telegram/Slack y a las notificaciones del panel. `SECURITY_ALERT_EMAIL` solo se usa si Alertas no tiene ningún email.
- **2FA obligatoria**: para activarla, entra en Seguridad, activa tu 2FA y pulsa «Obligar». Quien no la tenga dispone de los días de plazo que elijas; después solo podrá activarla.
- **Tareas programadas**: al arrancar el API y el worker desaparecen de la lista las que ya no existen.
- El primer cron de retención borra las sesiones del panel caducadas hace más de 30 días y las impersonaciones y acciones de más de 2 años.

## 80. Seguridad y sistema del panel admin: mejoras (2026-11-04)

Migración `20261214100000_admin_security_features` (sin variables nuevas). Tras desplegar:

- **Bloqueos**: en el panel de Seguridad se bloquea una IP o un email, 24 horas desde las tablas o el plazo que elijas. Afecta a la entrada del equipo y del panel admin, no al área de clientes.
- **Avisos del sistema**: si el worker deja de latir o una tarea lleva más de una hora atrasada, llega un aviso por los canales de Alertas al admin, como mucho cada 6 horas.
- **Impersonación**: entrar con permiso para hacer cambios manda un correo a los propietarios del tenant. Entrar en solo lectura no avisa.

## 81. Fianza en el local al reservar online (2026-11-04)

Sin migración ni variables nuevas. Para ofrecerlo, activa «Pagar en el local» en Configuración → Cobros. Quien reserva online verá antes de firmar «¿Dónde pagas la fianza?». Con la fianza en el local recibe el acceso al pagar el alquiler y la fianza queda en «Hoy» hasta registrar su cobro, también con «Tarjeta (TPV físico)».

## 82. «Hoy» del panel admin: arreglos (2026-11-04)

Sin migración ni variables nuevas. Tras desplegar, «Pendiente» puede cambiar: ahora es la misma cifra que Cobros pendientes. Los tenants en SEPA o Redsys dejan de salir en «Renovaciones manuales por expirar».

## 83. «Hoy» del panel admin: mejoras (2026-11-04)

Migración `20261215100000_admin_today_features` (sin variables nuevas). Tras desplegar:

- **Avisos al momento:** vienen activados. La primera pasada agrupa en un solo mensaje lo urgente que ya exista. Se apagan en Alertas al admin.
- **Contador de urgentes:** baja, porque lo que tiene días por delante pasa a la pestaña «Esta semana».

## 84. «Hoy» del panel del tenant: arreglos (2026-11-05)

Sin migración ni variables nuevas. Tras desplegar, el número de «asuntos para hoy» bajará: la deuda cuenta una vez por inquilino y ya no cuentan las ofertas de retención ni lo que no vence hoy. «Cobrado este mes» también puede bajar, porque ya no incluye las fianzas y resta las devoluciones.

## 85. «Hoy» del panel del tenant: mejoras (2026-11-05)

Migración `20261216100000_tenant_today_features`, sin variables nuevas. El resumen del día se reserva ahora por persona: quien lo reciba el día del despliegue con la versión anterior puede recibirlo una vez más ese día. El aviso en el móvil del resumen necesita las claves `VAPID_*`.

## 86. Alta de un tenant nuevo: arreglos (2026-11-05)

Migración `20261217100000_tenant_onboarding_review`, sin variables nuevas. **Antes de desplegar, revisar**: desde esta versión la web de un tenant solo se publica con la cuenta activada y un local, y las reservas online exigen además razón social, NIF, domicilio y una forma de cobro. Un tenant que hoy reciba reservas sin esos datos dejará de aceptarlas hasta completarlos (le saldrá «Reserva online aún no disponible» al visitante y el motivo en su Puesta en marcha). El cron nuevo `tenant-lifecycle.unverified` (cada hora, API) manda los recordatorios de activar la cuenta y borra las cuentas sin activar a los 30 días, siempre con el último aviso enviado hace al menos 7: las que ya llevan más de 30 días reciben primero ese aviso.

## 87. Asistente de primer acceso (2026-11-05)

Migración `20261218100000_onboarding_test_customer` (`customers.is_test`), sin variables nuevas. Los tenants ya creados no ven el asistente (solo se ofrece sin locales ni trasteros). El menú corto se aplica a quien aún no tiene un contrato, también a los tenants actuales en esa situación, y se abre con «Ver todo el menú».

## 88. Seguir aprendiendo tras el alta (2026-11-05)

Sin migración ni variables nuevas. Los correos de fin de prueba añaden lo que le falta a cada tenant; si el texto de «La prueba termina pronto» se ha editado en Comunicación → Correos automáticos sin la variable `{limites}`, no saldrá.

## 89. Resumen del panel: arreglos (2026-11-05)

Sin migración ni variables nuevas. Algunas cifras cambian tras desplegar y es lo esperado: «Facturado este mes» deja de restar de más al anular, las altas y bajas siguen el criterio de Analítica y «Nuevos este mes» pasa a contar inquilinos con su primer contrato, no fichas creadas. «Pendiente de cobro» enseña todo lo emitido sin cobrar, con lo vencido aparte.

## 90. Resumen del panel: mejoras (2026-11-05)

Migración `20261219100000_dashboard_layout` (`users.dashboard_layout`), sin variables nuevas.

## 91. Accesos: arreglos (2026-11-05)

Sin migración ni variables nuevas. Tarea nueva `access.sweep` (cada 15 min, en el worker). Lo que se nota tras desplegar:

- El primer repaso **revoca lo que les quede a los ex-inquilinos** (quien tuvo contrato y ya no tiene ninguno): tarjetas, caras y credenciales suspendidas que seguían vivas. Y marca como caducado lo vencido.
- Una credencial limitada a unos locales **ya no abre la cerradura de un trastero** que no tenga en su lista. Las hechas a mano antes que solo tenían locales dejan de abrir esas cerraduras: editarlas y marcar sus trasteros.
- Las credenciales antiguas creadas sin locales siguen abriéndolo todo hasta que se editen.
- Los ajustes de accesos adicionales y pase nocturno están ahora en Configuración → Accesos del inquilino.

## 92. Accesos: mejoras (2026-11-05)

Migración `20261220100000_access_features` (se aplica sola), sin variables nuevas. Tarea nueva `access.device-health` (cada 10 min, en el worker).

- **Corte por impago**: sigue igual por defecto (todo, a los 14 días). Cada negocio lo cambia en Configuración → Accesos del inquilino; vale para las facturas que venzan después.
- **Conexión de los dispositivos**: solo se vigilan los que tienen dirección o mandan latido (`POST /v1/access/heartbeat`). Un teclado que solo llama al entrar alguien no se marca como caído.
- Con la migración, `access_credentials.customer_id` admite nulo (accesos temporales).

## 93. Contratos: arreglos (2026-11-05)

Migración `20261221100000_contract_term_months` (se aplica sola), sin variables nuevas. Lo que se nota tras desplegar:

- **Prórroga automática**: cada prórroga repite el plazo original (`contracts.term_months`). Los contratos que ya se prorrogaron con plazo duplicado conservan su fecha de fin actual; la migración solo fija el plazo de las siguientes. Si alguno salió con una fecha demasiado lejana, se corrige en la ficha → Condiciones.
- **Fianza**: una fianza sin cobrar sale como «Pendiente de cobro» y no se puede liquidar. Liquidarla exige registrar antes el cobro; un contrato cerrado sin justificante (anterior a los justificantes) se sigue pudiendo cerrar.
- **Señal de una reserva**: al cancelar o caducar, una señal sin cobrar se anula y una cobrada deja un abono en borrador con aviso en la campana.
- «Convertir en contrato» abre el asistente de alta con la reserva cargada.

## 94. Contratos: mejoras (2026-11-05)

Migración `20261222100000_contract_features` (se aplica sola), sin variables nuevas ni tareas nuevas: el cron `contracts.auto-end` aplica además los cambios de cuota y traslados programados. Lo que se nota tras desplegar:

- **Lista de espera**: al liberarse un trastero, ahora queda **reservado 48 h** para quien recibe el aviso, que recibe un enlace para reservarlo. Si no responde, pasa al siguiente. Mientras dura no se puede vender a otra persona desde la web.
- **Acceso de contratos con entrada futura**: el PIN se emite al firmar pero abre desde la fecha de inicio. El inquilino lo recibe igual por correo.
- **Correos nuevos al inquilino**, activados por defecto en Configuración → Correo: contrato renovado (también en cada prórroga automática), cambio de cuota y liquidación de la fianza. Los dos últimos solo salen si el equipo marca la casilla de avisar.

## 95. Inquilinos: arreglos (2026-11-05)

Sin migración ni variables nuevas. Lo que se nota tras desplegar:

- **Alcance por local**: quien solo ve unos locales ve los inquilinos con contrato en ellos y los que no tienen contrato; los demás le dan 404 en la lista, la ficha y sus pestañas.
- **Mandatos SEPA sin firmar**: dejan de contar como forma de pago en la lista, el estado de cuenta, Extras, el área de clientes y los correos.
- **Deuda de la lista**: incluye lo emitido ya vencido que el proceso nocturno aún no ha marcado, como Deudores.
- **DNI, NIE y CIF** se validan al crear o editar. Los datos ya guardados no cambian hasta que alguien los edite.
- **Borrar un inquilino**: con reserva o lista de espera se bloquea; con deuda pide confirmación.

## 96. Inquilinos: mejoras (2026-11-05)

Migración `20261223100000_customer_features`, se aplica sola. Sin variables nuevas.

- Las vistas guardadas en el navegador se suben al servidor la primera vez que alguien con permiso abre Inquilinos y pasan a verlas todos.
- **Fusionar inquilinos no se puede deshacer**: solo la tienen quienes pueden borrar inquilinos.
- Una empresa con email de facturación recibe en él facturas, cobros y recordatorios.

## 97. Reservas, lista de espera, cambios y solicitudes: arreglos (2026-11-05)

Sin migración. Variable opcional `RETENTION_WAITLIST_DAYS` (365).

- **Un trastero guardado para otra persona** (reserva online, aviso de la lista de espera, traslado programado, reserva anticipada) ya no se reserva a mano ni se pone a la venta: 409 `unit_held_by_other`. Lo que suelta un trastero mira a todos los dueños (`releaseReservedUnit`).
- **Lista de espera**: el repaso horario avisa también a quien está en cola con un trastero libre. Al desplegar, quien ya esté en esa situación recibirá el aviso en la primera hora y su trastero quedará guardado 48 h.
- **Respuesta a las peticiones**: el inquilino recibe un correo nuevo al atender o rechazar un cambio o una solicitud de trastero. Se apaga en Configuración → Correo. Rechazar exige un motivo.
- **Reservas**: `POST /reservations/expire-due` desaparece (nadie lo usaba; lo hace el cron). Una señal necesita inquilino y `validUntil` tiene que ser futura.
- **RGPD**: anonimizar a un inquilino lo saca de la cola y suelta su trastero guardado. Los contactos de la cola sin ficha y ya cerrados se borran al año.

## 98. Reservas, lista de espera, cambios y solicitudes: mejoras (2026-11-05)

Migración `20261224100000_reservations_features`, se aplica sola. Sin variables nuevas.

- **Correos nuevos al inquilino**: «Reserva confirmada» y «Reserva a punto de caducar», activados por defecto. Se apagan en Configuración → Correo. Si el negocio tiene una automatización de reserva confirmada, sale la suya.
- **Limpieza de la cola**: quien lleva 90 días esperando recibe «¿Sigues buscando?» en la primera hora tras desplegar, y sale de la cola si no responde en 14 días. Cada negocio lo cambia (o lo apaga con 0) en Reservas → Ajustes.
- **Aviso por WhatsApp**: sale solo con el extra activo y la plantilla de recordatorio configurada, o con la conversación abierta.
- **Señal**: por defecto se sigue devolviendo. Si un negocio elige quedársela, conviene que lo digan sus condiciones.

## 99. Mensajería: arreglos (2026-11-06)

Migración `20261225100000_messages_review`, se aplica sola. Sin variables nuevas.

- **Avisos de mensajes**: cada persona solo recibe los de inquilinos que puede abrir. Al equipo le llega uno por conversación cada 15 minutos y un recordatorio a las 24 horas si sigue sin respuesta (cron `customer-messages.unanswered`, cada hora, en el API; solo mensajes de los últimos 3 días, así que al desplegar no salen avisos de conversaciones antiguas).
- **Mensajes de TrasterOS**: pasan a verlos solo el propietario y el gestor. Un rol a medida necesita marcar el permiso nuevo. Lo ya leído se conserva para el equipo actual.
- **Tickets**: el contador del menú pasa a ser «con respuesta sin leer», por persona. Tras desplegar, las respuestas anteriores a la fecha de alta de cada persona no cuentan; las posteriores salen como sin leer hasta abrir el ticket.
- **Adjuntos sin enviar**: la limpieza diaria borra lo subido a un chat o ticket que no llegó a enviarse.
- **Correo entrante** (solo si `EMAIL_INBOUND_SECRET` está puesto): lo que no se sabe de quién es aparece en las notificaciones del super admin.

## 100. Mensajería: mejoras (2026-11-06)

Migración `20261226100000_messages_features`, se aplica sola. Las conversaciones existentes quedan «sin responder» si lo último es del inquilino.

- **Tiempo real**: va por Redis y por conexiones largas al API (`/v1/realtime/stream`, `/v1/portal/me/stream`, `/v1/admin/support/tickets/stream`). En Nginx Proxy Manager no hace falta tocar nada: el API manda `X-Accel-Buffering: no`, igual que el asistente IA. Si el canal cae, las pantallas siguen refrescándose solas.
- **Horario de atención**: apagado por defecto. Cada negocio lo activa en Configuración → Mensajes.
- **Tickets que esperan respuesta**: al desplegar, los que llevan más de 5 días esperando al negocio reciben el recordatorio en la siguiente pasada (05:20) y se cierran 5 días después.
- **Responder por correo dentro del hilo** (opcional). Sin esto todo funciona, pero responder a un correo llega al buzón del negocio y no a la conversación:
  1. Elige un subdominio solo para esto (por ejemplo `r.trasteros.pro`) y apunta su MX al proveedor de correo entrante.
  2. Haz que ese proveedor reenvíe cada correo a `POST https://api.trasteros.pro/webhooks/email-inbound` con la cabecera `X-Inbound-Secret` y este JSON: `{from, to, text, dmarc, attachments: [{filename, contentType, contentBase64}]}`. Si el proveedor manda otro formato, hace falta un pequeño adaptador (un Worker de Cloudflare, por ejemplo).
  3. Pon `INBOUND_EMAIL_DOMAIN=r.trasteros.pro` y `EMAIL_INBOUND_SECRET` en las variables de Portainer y redespliega.
  4. Prueba: escribe a un inquilino de prueba desde el panel, contesta a ese correo y comprueba que aparece en la conversación.

  **No está probado con un proveedor real**: solo con el webhook simulado en los tests. Solo se aceptan imágenes y PDF de hasta 10 MB.

## 101. Trasteros: arreglos (2026-11-06)

Migración `20261227100000_units_review`, se aplica sola. Sin variables nuevas.

- **Historial por trastero**: la migración crea `unit_tenancies` y la rellena con los contratos firmados y sus traslados. Después la mantiene un disparador sobre `contracts`. Los traslados antiguos salen de los eventos del contrato; su precio es el actual del contrato, porque el de entonces no se guardaba.
- **Pares apilados rotos**: la misma migración desapila las taquillas cuya pareja se borró y los pares separados en dos plantas. Si alguna taquilla «reaparece» en el plano de un local, es esto.
- **Tras desplegar, mira Inventario → Trasteros**: el aviso de descuadres puede enseñar trasteros reservados o fuera de servicio con el inquilino dentro. Es lo que se hizo a mano antes de este cambio; «Corregir a Ocupado» lo arregla.
- **Cambia cómo se trabaja**: ya no se puede poner a mano «Reservado» ni cambiar el estado de un trastero con contrato en vigor. Para una avería con inquilino dentro, una incidencia.

## 102. Trasteros: mejoras (2026-11-06)

Migración `20261228100000_units_features`, se aplica sola. Sin variables nuevas.

- **Trasteros ya parados**: la migración les pone como motivo y fecha los de su último paso a mantenimiento o bloqueado. Si no hay historial, la fecha es la de su última actualización, así que los días y el dinero sin ingresar pueden salir cortos.
- **Fotos**: van al bucket público, igual que las de los locales. Se ven en el panel; todavía no salen en la web ni en el área de clientes.
- **Etiquetas de puerta**: el QR lleva la dirección del panel, así que hay que iniciar sesión para abrirla. Sirven para el equipo, no para los inquilinos.

## 103. Locales: arreglos (2026-11-06)

Migración `20261229100000_facilities_review`, se aplica sola. Sin variables nuevas.

- **Locales ya borrados**: la migración apaga sus planes de mantenimiento, gastos recurrentes, puertas y cámaras, que seguían activos. Los contratos que quedaran a medias en ellos ya no se pueden firmar: hay que cancelarlos.
- **Alcance por local**: se lee en cada petición, no del token. Quitarle un local a alguien surte efecto al momento, sin esperar a que caduque su sesión.
- **Nombres repetidos**: los locales que ya tengan el mismo nombre se quedan como están. Solo se impide crear otro o renombrar a uno que exista. Al importar, la fila que nombre uno de esos locales falla con un mensaje claro: conviene cambiarle el nombre a uno.
- **Quien use la API**: `PATCH /facilities/:id` ya no añade un número a una dirección ocupada: responde 409 `slug_taken` con una propuesta. `PUT /facilities/:id/images` y `PATCH /floors/:id/plan` dan 400 `file_not_uploaded` si el fichero no se llegó a subir.

## 104. Locales: mejoras (2026-11-06)

Migración `20261230100000_facilities_features`, se aplica sola. Sin variables nuevas.

- **Locales borrados antes de este cambio**: salen en la papelera si llevan menos de 30 días, pero no guardan lo que se apagó, así que al restaurarlos sus puertas, planes y gastos se quedan apagados. Hay que encenderlos a mano.
- **Fotos de locales borrados**: las públicas se quitan a los 30 días del borrado, cuando ya no se puede restaurar (cron `data-retention.cleanup`, en el worker). Al primer paso del cron se van las de los locales borrados hace más de 30 días.
- **Direcciones antiguas**: solo redirigen las que se cambien a partir de ahora. Las que se cambiaron antes ya no existen en ningún sitio.
- **Cartel con QR**: lleva a la página del local en la web, con el dominio propio si está verificado. Con web externa, a la reserva de ese local (`/reservar/<local>`), porque `/<local>` es de esa web. Si después cambia el dominio, hay que imprimirlo de nuevo.
- **Datos estructurados**: el horario partido y los días especiales salen ya en lo que lee Google. Google tarda días en reflejarlo.

## 105. Corte de acceso por impago (2026-11-07)

Sin migración ni variables nuevas.

Hasta ahora el corte **nunca se aplicaba**: el escalado no recibía el servicio de accesos ni el de expedientes (se inyectaban con `@Optional()` y tipo `X | null`, que Nest no resuelve) y aun así dejaba la acción ejecutada, de modo que el panel y el área de clientes daban al inquilino por cortado mientras su PIN seguía abriendo.

**Qué cambia al redesplegar:**

- Los cortes se aplican de verdad desde el primer repaso del escalado (06:00 UTC, en el worker). El aviso legal de los 30 días también abre el expediente, si el negocio tiene activados los impagos físicos.
- **Antes de redesplegar**, revisar con los tenants que usen accesos su política en Configuración → Accesos del inquilino (cortar todo, solo los adicionales o nada, y a los cuántos días).
- **Los que ya constaban como cortados no se cortan solos**: en el panel dejan de salir como cortados y aparecen en Deudores → «Deudores con el acceso sin cortar», con «Cortar ahora», «No cortar» y «Cortar a todos». Solo salen si tienen algo que cortar y su factura sigue sin pagar, sin cobro en curso y sin plan de pago.
- Los expedientes que debían abrirse con el aviso legal antes de este cambio no se abren solos: se abren a mano desde Deudores.
- Un corte que falla ya no se da por hecho: la acción sigue programada y se reintenta en el repaso del día siguiente, con el motivo en sus notas.
- El inquilino no recibe un correo en el momento del corte: el segundo recordatorio (día 7) ya le avisa y el área de clientes se lo dice.

## 106. Facturas: arreglos (2026-11-07)

Migración `20261231100000_invoices_review`, se aplica sola. Sin variables nuevas.

**Qué cambia al redesplegar:**

- **Datos fiscales obligatorios para emitir.** Sin razón social, NIF, domicilio, código postal y municipio del emisor, emitir o anular una factura da 400 `issuer_fiscal_data_required` y el panel lleva a completarlos (Configuración → Datos de tu empresa, o Propietarios si la factura es de un propietario). Las recurrentes con emisión automática se quedan en borrador hasta que los tengan. **Antes de redesplegar**, mirar qué negocios que facturan no los tienen:

  ```sql
  SELECT t.slug, t.name FROM tenants t
  WHERE t.deleted_at IS NULL AND t.status IN ('active', 'trial')
    AND EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = t.id AND i.created_at > now() - interval '90 days')
    AND (coalesce(t.tax_id, '') = '' OR coalesce(t.billing_legal_name, '') = ''
      OR coalesce(t.billing_address, '') = '' OR coalesce(t.billing_postal_code, '') = ''
      OR coalesce(t.billing_city, '') = '');
  ```

- **Cuándo vencen las cuotas.** Las facturas que se emitan a partir de ahora vencen a los 15 días de emitirse (antes, la mensual vencía a los 15 días del final del mes que cubre: la de noviembre, el 15 de diciembre). Las ya emitidas no cambian. Como el impago (y el corte de acceso, §105) cuenta desde el vencimiento, empieza antes. Cada negocio lo cambia en Configuración → Facturación → **Plazo de pago**; 45 días se parece a lo de antes.
- **El PDF de la factura** ya no dice si está pagada ni lo que falta (no cambiaba después y se quedaba con lo del día que se generó). Se genera solo al emitir, en el worker. Los PDF ya generados se quedan como están: «Regenerar PDF» en la ficha los rehace.
- **Anular una factura** devuelve al contrato lo que gastó (mes gratis, saldo de la señal, recompensa de referido) y anula su recargo por mora si no se cobró. Las anuladas antes no lo devolvieron: si hace falta, a mano.
- **Recargo por mora**: solo sobre facturas vencidas y con el recargo activado; ya no sobre otro recargo.
- **Devoluciones**: cada una queda en `invoice_refunds`. Un cobro con el TPV del banco (Redsys) no se puede devolver desde la app: se devuelve en el banco y se registra en la ficha.
- **Quien use la API**: `GET /invoices?status=` desconocido da 400 `invalid_status`; el mismo cobro o la misma devolución dos veces en 30 segundos da 409; `POST /payments/invoices/bulk/charge` devuelve también `processing`.

## 107. Facturas: mejoras (2026-11-07)

Migración `20270101100000_invoices_features`, se aplica sola. Sin variables nuevas: el enlace de descarga del correo se firma con una clave derivada de `MASTER_ENCRYPTION_KEY` (si se cambia esa clave, los enlaces de correos antiguos dejan de valer y la factura se descarga desde el área de clientes) y apunta a `API_BASE_URL`, que en producción tiene que ser la dirección pública del API (§36).

**Qué cambia al redesplegar:**

- **Correos de factura con enlace de descarga.** «Nueva factura», «Pago recibido» y la factura enviada desde la ficha («Enviar por correo») llevan un enlace al PDF que funciona sin iniciar sesión (`/v1/public/invoices/<token>/pdf`, 30 por minuto por IP). Si la factura aún no tiene PDF, se genera al abrirlo. Los recordatorios siguen llevando al área de clientes para pagar.
- **PDF más completo**: logo y color de la marca, cómo se paga y el sello «PAGADA» con la fecha. Se vuelve a generar solo al cobrarse, al devolverse o al deshacer un cobro, así que el sello no se queda viejo. Los PDF ya generados siguen como estaban hasta que se rehagan (menú «Más» → «Volver a generar el PDF»).
- **Un solo recordatorio por inquilino.** Si debe varias facturas, el escalado y el recordatorio en lote le mandan un correo con todas («Tienes N facturas pendientes de pago»); antes, uno por factura. Si algo falla al agruparlas, sale el recordatorio de cada factura como antes.
- **Devolver como saldo a favor**: no sale dinero; se emite la rectificativa por lo devuelto y el importe se descuenta de la siguiente factura del contrato al emitirla. No cuenta como cobrado ni entra en la caja.
- **Deshacer un cobro registrado por error** (solo los registrados a mano, sin devoluciones): la factura vuelve a pendiente y no cuenta como recibo devuelto. Un cobro en efectivo de un día con la caja ya cerrada no se puede deshacer ni cambiar (409 `cash_day_closed`): ese arqueo ya lo cuenta.
- **Plazo de pago por inquilino** (ficha del inquilino → Editar datos): manda sobre el del negocio en las facturas que se emitan después.
- **Página nueva** «Cierre del mes» (`/invoices/month-close`, desde Facturas).
- **Quien use la API**: `GET /invoices/page` acepta `from`, `to`, `type`, `payment` y `sort` (valores desconocidos → 400) y trae `collection` en cada fila; rutas nuevas en `API.md` → «Mejoras de Facturas».

**Comprobar tras el despliegue:** emitir una factura de prueba a un inquilino con email propio → le llega el correo y el enlace descarga el PDF con el logo; registrar un cobro en efectivo y deshacerlo desde la tarjeta «Actividad» de la ficha.

## 108. Reservas online: la factura llega con el pago y aviso al caducar (2026-11-08)

Sin migración ni variables. **Qué cambia al redesplegar:**

- La primera factura de una reserva online (desde la web o el área de clientes) ya no se envía por correo al emitirse: el inquilino la paga en la propia reserva y la recibe con «Pago recibido», con el enlace del PDF. Si el negocio tiene una automatización de «factura emitida», tampoco la manda para esa factura. Las facturas de contratos firmados en el panel y las mensuales salen como siempre.
- Si una reserva online caduca sin pagar (72 h), el inquilino recibe «Tu reserva del trastero X se ha cancelado»: no tiene que pagar nada (su factura queda anulada) y un botón para volver a reservar. Cada negocio lo puede apagar en Configuración → Correo («Reserva online sin pagar»).

## 109. Veri\*Factu por negocio (2026-11-08)

Migración `20270102100000_verifactu_toggle` (se aplica sola). Sin variables nuevas. **Qué cambia al redesplegar:**

- Cada negocio decide cuándo envía sus facturas a la AEAT: **Configuración → Veri\*Factu → «Envío de tus facturas a la AEAT»**. Viene **apagado**. Apagado, la factura se emite sin huella, sin QR, sin la frase de VERI\*FACTU y sin envío; la insignia de la factura dice «Sin Veri\*Factu».
- **La migración** deja activado a quien ya tenga facturas aceptadas de verdad por la AEAT (pruebas o producción). Al resto les quita el registro simulado de sus facturas (estado «Aceptada», CSV `STUB-…`, huella, cadena y QR) y su PDF, que se vuelve a generar sin el QR la primera vez que alguien lo pide (panel, área de clientes o el enlace del correo). Las facturas, sus números y sus importes no cambian.
- **Activarlo** exige los datos fiscales del negocio y, con la plataforma enviando de verdad (`AEAT_MODE=sandbox|production`), un NIF válido y un certificado vigente. Con `AEAT_MODE=stub` en producción no se deja activar («TrasterOS aún no está conectado con la AEAT»). Desde que se activa, la primera factura abre su cadena de registros y todo se envía solo. **No se puede desactivar hasta el 31 de diciembre** del año en que se activó (art. 17 de la Orden HAC/1177/2024).
- Es obligatorio desde el **1 de enero de 2027** (sociedades) y el **1 de julio de 2027** (los demás), según el Real Decreto-ley 15/2025. «Conviene revisar» y la puesta en marcha lo recuerdan mientras esté apagado. Si se aplaza, se cambia `VERIFACTU_MANDATORY_FROM` en `packages/shared/src/billing/verifactu.ts`.
- Con la plataforma en modo de pruebas (`stub`, en desarrollo) las facturas de un negocio activado salen como «Simulada», no como «Aceptada».

**Para empezar a enviar de verdad:** `AEAT_MODE=production` en Portainer (api y worker) y redesplegar; cada negocio sube su certificado y lo activa. Antes conviene resolver lo pendiente del envío real (ver ROADMAP → «Veri\*Factu: antes del envío real»).

## 110. Veri\*Factu: datos del fabricante y QR arriba (2026-11-08)

Migración `20270103100000_verifactu_installation` (se aplica sola). **Qué cambia al redesplegar:**

- **El XML de los registros cumple ya el esquema de la AEAT.** Antes `RegistroAlta` iba en el espacio de nombres equivocado y las rectificativas llevaban bloques fuera de orden: cualquier envío real se habría rechazado. No hay que hacer nada; una prueba lo valida con xmllint contra los XSD oficiales.
- Cada registro que se envía a la AEAT lleva al fabricante del sistema: **Urbanbox Soluciones SL (B05691886)**, sistema TrasterOS, código `01`, versión `1.0` (`VERIFACTU_SYSTEM` en `packages/shared/src/billing/verifactu.ts`; tiene que coincidir con la declaración responsable). Antes salía el nombre del sistema como razón social y el NIF `B00000000`.
- **Se pueden borrar de Portainer** `AEAT_SISTEMA_NIF`, `AEAT_SISTEMA_NOMBRE`, `AEAT_SISTEMA_VERSION` y `AEAT_SISTEMA_INSTALACION`: ya no se leen.
- **Número de instalación por facturación** (preguntas frecuentes de la AEAT a desarrolladores, n.º 4): el de cada negocio se fija al activar Veri\*Factu (fecha y hora de la activación + el principio de su id) y no se repite, ni al volver a activarlo; cada propietario del plan Administrador lleva el suyo. La migración se lo pone a los negocios que ya lo tenían activado. `IndicadorMultiplesOT` = `S` solo en los negocios con propietarios.
- **El QR va arriba**: en el PDF de las facturas con Veri\*Factu, centrado en la cabecera, con «QR tributario:» encima y «Factura verificable en la sede electrónica de la AEAT» debajo, del tamaño del resto de datos (especificación del QR de la AEAT, apartado 3). Los PDF ya generados no cambian.
- **Cambiar de versión**: cuando cambie la parte de facturación, se sube `VERIFACTU_SYSTEM.version` y se firma la declaración de esa versión.

## 111. Veri\*Factu: envíos en lotes y control de flujo (2026-11-08)

Migración `20270104100000_verifactu_submissions` (se aplica sola). Variable opcional `RETENTION_VERIFACTU_SUBMISSIONS_DAYS` (1461 días por defecto). **Qué cambia al redesplegar:**

- **Las facturas de un mismo emisor (el negocio o cada propietario) salen juntas**, hasta 1.000 por envío y en el orden de su cadena. Antes salía una por envío.
- **Se espera entre envíos lo que pide la AEAT** (`TiempoEsperaEnvio`, 60 segundos al principio; art. 16.2 de la Orden HAC/1177/2024). Lo que se emite mientras tanto va en el siguiente envío; con 1.000 registros acumulados sale sin esperar. Cada emisor lleva su propia espera: un negocio no frena a otro.
- **Un envío sin respuesta se repite** al cabo de 1, 2, 4… minutos y, como mucho, cada hora (art. 16.4). Un «SoapFault» o un error del servidor de la AEAT cuentan como envío sin respuesta, no como rechazo. Si un envío anterior sí llegó, la AEAT contesta «duplicado» con lo que tiene registrado y se toma eso.
- **Constancia de cada envío** en la tabla `verifactu_submissions` (fecha, facturas, resultado y el CSV de la AEAT), que se guarda 4 años. Se ve en **Configuración → Veri\*Factu** («Último envío… Ver los envíos»), junto con cuándo sale el siguiente si hay facturas pendientes.
- «Reenviar» una factura y subir un certificado no esperan al reintento de un envío fallido (sí a la espera entre envíos).
- Los trabajos `send-to-aeat` que hubiera en la cola al redesplegar (uno por factura) se siguen atendiendo: envían lo pendiente del emisor de esa factura.

No hay que configurar nada. Con `AEAT_MODE=stub` el envío simulado no pide esperar.

## 112. Veri\*Factu: subsanación, anulación, renuncia e incidencias (2026-11-08)

Migración `20270105100000_verifactu_records` (se aplica sola). Sin variables nuevas. **Qué cambia al redesplegar:**

- **Cada registro de facturación se guarda por separado** (tabla `verifactu_records`) con el XML tal como se generó: el que se envía es ese, aunque después cambien los datos del cliente. La migración crea el registro de alta de cada factura que ya estaba en la cadena (con su estado, CSV y envío). La factura conserva su huella y su QR; el estado que se ve es el de su último registro.
- **Corregir lo que la AEAT rechazó o aceptó con avisos**: «Corregir y volver a enviar» genera un registro de subsanación al final de la cadena (antes se volvía a mandar el mismo registro con los datos cambiados, que la AEAT no admite). Si el error está en algo que se ve en la factura (NIF del cliente, un importe), el panel recomienda rectificarla. Lo que no llegó (sin respuesta) se vuelve a mandar igual.
- **Anular una factura emitida por error** (propietario y gestor; Factura → Más): solo una sin cobros, sin rectificar y que no sea una rectificativa. Queda «Anulada por error», fuera de los libros y los informes, con el sello «ANULADA» en el PDF y, con Veri\*Factu, su registro de anulación. Es excepcional: si la operación existió, se rectifica. Las reservas online caducadas siguen anulándose con su rectificativa de abono hasta que la asesoría diga otra cosa.
- **Dejar Veri\*Factu**: quien ya ha enviado facturas este año sigue hasta el 31 de diciembre (art. 17 de la Orden HAC/1177/2024). «Desactivar» programa la baja para ese día y los envíos que salgan hasta entonces llevan la renuncia (`FechaFinVeriFactu`). El 1 de enero se apaga solo (tarea `verifactu.renuncia`, en el worker) si la renuncia llegó a la AEAT; si no salió ningún envío más ese año, sigue activado y se avisa al negocio. Sin facturas este año se apaga en el momento. (Antes no se podía apagar hasta el 31 de diciembre del año en que se activó.)
- **Incidencias** (art. 16.4): mientras los envíos de un emisor fallan, lo pendiente se marca como incidencia, sale aparte con `Incidencia=S` y el panel muestra un aviso con cuántas facturas faltan por llegar a la AEAT.

No hay que configurar nada. Para comprobarlo tras desplegar: Configuración → Veri\*Factu (la baja y las incidencias) y la ficha de una factura (la tarjeta Veri\*Factu lista sus registros).

## 113. Veri\*Factu: declaración responsable (2026-11-11)

Sin migración ni variables nuevas. **Qué cambia al redesplegar:**

- La **declaración responsable** de TrasterOS (art. 15 de la Orden HAC/1177/2024), firmada por Urbanbox Soluciones SL: nombre, código y versión del sistema, componentes y funciones, uso por varios obligados, datos del productor, declaración de cumplimiento, y fecha y lugar de la firma.
- Se ve en **trasteros.pro/declaracion-responsable** (enlazada en el pie y en el mapa del sitio) y, dentro del panel, en **Configuración → Veri\*Factu** (entera y en PDF) y en la tarjeta Veri\*Factu de cada factura.
- El PDF lo genera el API (`/v1/public/verifactu/declaration/pdf`) con el mismo Chromium que las facturas, una vez por versión.
- **Cada versión del sistema lleva la suya**: al subir `VERIFACTU_SYSTEM.version` hay que añadir su declaración en `VERIFACTU_DECLARATIONS` (con el día en que se publica); una prueba lo exige.
- No incluye si el sistema funciona solo como VERI\*FACTU ni los tipos de firma (letras e y g del art. 15.1): decisión de Jota mientras el interruptor por negocio esté pendiente de la asesoría.

## 114. Contrato v2: condiciones nuevas, baja a final de mes y abono de lo pagado por adelantado (2026-11-11)

Migraciones `20270106100000_contract_v2` y `20270106110000_contract_signed_rules` (se aplican solas). Sin variables nuevas. **Qué cambia al redesplegar:**

- **Cada contrato conserva las reglas con las que se firmó** (`contracts.move_out_end_of_month` y `prepaid_credit_at_list_price`, que se guardan al firmar). La baja a final de mes y el abono nuevo de lo prepagado solo valen para los contratos que se firmen tras el despliegue. Los ya firmados (y los importados) siguen como estaban: baja cualquier día con el preaviso; prepago semestral o anual abonado en proporción; primer pago de varios meses sin abono.
- **Condiciones generales del trastero nuevas** (las firman los negocios sin cláusulas propias): baja a final de mes; autorización para cobrar cada cuota con la tarjeta o la cuenta guardada; solo los recargos que figuran en el contrato; prohibidos sin categorías abiertas (baterías de litio, aparatos eléctricos, calor, carga máxima, pasillos libres); los bienes no están asegurados salvo la protección de contenido; averías e incidencias; normas del local; apertura del trastero con aviso y acta; **impago por pasos sin dar los bienes por abandonados**; fianza con plazo de devolución; promociones; videovigilancia y datos; contratación electrónica. **Los contratos ya firmados conservan su texto** y los negocios con cláusulas propias no cambian (pueden partir de las nuevas con «Restaurar la base» en Configuración → Plantilla de contrato).
- **La ficha del contrato** lleva el contacto del arrendador y del inquilino, la cuota y los extras con el IVA incluido (y el total al mes), el plazo para devolver la fianza, el horario de acceso (del toque de queda del local) y los recargos por impago.
- **La baja surte efecto a final de mes** por defecto en los trasteros (Configuración → Plantilla de contrato → Bajas): en el área de clientes el inquilino elige entre los próximos finales de mes y, si pide un día, termina el último de ese mes. El equipo puede poner otra fecha (baja pactada). Si el negocio vuelve al día que elija el inquilino, vale para los contratos que se firmen desde entonces. Las viviendas siguen su ley (LAU).
- **Lo pagado por adelantado** (prepago semestral o anual, o el primer pago de 3, 6 o 12 meses, con o sin cupón): al irse antes se abonan los meses enteros sin usar, cobrando los usados a la cuota mensual, sin el descuento ni los meses gratis. La ficha de esos contratos lo dice.
- **Ajustes nuevos** en Plantilla de contrato: días para devolver la fianza (15) y gastos por recibo devuelto o pago rechazado (ninguno por defecto; no se cobran solos).
- **Textos de la web**: las Condiciones Generales de Contratación dicen lo mismo que el contrato (la próxima aceptación crea su versión nueva) y la política de privacidad explica el control de accesos y la videovigilancia.
- **Las capturas de las cámaras se borran al mes** de captarse (art. 22.3 de la LOPDGDD), salvo las de eventos vinculados a una incidencia. Lo hace la limpieza diaria de las 04:00 en el worker.

**Antes de usarlo con clientes**: que el abogado revise el texto, sobre todo las condiciones 6 (seguro y responsabilidad) y 12 (impago), y el preaviso de un mes cuando termina el arrendador.

## 115. Desistimiento de los contratos a distancia (2026-11-11)

Migración `20270107100000_contract_withdrawal` (se aplica sola). Sin variables nuevas. **Qué cambia al redesplegar:**

- **Firmar por enlace** (reserva online, contratar otro trastero desde el área de clientes, WhatsApp o el enlace que envía el equipo): si quien firma es un particular y el trastero empieza dentro de los 14 días siguientes a la firma, tiene que marcar la casilla «Quiero empezar a usar el trastero ya…» (art. 98.8 del TRLGDCU). Sin ella no firma (400 `immediate_start_required`). Se guarda cuándo lo pidió y el último día para desistir, y salen en la pestaña Firma y en el PDF del contrato. Firmar en el local o ser una empresa no da derecho a desistir (no hay casilla ni plazo). Las viviendas tampoco (la ley excluye su alquiler).
- **Desistir**: en el área de clientes, cada contrato con plazo dice hasta cuándo y tiene «Desistir del contrato» con lo que se devuelve. En el panel, la ficha del contrato tiene la tarjeta «Desistimiento» con «Registrar desistimiento» para los que llegan por correo o por carta (cuenta el día en que lo comunicó).
- **Qué se devuelve**: lo cobrado de cada factura menos, si pidió empezar ya, la parte de los días que tuvo el trastero; la fianza entera. Con tarjeta o domiciliación se devuelve sola por la pasarela; el efectivo, la transferencia y el pago con tarjeta en la página del banco quedan registrados y el equipo recibe un aviso para devolverlos a mano; un cobro automático con la tarjeta guardada en Redsys se devuelve desde el TPV y se registra después en la factura. Lo no cobrado se anula. El contrato se cancela, el trastero queda libre y se retira el acceso. El inquilino recibe un correo con el acuse y lo que se le devuelve.
- **Textos**: la condición 19 del contrato (desistimiento) y el modelo de formulario al final del contrato de los particulares; las Condiciones Generales de la web también llevan el formulario (la próxima aceptación crea la versión nueva). Los contratos ya firmados no cambian ni tienen plazo de desistimiento registrado.
- **Arreglo**: cancelar una reserva antes de la apertura cobrada con la tarjeta guardada en Redsys ya no falla (devolvía `refund_needs_bank`): queda en el aviso para devolverla desde el TPV.

**Antes de usarlo con clientes**: que el abogado revise la condición 19, el formulario y que los días usados se cobren a la cuota del primer pago.

## 116. Revisión de Cobros: conciliación, remesas, caja, deudores, planes e impagos (2026-11-11)

Migraciones `20270108100000_collections_review` y `20270108110000_collections_review_backfill` (se aplican solas). Sin variables nuevas. Cron nuevo `sepa.mandate-expiry` (05:20, en el API, una vez al día entre réplicas). **Qué cambia al redesplegar:**

- **Quien solo ve unos locales** ya no entra en Conciliación bancaria ni en Remesas SEPA (son de toda la empresa) ni ve la caja global; propietario y gestor no notan nada.
- **Conciliación**: un extracto repetido no se importa dos veces; un abono mayor que la factura pregunta qué hacer con lo que sobra (saldo a favor o devolverlo); se puede deshacer cualquier conciliación, devolución o «ignorado» y borrar un extracto sin nada conciliado.
- **Remesas SEPA**: el resultado del banco solo se registra a partir del día del cargo, con los rechazados marcados antes. Un adeudo que el banco cobró sobre una factura ya pagada queda «Cobrado sin aplicar» con aviso para devolverlo. Desde la remesa se marca un adeudo devuelto y se reenvían los preavisos que no salieron. El relleno de la migración pasa a «sin aplicar» los adeudos que constaban como fallidos sin ser un rechazo del banco.
- **Caja**: con el día cerrado no se pueden registrar cobros, devoluciones, fianzas ni ventas en efectivo de ese día; el cierre se reabre con un motivo (queda la constancia). La fianza aplicada a una factura deja de contar como cobro (la migración reclasifica las ya aplicadas) y Bizum tiene su línea. Cada devolución guarda cómo se devolvió (la migración lo rellena con la forma del cobro).
- **Disputas**: una disputa que gana el negocio en Stripe vuelve a contar el cobro. Conviene tener el evento `charge.dispute.closed` en los dos webhooks de Stripe (plataforma y Connect).
- **Vencimiento**: una factura pasa a vencida el día **siguiente** a su vencimiento, en la hora del negocio (antes, la mañana del mismo día).
- **Planes de pago**: se filtran por los locales de cada usuario, la primera cuota no puede ser pasada y el plan se cancela si se anula una de sus facturas. El inquilino paga la cuota desde su área de clientes (tarjeta guardada, tarjeta o Bizum).
- **Impagos (condición 12 del contrato)**: la deuda de un expediente es solo lo vencido. El candado exige haberle avisado (un recordatorio o la constancia de cómo se le avisó); el requerimiento da 15 días como mínimo desde la entrega (se registra el nº de envío y el día en que lo recibió); el plazo vencido solo se marca pasada la fecha. Después: **resolver el contrato** (termina el contrato y deja el trastero bloqueado con los bienes), **trasladar a custodia** con inventario (el trastero vuelve a la venta) y disponer solo por un cauce legal (resolución judicial, acuerdo escrito o abandono tras 8 semanas de custodia) con su documento. Terminar o cancelar un contrato con un expediente abierto deja el trastero bloqueado. **Expedientes que ya estaban abiertos**: los que estén en «Plazo vencido» siguen por «Resolver el contrato»; los que estén «En disposición» necesitan subir el documento del cauce legal para completarse.
- **Requerimiento en PDF**: cita la condición 12, lo firma la razón social del negocio (o el propietario del local), lleva vencimientos y formas de pago y exige la dirección del inquilino.
- **Escalado**: el aviso legal llega a los días de «Aviso legal a los» (Impagos → Ajustes; 30 por defecto). Si el negocio no usa expedientes o el contrato ya terminó, el equipo recibe un aviso para decidir. El segundo recordatorio ya no amenaza con cortar el acceso si el negocio no corta, y un recargo por mora no lleva corte ni expediente propio.

**Antes de usarlo con clientes**: que el abogado revise el texto del requerimiento y el procedimiento de traslado y custodia.

## 117. Mejoras de Cobros: deudores, caja, recibos devueltos, impagos, remesas y conciliación (2026-11-11)

Migraciones `20270109100000_cash_features`, `20270109110000_returned_receipts_features`, `20270109120000_collections_features`, `20270109130000_sepa_features`, `20270109140000_bank_reconciliation_features` y `20270109150000_bank_statement_balances` (se aplican solas). Sin variables nuevas. Dos tareas diarias nuevas en el API (una vez al día entre réplicas): `sepa.automation` (07:40: remesa automática del mes, aviso de remesas sin confirmar y de mandatos a punto de caducar) y `collections.alerts` (08:30: avisos de los expedientes de impago). **Qué cambia al redesplegar:**

- **Deudores**: filtros por estado del cobro (por reclamar, cobrándose, con plan, sin forma de pago, apartados), llamar y WhatsApp con el importe y el enlace del área de clientes, apartar unos días, «Pago recibido» que reparte el importe entre las facturas vencidas (la más antigua primero), facturas desplegables y CSV. **Cobros del mes**: comparación con el mes anterior, tasa de cobro, lo que falta por cobrar por vía y CSV de lo pendiente a mano.
- **Caja**: fondo de apertura, entradas de cambio y retiradas al banco (cuentan en el efectivo esperado); recuento por billetes y monedas guardado en el cierre; los cobros en efectivo del día con su inquilino; cierre en PDF para imprimir y firmar; historial por mes y caja con CSV. «Hoy» avisa de las cajas de los 7 días anteriores con efectivo y sin cerrar.
- **Recibos devueltos**: un cobro por banco devuelto se marca a mano desde la ficha de la factura, con su código (AM04, MD06…), sin esperar al extracto; reincidentes (2 o más devoluciones en 12 meses); volver a cobrar, recordar el pago y cargar los gastos por recibo devuelto que fija el contrato (factura aparte sin IVA, una por devolución).
- **Impagos**: crear un plan de pagos pausa el expediente y romperlo lo reanuda; retirar el candado y marcar devuelto el sobrante; gastos de traslado y custodia como factura del expediente; acta del traslado, dossier y borrador de monitorio en PDF; lista de comprobación antes del requerimiento. **Cita de retirada**: el inquilino la pide desde su área de clientes y el equipo la concede con una franja y un código de un solo uso (solo si los bienes siguen en el trastero). Avisos en «Hoy» y en el móvil: plazo que vence en 3 días, abandono ya posible, expediente parado 14 días, candado por retirar y sobrante por devolver. **Configuración → Escalado de impagos** reúne los días de los dos recordatorios (antes siempre 1 y 7), el recargo, el corte de acceso y el aviso legal, con una vista previa de las fechas.
- **Remesas SEPA**: remesa automática del mes el día elegido (Configuración → Cobros, apagada por defecto; queda sin confirmar y avisa); ficha de cada remesa con CSV para cuadrar con el banco; subir la respuesta del banco (pain.002) marca rechazados y devueltos con su código; aviso 60 días antes de que caduque un mandato; un solo preaviso por inquilino aunque tenga varias facturas en la remesa.
- **Conciliación**: se puede subir el CSV de movimientos de la banca online además del Norma 43 (las columnas se reconocen por su título o se eligen); cada sugerencia dice por qué (nº de factura, regla, ordenante, importe o varias facturas del mismo inquilino que suman el ingreso); «Recordar» crea una regla para la próxima vez; el abono de una remesa SEPA se concilia de una vez (y la registra si aún no lo estaba); un cargo puede guardarse como gasto. Un CSV sin columna de saldo ya no sale como «fichero que no cuadra»: se enseñan los ingresos y los cargos, sin saldos.

**Antes de usarlo con clientes**: que el abogado revise también el acta del traslado, el borrador de monitorio y la cita de retirada.

## 118. Facturas sin contrato con su local (2026-11-12)

Migración `20270110100000_invoice_facility_backfill` (se aplica sola). Sin variables nuevas. **Qué cambia al redesplegar:**

- Una factura hecha a mano sin contrato (o simplificada) queda en un local: con un solo local, ese; con varios, el que se elige en «Nueva factura» (propone el de arriba o el del inquilino; se puede dejar en «Toda la empresa»). Antes no tenía local y, con un local elegido arriba, la lista de Facturas no la enseñaba.
- La migración pone su local a las facturas que ya había en los negocios de un solo local (sin tocar ventas ni facturas de suscripción).
- También llevan su local la señal de una reserva, el pase nocturno, la venta en mostrador, las rectificativas, el recargo por mora y los gastos por recibo devuelto de una factura sin contrato, y una factura duplicada. Si se cobra en efectivo, cuenta en la caja de ese local.
- Quien solo ve unos locales deja de ver las facturas sin contrato de otros locales (las de toda la empresa las sigue viendo).

## 119. El selector de local con un solo local (2026-11-12)

Solo web, sin migración ni variables. **Qué cambia al redesplegar:**

- Con un solo local, el selector de arriba enseña el nombre del local y ya no filtra ninguna lista (con un local es lo mismo que «Todos»). Así no se pierde lo que no tiene local: inquilinos sin trastero o facturas de toda la empresa. Si alguien lo tenía elegido, deja de aplicarse solo.
- Con varios locales, en Inquilinos los que no tienen trastero salen con cualquier local elegido, con la marca «Sin trastero».

## 120. Leads del panel admin (2026-11-12)

Migración `20270111100000_platform_leads` (se aplica sola). Sin variables nuevas (los leads sin cuenta caducan con `RETENTION_CONTACT_MESSAGES_DAYS`, 730 días). **Qué cambia al redesplegar:**

- **Tenants → Leads** (`/admin/leads`): tablero por fases (Nuevo, Contactado, Interesado, En prueba, Cliente, Perdido), ficha con datos, conversación por correo, actividad y seguimientos, y **Resultados** (`/admin/leads/stats`) con el embudo, la conversión y lo que pagan por origen, el tiempo de primera respuesta y los motivos de pérdida.
- Los mensajes del formulario de trasteros.pro entran como leads (o se suman al lead con ese email o teléfono). En Web de TrasterOS ya no está la bandeja de «Mensajes recibidos»: lleva a Leads. La migración pasa a leads los mensajes que ya había y los tenants que están ahora en prueba.
- Registrarse en la web (o crear una cuenta desde el panel) la une al lead con su email o crea uno «En prueba». Pasa a «Cliente» con el primer pago; si la prueba acaba sin pagar, a «Perdido» con un seguimiento para volver a llamarle a los 14 días. Lo hace la tarea `platform-leads.watch` (cada 15 min, en el API), que también avisa (panel, móvil y Telegram/Slack si están activados los avisos de contacto) de los leads nuevos que llevan 4 horas sin atender.
- Desde la ficha: crear su cuenta (como «Nuevo tenant», solo superadmin), vincularla a una cuenta que ya existe y enviarle una propuesta del simulador aunque aún no tenga cuenta (le llega con un botón al registro con sus datos puestos; al registrarse, la propuesta le espera en «Suscripción»).
- «Hoy» enseña los leads nuevos sin atender y los seguimientos de leads de hoy; Seguimientos, también los de leads.
- trasteros.pro recuerda de dónde viene la visita (Google, anuncios, redes) y lo guarda en el lead al escribir o registrarse.
- El rol soporte trabaja los leads; crear su cuenta, enviar propuestas y borrar un lead son del superadmin.

## 121. Reservas antes de la apertura sin fecha: el contrato no pone ninguna (2026-11-12)

Solo código, sin migración ni variables. **Qué cambia al redesplegar:**

- En una reserva de un local en «próxima apertura» **sin fecha de apertura**, el contrato ya no dice que empieza en una fecha lejana: la fecha guardada era la fecha límite (la reserva + el plazo máximo, 6 meses por defecto) y las condiciones estándar la ponían como inicio («El contrato empieza el …»). Ahora dice «El contrato empieza el día de apertura del local», también en las plantillas propias que usen `{{startDate}}`. Con fecha de apertura, sigue saliendo esa fecha (aproximada).
- La garantía de la reserva se dice en meses: «Si pasados 6 meses desde la reserva el local aún no ha abierto, el inquilino puede dejar la reserva sin efecto y recuperar todo lo pagado» (antes, con la fecha límite).
- Los contratos ya firmados no cambian (su texto queda como se firmó); vale para las reservas nuevas y los borradores sin firmar. Si se espera abrir antes, el plazo máximo se baja en la ficha del local → Ajustes.

## 122. SEO local de las páginas de cada local (2026-11-12)

Solo web, sin migración ni variables. **Qué cambia al redesplegar** (la web se reconstruye sola; Google tarda unos días en volver a leer las páginas):

- **Ficha de cada local** (`/<local>`): título «Trasteros en <localidad> (<local>) desde X €/mes · <negocio>» (sin repetir el nombre si es el de la localidad, y sin el precio si no cabe), descripción con la dirección, los tamaños y el precio, encabezado «Trasteros en <localidad>», un párrafo de presentación con la dirección, los tamaños, el precio y lo que tiene el centro, «Tamaños y precios de los trasteros en <localidad>», texto alternativo de las fotos con la localidad y preguntas frecuentes con sus datos (cuánto cuesta, dónde está con las indicaciones, horario o acceso 24 h, reserva online). Si el negocio escribió el texto de su zona (extra SEO local), se ve el suyo en vez del párrafo y sus preguntas van primero.
- **Datos estructurados** de la ficha: descripción, características (`amenityFeature`), cada tamaño con su precio al mes con IVA (`makesOffer`) y la miga de pan con la página de la ciudad, igual que la que se ve.
- **Portada**: si el negocio no ha puesto su título en Configuración → Web → SEO, el título es «Trasteros en <localidad> desde X €/mes · <negocio>» salvo que el titular de la portada ya diga la localidad; la descripción lleva la localidad y el precio. Con un solo local es la página que Google toma como principal (la ficha la señala como canónica).
- **Página de la ciudad** (`/trasteros-en-<localidad>`): el precio en el título y, si la ciudad tiene un solo local (la ficha de ese local redirige aquí), la descripción con su dirección, tamaños y precio.
- Para revisarlo: Search Console → Inspección de URLs con la ficha de un local, y la [prueba de resultados enriquecidos](https://search.google.com/test/rich-results) para ver las preguntas frecuentes.

## 123. trasteros.pro para Google y para captar: páginas, demo, calculadora y blog (2026-11-12)

Migración `20270112100000_platform_blog` (se aplica sola: tabla global `platform_blog_posts` con REVOKE y 4 guías **en borrador**). Sin variables nuevas. **Qué cambia al redesplegar:**

- **Portada**: titular con lo que se busca («Software de gestión de trasteros y self-storage»), botones «Probar 30 días gratis» y «Pedir una demo», captura del panel, cada funcionalidad enlaza a su página, testimonios (si hay), precios con el cambio mensual/anual, formulario de demo, calculadora y últimas guías del blog, y un botón fijo abajo en el móvil.
- **Páginas nuevas** (todas en el mapa del sitio y con sus datos para Google): `/funcionalidades` y 9 páginas de funcionalidad (Veri\*Factu, cobros, accesos, reserva online, contratos, impagos, web y SEO local, área de clientes, plano), `/soluciones` y 3 por tipo de cliente (operadores, administradores, trasteros y viviendas), `/precios` (planes, comparativa sacada del catálogo y preguntas), `/blog` y `/calculadora-rentabilidad-trasteros`. El menú y el pie apuntan a ellas.
- **Pedir una demo** (portada, precios, cada página y cada guía): nombre, email, teléfono, trasteros y empresa. Entra en **Leads** con el origen «Petición de demo» aunque el formulario de contacto esté apagado; si el formulario tiene email de destino, también te llega por correo.
- **Calculadora de rentabilidad**: ingresos, gastos, beneficio, ocupación con la que se cubren gastos y meses para recuperar la inversión, en el navegador. Quien pide el informe lo recibe por correo (remitente «Contacto web») y entra en Leads como «Calculadora de rentabilidad» con sus cifras.
- **Testimonios**: panel admin → Web de TrasterOS → Textos de la portada → «Testimonios de clientes» (hasta 6: texto, nombre, cargo y negocio). Solo clientes reales con su permiso; sin ninguno, la sección no sale. Se ven en la portada y en Precios.
- **Blog de TrasterOS**: panel admin → Plataforma → **Blog de TrasterOS** (`/admin/blog`): escribir en Markdown con vista previa, portada (JPG, PNG o WebP de 5 MB, bucket público `platform/blog/…`), título y descripción para Google y publicar. Trae 4 guías en borrador (montar un negocio de trasteros, Veri\*Factu, impagos y control de accesos): **revísalas y publícalas juntas**, porque se enlazan entre ellas.
- **Pie por defecto** con las páginas nuevas. Si guardaste un pie propio en Web de TrasterOS, sigue el tuyo: añade los enlaces nuevos o pulsa «Restaurar el de por defecto».

**Tras desplegar (fuera del código):**

1. Search Console y Bing: volver a enviar `https://trasteros.pro/sitemap.xml`.
2. `www.trasteros.pro` no carga: en Nginx Proxy Manager, un Proxy Host (o Redirection Host) de `www.trasteros.pro` que redirija a `https://trasteros.pro` con su certificado.
3. Revisar en `/admin/plans` el precio anual de cada plan: la página de Precios enseña el ahorro del pago anual («ahorra hasta un N %») y sale de esos precios.
4. Publicar las guías y añadir los testimonios que tengas.

## 124. Imágenes compiladas en GitHub (GHCR): el servidor ya no compila (2026-11-12)

El despliegue del 12-11 dejó la web y la API sin responder durante más de hora y media: Portainer compilaba en el servidor (CX22, 4 GB) cinco imágenes a la vez —`migrate`, `bootstrap` y `api` compilaban cada uno la de la API, más el worker y la web— con Postgres, Redis y la API vieja funcionando, y la máquina se quedó sin memoria (Nginx Proxy Manager dejó de atender). Ahora las compila GitHub y el servidor solo las descarga.

**Qué cambia**

- `.github/workflows/images.yml` («Imágenes Docker (GHCR)»): en cada push a `main` compila `api`, `worker` y `web` y las sube a `ghcr.io/dignitasjota/storageos-<servicio>` con las etiquetas `latest` y `sha-<commit>`. En una PR que toca los Dockerfiles o las dependencias solo compila (sin subir). Usa la caché de GitHub: la primera vez tarda unos 15 min; después, bastante menos.
- La web lleva horneadas las URL públicas: salen de las **variables del repositorio** (Settings → Secrets and variables → Actions → Variables) `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL` y `MINIO_PUBLIC_URL` (ya creadas: `https://api.trasteros.pro`, `https://trasteros.pro`, `https://files.trasteros.pro`). Las de Portainer con esos nombres ya no se usan para compilar (el API sigue usando su `MINIO_PUBLIC_URL`).
- `docker-compose.portainer.yml`: `api`, `worker`, `web`, `migrate` y `bootstrap` usan `image:` (sin `build:`) con `pull_policy: always`. Variable opcional del stack `IMAGE_TAG` (vacía = `latest`; `sha-<commit>` para volver a una versión).
- `deploy.yml` ya no se lanza con cada push: espera a que las imágenes terminen bien.
- Al compilar, la web pide a la API de producción los datos de la portada, `/precios`, el blog y los textos legales. Esas llamadas tienen ahora un límite de 8 s (`serverApiTimeout` en `apps/web/src/lib/server-api.ts`): con la API caída, la primera compilación en GitHub fallaba (Next da 60 s por página) y no se podía desplegar el arreglo. Si no responde, la página se genera al visitarla con los datos de respaldo y se refresca sola.

**Pasos (una sola vez), en este orden**

1. Fusionar la PR. En GitHub → **Actions** → «Imágenes Docker (GHCR)», esperar a que las tres imágenes salgan en verde.
2. Hacer **públicas** las tres imágenes (no llevan secretos: solo el código compilado, y el repositorio ya es público): github.com/dignitasjota → **Packages** → `storageos-api` → **Package settings** → **Change visibility** → Public. Lo mismo con `storageos-worker` y `storageos-web`. (Si se prefieren privadas: token de GitHub con `read:packages` y, en Portainer → Registries, un registro `ghcr.io` con ese token.)
3. Con el servidor recuperado (ver «Si se vuelve a quedar sin memoria»), en Portainer → el stack → **Pull and redeploy** con **Re-pull image** marcado. Descarga las imágenes, aplica las migraciones pendientes (`migrate`) y arranca. Tarda unos minutos.
4. Opcional: el webhook de §6C para que cada fusión se despliegue sola.
5. Limpiar lo que dejaron las compilaciones antiguas: `docker builder prune -af` (por SSH) y, en Portainer → Images, las imágenes `storageos-prod-*` sin uso.

**Si se vuelve a quedar sin memoria** (la web no responde durante un despliegue): por SSH, `free -h`, `df -h /` y `ps aux --sort=-%mem | head`; cortar la compilación con `pkill -f "next build"; pkill -f "nest build"` o, si no basta, `systemctl restart docker` (los datos de Postgres están en volúmenes); si el SSH no responde, reiniciar desde la consola de Hetzner. Comprobar que hay swap (`swapon --show`, §1.6).

## 125. Reserva online: la primera factura se emite al cobrarse (2026-11-12)

Hasta ahora, al firmar una reserva online se emitía la factura del primer pago; si el inquilino no pagaba en 72 h, la reserva se cancelaba y la factura se anulaba con una rectificativa (dos facturas en los libros por cada reserva abandonada). Ahora el contrato entra en vigor con el primer pago y la factura se emite al cobrarlo (devengo del pago anticipado, art. 75.Dos LIVA; arts. 2.1 y 11 del Reglamento de facturación).

**Qué cambia**

- Migración `20270113100000_invoice_issue_on_payment` (`invoices.issue_on_payment` + índice parcial). Se aplica sola con `migrate`.
- Al firmar por enlace una reserva online (web, área de clientes, WhatsApp o reserva anticipada), la primera factura queda como borrador «Pendiente de pago»: importes fijados, sin número ni registro Veri\*Factu. A 0 € (cupón) se emite y queda pagada como antes. Un contrato del panel enviado a firmar sigue emitiéndola al firmar.
- Se emite al cobrarse: tarjeta o Bizum (Redsys, Stripe), «Registrar cobro» en el panel (transferencia, efectivo, TPV) o, si el inquilino eligió domiciliar, al firmar el mandato (la remesa necesita el número). Antes de mandar al TPV se comprueba que se podrá emitir. Si la emisión falla después de cobrar, el cobro queda guardado y llega el aviso «Cobro recibido sin factura emitida»: al pulsar «Emitir» queda pagada.
- Si la reserva caduca sin pagar, el borrador se anula: no gasta número ni hace rectificativa, y no sale en la exportación para la asesoría.
- El contrato de la reserva online lleva la línea «Entrada en vigor: con el primer pago…» y las Condiciones Generales de Contratación por defecto, dos párrafos nuevos (§4 y §6). **Los tenants con condiciones generales propias deben añadirlos a mano.** Cambiar el texto genera una versión nueva de las condiciones: quien estuviera firmando justo en el despliegue verá «las condiciones han cambiado» y tendrá que recargar.
- Transferencia: el concepto pasa a ser el número de contrato (la factura aún no tiene número).
- Quien empezó una reserva y no llegó a firmar: a los 30 días se anonimiza su ficha y se retira el borrador del contrato (tarea diaria de limpieza). El contacto sigue en Leads.
- Las reservas firmadas antes del despliegue siguen con su factura ya emitida.

**Pendiente de la asesoría** (consultadas el 12-11): conformidad con emitir al cobrar, la fianza retenida por un servicio (limpieza, vaciado) y el depósito de fianzas de trasteros en la comunidad autónoma.

## 126. Revisión de Gastos y Fiscalidad: arreglos (2026-11-13)

Migración `20270114100000_expenses_fiscal_review` (se aplica sola):

- La referencia de los gastos sincronizados de Google o Meta Ads pasa a ser única por empresa (antes, entre todas: a la segunda empresa con el mismo id de campaña le fallaba la sincronización).
- `expenses.recurring_expense_id`: de qué plantilla sale cada gasto generado.
- `invoices.customer_name_snapshot`, `customer_tax_id_snapshot` y `customer_address_snapshot`: los datos del cliente al emitir. Las ya emitidas se rellenan con los datos que tiene hoy la ficha (los mejores que hay); las nuevas, al emitirse. El libro de IVA, el 347 y las exportaciones los usan, así no cambian si se edita o se anonimiza la ficha.

**Gastos**

- La cuenta de resultados va sin IVA y con las mismas reglas que el Resumen (una sustitutiva cuenta la diferencia, los abonos restan); cada factura va al local de su contrato, al suyo propio o al de su venta; el cobrado se cuenta por días en la hora del negocio. Sin permiso de facturas o de cobros, esas columnas no salen.
- Alcance por local en todo (lista, total, alta, edición, borrado, cuenta de resultados y recurrentes). Quien solo ve unos locales no apunta gastos de toda la empresa (403 `facility_required`).
- El local y el canal de marketing tienen que ser de la empresa (400 `facility_not_found` / `marketing_channel_not_found`). El canal se quita si el gasto deja de ser de Marketing.
- Fechas, local, categoría e importe validados (400 en vez de 500). Importe máximo 99.999.999,99 €.
- Recurrentes: cada plantilla se reserva antes de crear su gasto (dos «Generar ahora» a la vez ya no duplican), el mes va en la hora del negocio y una empresa dada de baja deja de generarlos.
- Los gastos de Google o Meta Ads se ven como tales y no se editan ni se borran a mano (409 `expense_synced`).
- `GET /expenses/total` (número e importe de lo filtrado). Pantalla: errores visibles, periodo hasta fin de mes, selector de fecha propio, buscador, notas y origen.

**Fiscalidad**

- Solo para quien ve todos los locales (403 `fiscal_requires_all_facilities`; sale del menú para el resto).
- Exportación para la asesoría: la factura anulada por error sale con importe 0 y «Anulada por error»; el cobro devuelto por el banco sale en positivo en su fecha y en negativo en la de la devolución; la fianza devuelta por el cobro no se repite al liquidarla y no se devuelve una que no se cobró.
- Modelo 347 por NIF (dos fichas con el mismo NIF suman juntas).
- Trimestre del 303 validado (400 `invalid_quarter`). CSV del 303 y avisos de error en las cuatro pestañas.

## 127. Gastos: proveedores, desglose de IVA, justificantes, pago y cuenta de resultados (2026-11-13)

Migración `20270115100000_expenses_features` (se aplica sola). Tablas nuevas con RLS: `expense_suppliers` (proveedores), `expense_categories` (categorías propias) y `expense_budgets` (presupuesto mensual por categoría).

**`expenses`**

- proveedor (`supplier_id`), NIF y número de factura;
- desglose: base, tipo y cuota de IVA, si el IVA se deduce, retención con su modelo (111 o 115) y total a pagar;
- justificante (`receipt_*`);
- pago: estado, fecha, forma, vencimiento y la salida de caja (`cash_movement_id`).

Los gastos que ya había se dan por pagados el día del gasto.

**`recurring_expenses`**

- frecuencia (cada mes, trimestre o año), mes de inicio y fecha de fin;
- proveedor, desglose y forma de pago.

Las plantillas que ya había empiezan el mes en que se crearon.

**Nada que configurar**

- `amount` sigue siendo lo que cuesta el gasto: la base más el IVA que no se deduce. Sin desglose, el importe. Así no cambian el Resumen, Marketing ni las liquidaciones de propietarios.
- El justificante va al bucket privado `uploads` (`<tenant>/expenses/…`). Los que se suben y no se guardan se borran a las 24 h en la limpieza diaria.
- Leer un justificante con IA solo funciona con el asistente IA en el plan y gasta una consulta del mes. Con `AI_PROVIDER=stub`, devuelve un ejemplo.
- Un gasto pagado en efectivo apunta una salida en la caja del día (tipo `expense_payment`). Si ese día ya está cerrado, avisa y no la apunta. Esa salida no se puede quitar desde la caja: se quita marcando el gasto como pendiente o borrándolo.
- Los gastos por pagar que vencen esta semana salen en «Hoy» y en el resumen del día por correo.

## 128. Fiscalidad: libros, 303 completo, 347, retenciones, cierre del trimestre y asesoría (2026-11-13)

Migración `20270116100000_fiscal_features` (se aplica sola):

- tabla `fiscal_period_closures` con RLS: cierre de un trimestre con la foto de sus cifras, quién lo cerró y, si se reabre, quién, cuándo y por qué. Un cierre vigente por trimestre;
- en `tenants`: `accountant_email`, `accountant_report_frequency` (`off`, `monthly` o `quarterly`; por defecto `off`) y `accountant_report_last_period`.

**Qué cambia**

- **Modelo 303**: resta el IVA deducible de los gastos desglosados y da el resultado. Los gastos sin desglosar no restan, y se avisa.
- **Modelo 347**: añade los proveedores (sin los gastos con retención, que van al 190 o al 180), lo cobrado en efectivo de cada cliente y quién pasa del umbral sin NIF.
- **Pestañas nuevas**: libro de facturas recibidas y retenciones del trimestre (111 profesionales, 115 alquiler y las que te practican tus inquilinos empresa).
- **«Antes de presentar»** avisa de:
  - facturas completas sin NIF;
  - saltos de numeración;
  - borradores del trimestre;
  - rechazos de la AEAT;
  - gastos sin desglosar, sin NIF del proveedor o sin justificante.
- **Cerrar el trimestre** (cuando ya ha terminado): guarda las cifras y, hasta reabrirlo, devuelve 409 `fiscal_period_closed` en estos casos:
  - crear, editar las cifras o borrar gastos de ese trimestre (las notas y el pago sí se pueden cambiar);
  - importar gastos con esa fecha;
  - generar recurrentes con esa fecha;
  - anular por error sus facturas.

  Solo el propietario lo reabre (`billing:configure`).

- **La exportación para la asesoría** lleva una hoja «Gastos» (también en la de la plataforma, con los gastos del negocio propio).
- **Envío a la asesoría**: correo con un enlace al Excel que dura 60 días. Se envía a mano o cada mes o trimestre (cron `fiscal.accountant-report` a las 08:00, hora de Madrid, desde el día 5 del mes o del trimestre siguiente).
  - El Excel va al bucket privado `reports` (`<tenant>/accountant/…`) y se borra a los 61 días en la limpieza diaria.
  - El enlace va firmado con una clave derivada de `MASTER_ENCRYPTION_KEY`. No necesita variables nuevas.
- **Anonimizar** un tenant quita el email de la asesoría.

**Nada que configurar.** Las cifras son un borrador para presentar: conviene que la asesoría revise el primer trimestre.

## 129. Facturas y justificantes que no se llegan a cobrar (2026-11-13)

Sin migración ni variables nuevas. Objetivo: que quien no paga no deje facturas ni rectificativas por medio.

- **Justificante de fianza**: «Anular» ya funciona en uno sin cobrar (antes la vista previa lo bloqueaba) y no hace rectificativa, porque no es una factura.
- **Cancelar un contrato** anula sus borradores (también la primera factura que esperaba al pago) y la fianza sin cobrar. Las facturas emitidas no se tocan.
- **Se emiten al cobrarse** (sin número ni Veri\*Factu hasta que entra el dinero; si no se paga, se anulan sin rectificativa):
  - la fianza de una reserva online;
  - la primera factura de un **contrato del panel firmado por enlace**. Funciona como la reserva online: tiene 72 h desde la firma para pagar y, si no paga, el contrato se cancela solo y el trastero se libera. Antes se emitía al firmar;
  - la señal de una reserva. Si la reserva se convierte en contrato con la señal sin cobrar, la señal se anula: cobra el contrato;
  - la tienda y el pase nocturno del área de clientes. Si el cobro queda en curso (adeudo SEPA), se emite al momento, porque la venta se entrega.
- **Lista de facturas**: botón «Ocultar canceladas», marcado de inicio y recordado en el navegador. Esconde los borradores descartados y los justificantes anulados. Las facturas anuladas (por error o con rectificativa) se siguen viendo.

Los documentos que ya estaban emitidos antes de este cambio siguen como estaban.

## 130. Emails mal escritos y rebotes temporales (2026-11-13)

Migración `20270117100000_email_delivery_checks` (se aplica sola). Sin variables nuevas.

- **Al escribir un email** (reserva online, contacto de la web, landings, chat, widget, registro, portal y altas del panel) sale «¿Querías decir …@gmail.com? Corregir» si el dominio parece mal escrito.
- **Rebote temporal** (Brevo «Soft bounce», Resend `Transient`): el correo queda como rebotado en Comunicaciones con «Rebote temporal: …» y el equipo recibe un aviso (con el email corregido si parece una errata). No bloquea la dirección: si el reintento llega, pasa a entregado.
- **Ficha del inquilino**: «Problema con su email» va encima de las pestañas, con su último correo sin entregar y «Cambiar el email».
- **Correo saliente** (panel admin) dice cuándo llegó el último aviso de Brevo y de Resend.

**Pasos a mano para que funcione:**

1. En Portainer, `EMAIL_WEBHOOK_TOKEN` con un valor aleatorio largo (si no está ya).
2. En Brevo → Transactional → Settings → Webhook: la dirección que enseña Correo saliente (`…/webhooks/email-events/brevo?token=<EMAIL_WEBHOOK_TOKEN>`) con los eventos Delivered, **Soft bounce**, Hard bounce, Invalid email, Blocked, Error y Spam.
3. Comprobar en Correo saliente que aparece «Último aviso recibido» tras enviar algún correo.

## 131. Contratos pendientes de firmar en el área de clientes (2026-11-13)

Sin migración ni variables nuevas.

- El área de clientes enseña en Inicio y en Contratos la tarjeta **«Pendiente de firmar»**. Recoge los contratos que se le enviaron para firmar, o la reserva online que no llegó a firmar, con el plazo hasta el que se le guarda el trastero.
- **«Firmar»** abre la firma con un enlace nuevo, aunque el del correo haya caducado o se haya sustituido. El enlace anterior deja de valer.
- Los borradores que el equipo aún está preparando (sin enviar a firmar) no salen.

## 132. Condiciones específicas de cada contrato (2026-11-14)

Migración `20270118100000_contract_specific_conditions` (`contracts.specific_conditions`, se aplica sola). Sin variables nuevas.

- En el alta del contrato (paso 3) y en «Editar» del borrador hay un campo **«Condiciones específicas de este contrato»**. Por ejemplo: «Si el local no está abierto el 1 de marzo, el inquilino puede cancelar sin coste».
- Van en el texto que firma el inquilino, después de las condiciones generales («Condiciones específicas de este contrato:»). Por eso cuentan en la huella de la firma y salen en el PDF y en el área de clientes. Se ven en la tarjeta «Condiciones» de la ficha.
- **Solo se cambian en borrador.** Tras la firma, `PATCH /contracts/:id` responde 400 `contract_not_draft` («añade un anexo»).
- La app no aplica la condición sola: si se cumple, la cancelación sin coste se hace desde el panel, como cualquier otra.

## 133. Anexos a un contrato firmado (2026-11-14)

Migración `20270119100000_contract_annexes` (tabla `contract_annexes` con RLS, se aplica sola). Sin variables nuevas.

- **Panel**: ficha del contrato → pestaña «Firma» → **«Anexos»** → «Nuevo anexo» (asunto y texto). Solo en contratos firmados; en un borrador, las condiciones van en el propio contrato (§132).
  - El inquilino recibe un correo para firmarlo, en su idioma. El enlace vale 14 días.
  - Mientras está pendiente se puede **reenviar** (enlace nuevo; el anterior deja de valer) o **cancelar**.
  - Firmado, se ve la firma con la IP, el navegador y la huella del texto, y se descarga en PDF. El equipo recibe un aviso y queda en el historial del contrato.
- **Área de clientes**: el anexo pendiente sale en «Pendiente de firmar» con «Firmar». Firmado, sale en «Anexos de tus contratos» con su PDF.
- **Firma**: página `/sign/annex/<token>` (también con dominio propio). Se firma dibujando o escribiendo el nombre. El texto se congela al crear el anexo; para corregirlo hay que cancelarlo y crear otro.
- **RGPD**: la exportación de datos del inquilino incluye sus anexos y anonimizar quita la IP, el navegador y el email. El vaciado de datos de prueba los borra.
- El PDF se genera la primera vez que se pide y se guarda en el bucket `uploads` (`<tenant>/contracts/<contrato>/annexes/<anexo>.pdf`).

## 134. Revisión de Subidas de precio y Renovaciones (2026-11-14)

Migración `20270120100000_rent_increases_review` (se aplica sola): `tenants.rent_increase_notice_days` (30), `rent_increases.cancelled_at` y, en `rent_increase_items`, la fecha de cada contrato (`effective_date`, rellenada con la de su tanda) y la constancia del aviso (`notice_status`, `notice_communication_id`, `notice_sent_at`). Sin variables nuevas.

**Qué cambia para el negocio**

- Las subidas empiezan siempre un día 1 y con el preaviso de la política (30 días por defecto; se cambia en Subidas de precio → Política). No se puede elegir una fecha anterior.
- Quedan fuera los contratos con la baja pedida, los que terminan antes, las viviendas (van por la actualización anual), los que ya tienen otro cambio de cuota programado y lo que excluye la política. La pantalla dice cuántos y por qué, y avisa si alguno ya tuvo una subida en los últimos 12 meses.
- Quien paga por adelantado cambia al empezar su siguiente periodo.
- El aviso al inquilino lleva la cuota con IVA y su descuento, va en su idioma, queda en su ficha y le recuerda que puede darse de baja antes sin preaviso. Si se cancela la subida, se le avisa.
- Al llegar la fecha, un contrato cuya cuota cambió desde el aviso o que pidió la baja no se toca; el equipo recibe un aviso.
- **Horarios**: las cuotas programadas se aplican a las 00:05 de Madrid (`contracts.scheduled-changes`) y las subidas a las 00:10 (`rent-increases.apply`), antes de la facturación (02:00 UTC). La factura del mes sale con la cuota nueva aunque ese proceso no haya corrido.
- **Actualización anual**: se programa para su aniversario y avisa al inquilino; no se pierde a los 60 días.
- **Renovar**: un contrato sin fecha de fin no se renueva; con cuota nueva sale un solo correo; un doble clic ya no renueva dos veces.
- **Renovaciones** enseña también los contratos vencidos que siguen abiertos.
- Los cambios de cuota próximos salen en «Hoy», en el calendario, en la ficha del contrato y en el área de clientes.

**Antes de desplegar**: las subidas ya programadas siguen con su fecha aunque no sea día 1 ni respete el nuevo preaviso (se avisó con las reglas anteriores).

## 135. Cartera: mejoras de Subidas de precio y Renovaciones (2026-11-14)

Migración `20270121100000_portfolio_features` (se aplica sola): en `contracts`, `rent_increase_exempt_until`/`rent_increase_exempt_reason` («no subir hasta…») y `anniversary_update_pct` (% propio de la actualización anual); `tenants.rent_increase_notice_template` (texto propio del aviso) y, en `contract_annexes`, `action`/`action_applied_at`/`action_error` (lo que hace un anexo al firmarse). Sin variables nuevas.

**Qué cambia para el negocio**

- **Subidas en cuatro pasos**: a quién, cuánto y desde cuándo, repasar la lista (se puede desmarcar a cualquiera) y ver el correo exacto que le llega a cada inquilino antes de enviarlo.
- **Hasta el precio de tarifa**: tercera forma de subir; cada inquilino sube hasta el precio actual de su trastero, sin pasar del % que se ponga. Quien ya paga la tarifa no entra.
- **Texto del aviso** editable (español e inglés, con variables). La frase de que puede darse de baja antes sin preaviso se añade siempre.
- **Ficha de cada subida**: si el aviso se entregó o rebotó, reenviarlo, quitar a un contrato (se le dice que queda anulada) y, cuando ya se ha aplicado, lo que se cobra de más, lo facturado y quién se fue tras el aviso.
- **Renovaciones**: 30, 60, 90 días o vencidos, con cuota, antigüedad, deuda, teléfono y riesgo de baja, y CSV. **Oferta de renovación**: el inquilino la firma como anexo (correo o área de clientes) y el contrato se renueva solo; si entretanto cambió, no se aplica y se avisa al equipo.
- **Aviso de prórroga**: 30 días antes de que un contrato con renovación automática se prorrogue, el inquilino recibe la fecha y hasta cuándo puede darse de baja (se apaga en Configuración → Correo).
- **Cuotas previstas** (Cartera): todos los cambios de cuota que vienen, de dónde salen y cuánto suman.
- **Ficha del contrato → Cobro y condiciones → Cuota**: historial de la cuota con lo previsto, «no subir hasta…» y % propio de la actualización anual.

## 136. Revisión de Operaciones diarias (2026-11-14)

Migración `20270122100000_daily_ops_review` (se aplica sola): `incidents.visible_to_customer` (las que reportó el inquilino desde el área de clientes quedan visibles) y `business_reminders.anchor_day` (el día del mes de un vencimiento que se repite, relleno con el de su fecha). Sin variables nuevas.

**Qué cambia para el negocio**

- **Tareas**: una tarea abierta se puede dar por hecha sin pasar por «En curso», y una hecha o cancelada se puede reabrir. Desde la ficha se edita (también quitar la fecha) y se borra. El responsable tiene que estar activo y el trastero ser del local elegido (si solo se elige el trastero, la tarea toma su local). Dos personas marcando puntos de la misma ronda ya no se pisan.
- **Tareas automáticas**: solo las cambia quien ve todos los locales. «Llamar para renovar» sale otra vez en cada vencimiento (antes, una sola vez por contrato).
- **Incidencias**: el inquilino solo ve en su área de clientes las que reportó él y las que el equipo marque «Visible para el inquilino»; las notas internas sobre él ya no le salen. Cuando se cierran ve la respuesta y la fecha. Las que reporta se enlazan a su contrato si tiene uno solo. Al resolver o descartar se pide qué se ha hecho. Desde la ficha se edita la gravedad, el responsable, el local, el trastero y si la ve el inquilino. «Abrir incidencia» desde un punto de una ronda no crea dos. El aviso de una incidencia abre su ficha y el contador del menú cuenta los locales de cada persona.
- **Mantenimiento**: un plan con fecha de inicio pasada empieza hoy (sin tareas ya vencidas); cambiar el título u otro dato que no sea la frecuencia no mueve la próxima fecha; al reactivar un plan sigue desde hoy. «Generar ahora» crea ya la siguiente tarea (no adelanta otra si la anterior sigue abierta). Se elige el responsable y le llega un aviso con cada tarea. Las fechas van en la zona horaria del negocio.
- **Calendario**: cada tipo de evento sale solo a quien puede ver su apartado (tareas, contratos, reservas, vencimientos). Las tareas borradas ya no salen, un contrato con renovación automática sale como «Se prorroga» y los planes de mantenimiento enseñan todas sus repeticiones del mes. «+N más» abre la lista del día.
- **Vencimientos**: un doble clic en «Hecho» ya no apunta dos gastos; uno del día 31 vuelve al 31 después de febrero; guardar otro dato no quita el «pospuesto»; una plantilla no se añade dos veces; uno hecho por error se puede reabrir, y todo queda en el registro de actividad. El resumen semanal y el enlace del calendario solo los cambia quien ve todos los locales.

**Antes de desplegar**: las incidencias que el equipo creó con un inquilino dejan de verse en su área de clientes; si alguna debe verla, se marca «Visible para el inquilino» en su ficha.

## 137. Operaciones diarias: mejoras (2026-11-14)

Migración `20270123100000_daily_ops_features` (se aplica sola): `tasks.photos`, en `maintenance_plans` `lead_days`/`estimated_cost`/`supplier_id`, en `incidents` `category`/`photos`/`response_due_at`/`first_response_at`/`cost`/`expense_id`/`insurance_claim_*`, `tenants.incident_response_hours` y `business_reminders.attachments`. Los planes semanales pasan a «cada 1 semana» (antes «cada N» no contaba en los semanales). Las incidencias abiertas que ya no estaban «reportadas» cuentan como respondidas. Sin variables nuevas.

**Qué cambia para el negocio**

- **Tareas**: vistas de pendientes (atrasadas, hoy, esta semana, sin fecha), fotos y documentos, «Apuntar el gasto» (con el coste y el proveedor del plan de mantenimiento) y el número de «mis tareas» atrasadas o de hoy en el menú.
- **Mantenimiento**: cada N semanas, «el último día del mes», crear la tarea unos días antes, coste previsto y proveedor, historial de cada plan (hechas a tiempo, atrasadas) y «Copiar a otros locales».
- **Calendario**: filtrar por tipo (se recuerda), «+» en cada día para crear una tarea, facturas que vencen y documentos de los locales que caducan. El enlace del calendario de Vencimientos puede llevar también las tareas y las entradas y salidas de inquilinos.
- **Vencimientos**: deshacer el último «hecho» (vuelve a su fecha y borra el gasto si se puede), documentos (contrato, póliza…), crear una tarea, previsión de 12 meses con lo que suman, filtros y el número de los que tocan en el menú.
- **Incidencias**: tipo (daños, agua, cerradura…), plazo de la primera respuesta según la gravedad (Incidencias → Plazos; las que se pasan salen «Fuera de plazo»), resolución obligatoria al cerrar, fotos (también las que sube el inquilino al reportar, eligiendo su trastero), responder al inquilino por su chat, tarea de reparación, coste y gasto, parte al seguro e informe por tipo, gravedad y local.
- **RGPD**: anonimizar a un inquilino borra las fotos de sus incidencias.
- **Menú**: los números de los subapartados (Incidencias, Tareas, Vencimientos…) salen en su fila; antes caían una fila más abajo.

## 138. Revisión de Leads, Seguimientos y Oportunidades (2026-11-15)

Migración `20270124100000_leads_review` (se aplica sola): `leads.booked_at` y `leads.returned_at`, `tenants.lead_retention_months` (12), `customer_offers.metadata`. Al aplicarla:

- los contactos «ganados» por una reserva online que nunca se firmó vuelven a «Cualificado»;
- los seguimientos pendientes de contactos perdidos o borrados y de inquilinos borrados se cancelan.

Sin variables nuevas. Cron nuevo `leads.retention` (04:40, en el API).

**Qué cambia para el negocio**

- **Reserva online**:
  - el contacto se gana al firmar (antes, al reservar). Si la reserva caduca, vuelve a abierto con una nota y su responsable recibe un aviso para llamarle;
  - el contacto conserva su primer origen: el de un presupuesto o el de otra visita se guardan aparte;
  - dejar el email en la reserva ya no crea un contacto repetido.
- **Locales**: quien solo ve unos locales ve los contactos de sus locales y los que no eligieron local. Lo mismo en Seguimientos, «Hoy», Duplicados y tiempos de respuesta, y los seguimientos de inquilinos de otros locales dejan de verse.
- **Bajas comerciales**: se mantienen al convertir en cliente y al fusionar duplicados.
- **Conversión**: el doble clic en «A cliente» crea un solo inquilino. Convertir lanza las automatizaciones de alta y borra el motivo de pérdida.
- **Contactos repetidos**:
  - el teléfono se compara por sus cifras («600 555 444» es «+34600555444»);
  - quien vuelve a escribir avisa a su responsable y sale marcado en la tarjeta.
- **Responsable** visible y editable en la ficha, con filtro «Solo los míos». Los avisos de reparto y de «sin atender» van a esa persona.
- **Tiempos de respuesta**:
  - la primera respuesta no se pisa;
  - no se admite una llamada con fecha futura;
  - responder por WhatsApp o por el chat de la web cuenta como atendido;
  - las reservas online no cuentan.
- **Ficha del lead**:
  - se pueden vaciar campos;
  - «Borrar» elimina sus datos (nombre, email, teléfono, mensajes, notas, seguimientos y conversaciones);
  - las fases que ofrece son solo las permitidas.
- **Datos de los perdidos**: los contactos perdidos sin actividad en 12 meses se anonimizan solos (plazo en Leads → Atención).
- **Oportunidades**:
  - «Ha tenido facturas vencidas» solo si las tuvo de verdad;
  - fuera el inquilino de prueba;
  - no se manda dos veces la misma propuesta;
  - lo enviado por WhatsApp queda registrado;
  - el pase nocturno no suma al potencial mensual;
  - «Me interesa» crea un seguimiento para quien la propuso.
- **Errores 500**: se acabaron los de filtros y fechas imposibles (también en el formulario público), y los datos de otra empresa se rechazan.

## 139. Leads, Seguimientos y Oportunidades: mejoras (2026-11-15)

Migración `20270125100000_leads_features` (se aplica sola):

- en `leads`: `reply_token`, `nurture_step` y `nurture_last_at`;
- en `tenants`: `lead_nurture_enabled` (apagado), `lead_use_business_hours` (apagado) y `lead_quote_reminder_days` (3);
- en `lead_followups` y `customer_followups`: `assigned_to_user_id` y `outcome`;
- tablas nuevas `lead_quotes`, `lead_visits` y `opportunity_dismissals`, con RLS.

Sin variables nuevas. Las respuestas por correo de los contactos usan el mismo `INBOUND_EMAIL_DOMAIN` que la mensajería (§100); sin él, responden al correo del negocio como hasta ahora. Cron nuevo `leads.automations` (cada hora, minuto 25, en el API): correos automáticos, recordatorio de presupuestos y recordatorio de visitas. Cada envío se reserva, así que varias réplicas no lo duplican.

**Qué cambia para el negocio**

- **Leads**:
  - filtros por origen, local, responsable y fecha de llegada, buscador, vista de lista y CSV;
  - cada columna dice cuántos contactos tiene y cuánto sumarían al mes;
  - **Informe** (`/leads/report`): de los que llegaron en el periodo, cuántos se atendieron, se cualificaron y se ganaron, por origen, responsable y local;
  - **Importar** contactos desde CSV o Excel (`/leads/import`). Los importados no reciben correos automáticos ni se reparten.
- **Ficha del contacto**:
  - **cronología** con todo lo que ha pasado: correos con su entrega, respuestas, WhatsApp, chat de la web, actividad, presupuestos, visitas, seguimientos y cambios de fase;
  - **visitas al local**: salen en el calendario, el contacto recibe un recordatorio el día antes y, al marcar «Vino», queda un seguimiento para el día siguiente;
  - **presupuestos**:
    - historial de los enviados;
    - se pueden mandar por WhatsApp desde el móvil (queda registrado);
    - crean un seguimiento para llamarle;
    - opcionalmente, recordatorio por correo a los N días si no reserva;
  - «Hacerle el contrato» (lo pasa a inquilino y abre el asistente con su local y tamaño) y «Lista de espera».
- **Respuestas por correo**: lo que un contacto contesta a nuestros correos vuelve a su ficha y avisa a su responsable.
- **Correos automáticos** (opcional, Leads → Atención): a los contactos de la web, los tamaños y precios al llegar, «¿te ayudamos?» a los 2 días y el último a los 7. Se paran en cuanto alguien del equipo le atiende, reserva o se da de baja; el 2.º y el 3.º solo a quien aceptó recibir ofertas.
- **Horario de atención** (opcional): el plazo de «sin atender» solo corre en el horario de Configuración → Mensajes.
- **Seguimientos**:
  - bandeja única de inquilinos y contactos, con pestañas Hoy, Atrasados, Próximos y Hechos y «Solo los míos»;
  - responsable, posponer, editar y crear desde la bandeja;
  - al marcarlo hecho se anota qué pasó (queda en la ficha) y se puede dejar el siguiente;
  - número en el menú con los de hoy y los atrasados.
- **Oportunidades**:
  - tipos nuevos: renovar (contratos que terminan en 60 días sin renovación automática), pagar el año por adelantado, completar sus datos, reseña en Google (a quien puntuó 9 o 10), recomendar y un trastero más pequeño para quien ha pedido la baja;
  - posponer 30 o 90 días o no volver a sugerir, y recuperarlas;
  - primero quien dijo «Me interesa», con número en el menú;
  - proponer a varios a la vez por correo;
  - **Resultados**: cuántas se propusieron, se vieron y se contrataron, y el ingreso nuevo;
  - filtro por local, buscador y CSV.

**Tras desplegar**: revisar en Leads → Atención si se quieren los correos automáticos y el plazo del recordatorio de presupuestos (3 días por defecto).

## 140. Ampliar el plazo para firmar y pagar (2026-11-15)

Sin migración ni variables nuevas.

En la pestaña **Firma** de un contrato con el trastero reservado (reserva online, o contrato enviado por enlace y firmado sin pagar) aparece **«Ampliar plazo»**:

- **+1, +3 o +7 días**, o hasta una fecha (fin de ese día en la hora del local);
- como mucho **30 días** desde la reserva o la firma;
- con motivo opcional, que queda en el historial del contrato;
- se puede ampliar también cuando el plazo ya ha vencido, mientras la reserva no se haya cancelado.

Mientras dure, el trastero sigue reservado y la reserva no se cancela. Opcionalmente, el inquilino recibe el correo «Te guardamos el trastero hasta el…» con el enlace para firmar (si aún no ha firmado, el enlace vale al menos hasta el plazo nuevo) o para pagar. Ese correo cuenta como el recordatorio automático, para no mandarle otro enseguida.

Los contratos firmados en el local no tienen plazo: no caducan y no se pueden ampliar.

## 141. Revisión de Campañas y Comunicaciones: arreglos (2026-11-16)

Migración `20270126100000_campaigns_review` (se aplica sola al arrancar el API):

- `campaigns.facility_scope` (locales de quien creó la campaña; vacío = toda la empresa) y `campaigns.results_snapshot` (resultados guardados antes de que la limpieza borre los envíos);
- libera las reservas del win-back de los últimos 90 días que no tienen correo (las dejó una variable mal escrita: esos ex-clientes vuelven a poder recibirlo);
- tapa con `••••` el código de los enlaces que dan acceso (firmar un contrato o un anexo, una domiciliación, una valoración, descargar una factura, `?token=`) en los envíos ya salidos del historial.

Sin variables nuevas. Lo que cambia:

- **Textos**: una variable sin cerrar, que no existe o de otra audiencia se rechaza al guardar la campaña, la plantilla o el win-back (400 `invalid_template_text`). Antes la campaña quedaba «Enviada · 0» y el win-back marcaba al ex-cliente como avisado sin escribirle.
- **Alcance por local**: quien solo ve unos locales solo ve en Comunicaciones los envíos de sus inquilinos y contactos, y sus campañas solo llegan a quien ha tenido contrato en ellos (o a los contactos de sus locales). El win-back es de toda la empresa: lo cambian propietario y gestor sin alcance.
- **Historial**: los enlaces con código se guardan tapados; el correo sale completo.
- **Correo de la campaña**: el destinatario ve la dirección que escribió el negocio; el seguimiento del clic va por debajo.
- **Programar** es un solo paso. Un borrador con la fecha pasada avisa de que no salió. No se crea una campaña con fecha pasada ni se envía a nadie (400 `campaign_no_recipients`).
- **Baja de las comunicaciones comerciales por email**: darse de baja (enlace del correo, ficha, área de clientes, queja de spam) vale para todas las fichas con esa dirección. La fusión de inquilinos conserva la baja. Cada dirección recibe la campaña una vez. La baja se cuenta en la última campaña recibida antes de darse de baja, no en todas.
- **Win-back**: nunca a quien se fue debiendo (facturas vencidas o expediente de impago no cobrado) ni a una reserva online que caducó sin pagar; «Enviar ahora» dice a cuántos escribirá y queda en el registro; el segundo aviso se salta si el cupón está agotado.
- **Envíos atascados**: los que llevan 30 minutos pendientes sin trabajo en la cola se vuelven a encolar (cron `communications.requeue-stuck`, cada 10 minutos, en el worker).
- **Avisos**: los rebotes de una campaña dan un aviso al día por campaña, no uno por correo.
- Campañas: ficha con el texto, cambiar el borrador, duplicar, borrar y registro de actividad. Comunicaciones: ficha del envío, «Cargar más» sin páginas, tipos y canales en palabras, sin el filtro de SMS, programados con su fecha y filtros mal puestos → 400.

## 142. Campañas y Comunicaciones: mejoras (2026-11-16)

Migración `20270127100000_campaigns_features` (se aplica sola al arrancar el API): `campaigns.subject_en`, `body_text_en`, `coupon_code` y `whatsapp_template`, y las tablas `campaign_segments` (segmentos guardados), `campaign_automations` y `campaign_automation_sends` (campañas automáticas: un envío por destinatario y periodo), las tres con RLS.

Sin variables nuevas. Lo que trae:

- **Formato en los correos**: negrita, enlaces con texto y botón con el color de la marca, desde una barra en el editor (campañas, win-back y automáticas).
- **«Enviarme una prueba»**: el correo de ejemplo llega al usuario que lo prepara.
- **Versión en inglés** para los inquilinos que tienen el idioma en inglés.
- **Cupón** en la campaña, con la variable `{{coupon.code}}` y su uso en los resultados.
- **Programadas**: quién la recibe se decide al salir (entra quien se dé de alta entretanto y no quien se dé de baja). Las programadas antes de este cambio salen como hasta ahora.
- **Filtros finos** (antigüedad, tamaño, sin seguro, contrato que termina, idioma, sin deudores, contactos recientes), «no escribir a quien recibió otra en N días» y **segmentos guardados**.
- **Resultados con dinero**: contratos firmados, cuotas al mes, contactos ganados y usos del cupón en los 30 días siguientes, y quiénes están detrás de cada cifra.
- **Campañas por WhatsApp** con una plantilla aprobada del número del negocio (necesita el extra WhatsApp Business activo y conectado). Quedan en Comunicaciones y en la bandeja de WhatsApp.
- **Campañas automáticas** (apagadas por defecto): aniversario del inquilino (una vez al año, nunca a quien debe dinero) y contactos que no avanzan (una vez, a los N días sin moverse). Cron `campaigns.automations` a las 09:30 en el API.
- **Comunicaciones**: filtro por tipo y por local, cifras arriba, CSV, ver el correo tal como llegó, recorrido del envío, cancelar uno programado y pestaña **«Direcciones con problemas»**.

**Tras desplegar**: en Campañas, revisar si se activan las campañas automáticas y su texto.

## 143. Fianzas tras la respuesta de la asesoría (2026-11-16)

Migración `20270128100000_deposit_service_invoice` (se aplica sola al arrancar el API): `contracts.deposit_service_invoice_id` y `tenants.deposit_registry_storage` (por defecto, no). Sin variables nuevas.

- **Liquidar la fianza**: si te la quedas, en todo o en parte, por un servicio que haces tú (limpieza, vaciado, retirada de enseres), marca «Todo o parte es por un servicio». Se emite una factura con IVA (21 %, incluido en el importe) pagada con la fianza, y se manda a Veri\*Factu si lo tienes activado. Lo que es deuda se aplica a sus facturas; los daños se retienen sin factura.
- **Depósito de las fianzas de trasteros**: Configuración → Plantilla de contrato → «Depositar también las fianzas de los trasteros». Las de vivienda se depositan siempre. Actívalo solo si tu comunidad autónoma lo pide: la ficha del contrato tendrá dónde anotarlo y «Hoy» avisará de las que faltan.

**Tras desplegar**: preguntar en la Generalitat Valenciana si un trastero alquilado tiene que depositar la fianza y, si es así, activar el ajuste.

## 144. Revisión de Fidelización: arreglos (2026-11-16)

Migración `20270129100000_loyalty_review` (se aplica sola al arrancar el API):

- `promotions.announce_on_web`: en cada negocio queda marcada la promoción que su web anunciaba hasta hoy (la más reciente en vigor), para que el aviso no desaparezca;
- `referrals.reward_applied_amount` (lo ya descontado de una recompensa fija);
- los referidos con la recompensa concedida y sin descontar cuyo recomendado no ha pagado nada vuelven a «pendiente»: se concederá con su primer pago;
- `reviews.publish_consent` (permiso del autor para publicar su valoración).

Sin variables nuevas. Lo que cambia:

- **Referidos**: la recompensa se gana cuando el recomendado paga su primera factura, no al firmar. Una recompensa fija mayor que la cuota se reparte entre las facturas siguientes. Con el programa apagado, la reserva online no pide el código.
- **Promociones en la web**: la web solo anuncia las promociones marcadas «En la web», y su código vale en la reserva online (antes se rechazaba). Las demás las aplica el equipo al crear el contrato.
- **Meses gratis** no se combinan con el pago semestral o anual.
- **Promociones y cupones** los crea y cambia quien ve todos los locales. Una promoción ya usada se desactiva, no se borra.
- **Valoraciones**: para publicar una en la web hace falta que su autor marque la casilla al responder (las ya publicadas se quedan). El equipo recibe un aviso de las notas de 0 a 6. Se pueden reenviar y copiar el enlace.

**Tras desplegar**: en Promociones, revisar cuál está marcada «En la web» (si era una promoción interna, desmarcarla).

## 145. Fidelización: mejoras (2026-11-16)

Migración `20270130100000_loyalty_features` (se aplica sola al arrancar el API): columnas nuevas en `promotions`, `coupons`, `referrals`, `reviews` y `tenants`. No cambia nada de lo que ya hay: todo lo nuevo viene apagado.

Sin variables nuevas. Lo que se puede hacer ahora:

- **Promociones**: ponerles duración («20 % los 3 primeros meses»: el contrato vuelve solo a su precio), limitarlas a unos tipos de trastero, a unos locales, a clientes nuevos o a un uso por cliente, editarlas y ver sus resultados.
- **Cupones**: anunciarlos en la web, crear cupones personales de un solo uso (también desde el presupuesto a un contacto) y añadir un cupón al recordatorio de las reservas sin terminar (Cupones → «Reservas sin terminar»).
- **Referidos**: premiar también al recomendado en su primer pago, poner un tope de recompensas por inquilino al año y ver quién recomienda más. Cada inquilino tiene un enlace para compartir, que deja su código puesto en la reserva.
- **Valoraciones**: recordatorio a los 7 días, valoración anual, cifras por periodo y por local, motivo de la baja en la encuesta de salida («Por qué se van» en Analítica → Bajas) y tarea automática al recibir una nota de 0 a 6 (Tareas → Tareas automáticas).

El recordatorio y la valoración anual salen en el repaso diario de valoraciones (worker, 08:00). El descuento de una promoción con duración lo quita el repaso diario de descuentos caducados (worker).

De paso: la factura mensual ya no aplica un descuento con fecha de fin (retención o promoción con duración) a un periodo que empieza cuando ha caducado. Antes, si caducaba el día 1, la factura de ese mes salía todavía con el descuento.

## 146. El primer pago pendiente se ve y se avisa (2026-11-16)

Sin migración ni variables nuevas.

- Al firmar por enlace (reserva online, contrato enviado a firmar desde el panel o trastero adicional del área de clientes) el inquilino recibe un correo con lo que tiene que pagar: el desglose, el total, el plazo y el botón «Pagar ahora». Sustituye al de «Contrato firmado». Se puede apagar en Configuración → Correo («Primer pago pendiente»); entonces sale el de «Contrato firmado» de siempre.
- La factura sigue sin número hasta que se cobra.
- En el panel, la ficha del inquilino enseña ese primer pago: en «Estado de cuenta» (importe y plazo) y en «Historial de pagos».

**Tras desplegar**: a quien haya firmado antes de este cambio y no haya pagado no le llega el correo nuevo; si sigue en plazo, al ampliarle el plazo desde su contrato le llega un correo con lo que tiene que pagar.

## 147. El primer pago en PDF y reenviable desde el panel (2026-11-16)

Sin migración ni variables nuevas. Va después de §146.

- El correo del primer pago lleva un enlace para descargar su detalle en PDF: sin número (la factura se emite al pagar), con el desglose, la fianza, el total y el plazo. Ese mismo enlace, una vez pagado, descarga la factura emitida.
- En el panel, la ficha de la factura del primer pago tiene «Descargar» (el mismo PDF) y «Enviar por correo», que le reenvía lo que tiene que pagar con el PDF y un enlace nuevo para pagar (el del correo anterior deja de valer). Si el plazo ya ha vencido, primero hay que ampliarlo desde el contrato.
- En el área de clientes, el primer pago también tiene su PDF.
- Al ampliar el plazo de un contrato ya firmado, el enlace para pagar dura hasta el plazo nuevo.

**Tras desplegar**: a quien firmó antes de este cambio y no ha pagado, se le puede mandar todo desde la ficha de su factura → «Enviar por correo» (si el plazo ha vencido, ampliarlo antes desde el contrato).

## 148. Marketing: seguridad y atribución sin dobles (2026-11-16)

Migración `20270131100000_marketing_security` (se aplica sola al arrancar el API):

- Google Analytics: una propiedad solo puede estar en un negocio. Si alguna estaba en dos, se queda en el que la conectó antes; el otro pierde la conexión y lo descargado.
- Borra de lo descargado las páginas de firma, que llegaban con el enlace secreto en la dirección.
- Borra las credenciales de anuncios y las conexiones con Google de los negocios ya anonimizados.

Sin variables nuevas. Lo que cambia:

- **Google Analytics**: para conectar la propiedad, el negocio tiene que poner antes el ID de medición de su web («G-…») en Configuración → Marca y SEO, y la propiedad tiene que medir esa web. Las propiedades ya conectadas se comprueban en la siguiente descarga diaria: si no miden la web del negocio, se paran con el motivo.
- **Search Console**: solo el dominio propio verificado del negocio o su dirección en la plataforma (`/s/<identificador>/`). Las ya conectadas que no lo cumplan se paran en la siguiente descarga.
- **Gasto de los anuncios**: Google Ads pasa a la versión v26 de su API y Meta Ads a la v25.0. Las versiones que usábamos (v18 y v21.0) ya no funcionaban, así que la sincronización del gasto fallaba.
- **Tokens fuera de los registros**: el token de Meta va en la cabecera y Sentry (API y worker) ya no guarda tokens en el rastro de las peticiones.
- **Firma del contrato**: el enlace secreto ya no llega a Google Analytics (ni al del negocio ni al de TrasterOS). Tampoco los de invitación o cambio de contraseña.
- **Chat de la web**: topes por IP y día (10 conversaciones nuevas, 3 pasos a una persona y 2 reservas por negocio) y 200 respuestas de la IA por negocio y hora. Pedir una persona sin haber escrito nada ya no avisa al equipo.
- **Canales de marketing**: cada contacto cuenta en un solo canal. Google Ads y Meta Ads solo cuentan el tráfico de sus anuncios (no las visitas desde las búsquedas de Google ni desde las publicaciones de Instagram). Si dos canales recogen el mismo origen, el panel lo avisa.
- **Anonimizar un negocio** borra también sus credenciales de anuncios y sus conexiones con Google Analytics y Search Console.

**Tras desplegar**:

1. En el proyecto de Google Cloud de la cuenta de servicio (la de Search Console y Google Analytics), activar la **Google Analytics Admin API**. Sin ella, conectar Google Analytics da «No se ha podido comprobar la propiedad».
2. Probar la sincronización del gasto de Google Ads con una cuenta real (Marketing → Canales → editar el canal → «Sincronizar gasto ahora»). En las pruebas no se puede llamar a Google.
3. Avisar a los negocios que tengan Google Analytics conectado y no hayan puesto el ID de medición en Marca y SEO: su conexión se parará hasta que lo pongan.
4. Los enlaces de firma que ya llegaron a Google Analytics caducan solos a los pocos días; no hace falta hacer nada.

## 149. Marketing: revisión de fallos medios y menores (2026-11-16)

Migración `20270201100000_marketing_review` (se aplica sola al arrancar el API):

- Chat de la web: horario del equipo por negocio y origen de la visita en cada conversación.
- Canales de marketing: renovación periódica y estado de la sincronización del gasto por canal. Los avisos de renovación ya enviados no se repiten.
- Contratos: copia cifrada del enlace de firma, para que los recordatorios reenvíen el mismo enlace en vez de anularlo.
- Índices nuevos para los informes de Marketing (contactos, visitas y gastos).

Sin variables nuevas. Lo que cambia:

- **Dinero según permisos**: en Marketing, quien no tiene permiso para ver gastos no ve el gasto ni los costes, y quien no ve facturas y cobros no ve lo cobrado ni las cuotas. Quien solo ve unos locales ve los canales, contactos y clientes de sus locales.
- **Rendimiento**: los clientes son los contratos firmados en el periodo (también los que usaron la promoción del canal), el payback se calcula con los que siguen, los canales borrados con datos siguen saliendo y hay una fila con el gasto de marketing sin canal. Las cifras pueden cambiar respecto a antes.
- **Gasto de los anuncios**: al vincular una campaña se traen los últimos 90 días; cada día se recuperan los que faltaran; un día que la plataforma rebaja a 0 se borra; nada de un trimestre cerrado en Fiscalidad se toca. Si un canal falla 3 días seguidos, avisa a quien gestiona Marketing.
- **QR de los canales**: un canal pausado, finalizado o borrado sigue llevando a la web sin contar. Los robots, las vistas previas de WhatsApp y el mismo visitante en 30 minutos ya no cuentan, así que los clics bajarán.
- **Chat de la web**: si nadie responde en 15 minutos, la IA vuelve a contestar; fuera del horario del equipo (Configuración → Asistente IA) se avisa al visitante y se le piden sus datos.
- **Correo mensual de marketing**: sale del día 4 al 10 y se reintenta si falla.
- **Política de cookies**: explica la medición propia de la web; el identificador del visitante dura 13 meses y «Solo necesarias» deja de medir.

**Tras desplegar**:

1. Revisar con la asesoría el texto nuevo de la política de cookies y de privacidad (chat de la web y medición propia).
2. Los negocios con la renovación de un canal en los próximos 7 días ya avisados no recibirán otro aviso por la misma fecha.

## 150. Marketing: mejoras (2026-11-16)

Migración `20270202100000_marketing_features` (se aplica sola al arrancar el API):

- Contactos: el canal con el que llegaron (cambiar después el origen de un canal ya no se los quita) y los identificadores del clic de los anuncios.
- Canales: cupón, presupuesto del mes y los avisos ya enviados.
- Google Ads y Meta: la acción de conversión y el píxel, y una tabla con cada contrato enviado (`ad_conversion_uploads`).
- Visitas de la web: dos tablas ya sumadas (`web_visits` y `web_page_daily`) que leen los informes, **rellenas con las visitas que ya había** (con muchas visitas tarda unos segundos), y el local y el tamaño al empezar una reserva.
- Notas en la gráfica de visitas, aviso de conexión rota de Google Analytics, redes y Search Console, clics al enlace de las publicaciones de Facebook, responsable de cada conversación del chat y aviso al 80 % de sus respuestas.

Variables nuevas, todas opcionales (`x-app-env` de `docker-compose.portainer.yml`):

- `META_APP_ID` y `META_APP_SECRET`: app de Meta de la plataforma para «Conectar con Facebook» en Marketing → Redes sociales. Vacías, cada negocio sigue pegando su token.
- `AD_CONVERSIONS_MODE=stub`: solo en desarrollo, simula los envíos a Google Ads y Meta.

Tareas programadas nuevas: `marketing-budgets.daily` (9:30, API), `marketing.ad-conversions` (cada 30 minutos, worker) y `web-chat.weekly-ratings` (lunes a las 9:15, API).

Lo que cambia:

- **Canales**: filtro por local; enlace de seguimiento para pegar en un anuncio o en la biografía de Instagram; cupón del canal (sus contratos cuentan para el canal); presupuesto del mes con lo gastado y aviso al pasarlo o si a mitad de mes hay gasto y ninguna reserva; QR en PNG grande y en SVG con un código fácil de teclear (los nuevos: 6 letras y cifras en mayúsculas); «Orígenes sin canal» con «Crear canal».
- **Rendimiento**: elegir primer o último contacto, local, embudo completo (visitantes, contactos, reservas, clientes, pagados, cobrado y retorno) y CSV.
- **Resumen**: el mismo mes del año pasado y filtro por local.
- **Visitas**: embudo de la reserva online, nuevos y que vuelven, por dónde entran, cuándo llaman o escriben por WhatsApp, qué locales y tamaños buscan y notas en la gráfica. El navegador del equipo no cuenta; en el dominio propio, abrir la web una vez con `?no_track=1` desde cada móvil u ordenador del equipo.
- **Redes**: «Conectar con Facebook» (con la app de Meta configurada), hasta qué día hay datos y qué funciona en las publicaciones (formato, día y hora).
- **Conversiones a Google Ads y Meta**: los contratos firmados de quien llegó por un anuncio se devuelven a la plataforma (valor: la cuota mensual sin IVA). Solo si el visitante aceptó todas las cookies: con las conversiones activadas, el aviso de cookies sale en la web del negocio aunque no tenga Google Analytics, y la política de cookies lo explica.
- **Chat de la web**: formulario para reservar sin pasar por la IA, «Déjanos tus datos» en cualquier momento, «¿Qué tamaño necesito?», «Nueva conversación» y el chat sigue abierto al cambiar de página; el asistente pide visitas al local (quedan en el calendario de contactos, por confirmar) y manda presupuestos por email; responsable de cada conversación; «Probar el asistente» en Configuración → Asistente IA; cifras con lo cobrado; «Respuestas que no gustaron» con aviso los lunes; aviso al 80 % de las respuestas del mes.
- **Conexión rota**: si la descarga diaria de Google Analytics, Instagram y Facebook o Search Console falla, un aviso (y otro solo cuando vuelva a fallar tras funcionar).

**Tras desplegar**:

1. Para «Conectar con Facebook»: crear en Meta for Developers una app de tipo empresa con «Inicio de sesión con Facebook para empresas», autorizar la dirección de vuelta `https://api.trasteros.pro/v1/marketing/social/oauth/callback`, pedir a Meta los permisos `pages_show_list`, `pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_manage_insights` y `business_management` (la revisión de la app hace falta para usarlos con cuentas de otros), y poner `META_APP_ID` y `META_APP_SECRET` en Portainer.
2. Probar las conversiones de Google Ads con una cuenta real: en Google Ads, una acción de conversión de tipo «Importar» → «Clics», y su ID (el número) en Marketing → Canales → Google Ads. En Meta, el ID del píxel; el token del negocio tiene que tener acceso a ese píxel. En las pruebas no se llama a ninguna de las dos.
3. Revisar con la asesoría el párrafo nuevo de la política de cookies (identificadores de clic de los anuncios).

## 151. Equipo comercial: perfil «Comercial» en el panel de administración (2026-11-16)

Migración `20270203100000_sales_reps` (se aplica sola al arrancar el API): rol `sales` en `super_admins` con su código, teléfono, WhatsApp y enlace de reservas; destinatario en `super_admin_notifications`; comercial de cada cuenta (`tenants.sales_rep_id/sales_assigned_at/sales_source`, `platform_leads.sales_rep_id`) con su historial (`sales_assignments`); ficha de llamada (`sales_account_profiles`); comisiones (planes, conceptos, extras por aprobar, movimientos, liquidaciones y objetivos); ajustes del equipo (`platform_sales_settings`, un registro); materiales, plantillas y cadencias (con dos cadencias y cuatro plantillas de partida); apertura y caducidad de las propuestas; `platform_coupons.sales_allowed`. Todas son tablas de la plataforma, sin acceso para el rol de la app (`REVOKE`).

Sin variables nuevas. Tareas programadas nuevas en el API: `sales.hourly` (minuto 25: extras contratados, comisiones y avisos de los comerciales) y `sales.daily` (3:40: libera los prospectos sin actividad y pone a cero la cuenta de demostración).

Cómo funciona:

- **Quién es de quién**: una cuenta es de un comercial solo si se registra con su enlace o su QR, si el cliente escribe su código al registrarse o en el formulario de la web, o si la crea el propio comercial desde su panel. Desde la web sin código no se asigna a nadie (no hay reparto automático). Si un prospecto de un comercial se registra sin su código, queda en «Equipo comercial → Por decidir».
- **Lo que ve el comercial**: solo su cartera (prospectos y clientes), con su ficha de llamada, seguimientos, propuestas, lo que podría ofrecer y sus comisiones. Nunca los inquilinos ni la facturación de sus clientes, ni puede entrar en sus cuentas. Puede crear cuentas (prueba estándar), ampliar pruebas hasta su tope, dejar probar un extra y enviar propuestas con los cupones marcados para comerciales; lo demás lo pide a la dirección.
- **Comisiones** (las fija la dirección en la ficha de cada comercial): % de lo que pagan sus clientes (sin IVA) durante los meses que se indiquen, un fijo por venta, un fijo por cada extra que contrate un cliente **después** de la venta y que la dirección apruebe (si lo contrata sin mediación del comercial, se rechaza y no cuenta), y trabajos extra como la migración de datos. Las liquidaciones mensuales solo dejan constancia: el pago se hace por nómina.

**Tras desplegar**:

1. En «Equipo comercial → Comerciales», «Nuevo comercial» por cada persona: le llega un correo para elegir su contraseña y, al entrar, tiene que activar la verificación en dos pasos antes de ver nada.
2. En la ficha de cada uno, sus condiciones (%, meses, fijos y trabajos extra) y sus objetivos.
3. Revisar las reglas del equipo (días de prueba de más con el código, liberar prospectos sin contacto, topes de días) y crear la cuenta de demostración.
4. En «Catálogo y precios → Cupones», marcar «Lo pueden usar los comerciales» en los cupones que puedan ofrecer.
5. Subir el material de venta (dossier, tarifas, guion) en «Equipo comercial → Materiales y plantillas» y revisar las plantillas de partida.

## 152. Ajustes del equipo comercial (2026-11-17)

Migración `20270204100000_sales_two_factor_exempt` (se aplica sola al arrancar el API): `super_admins.sales_two_factor_exempt`, por defecto no. Sin variables nuevas.

- **Verificación en dos pasos**: sigue siendo obligatoria para los comerciales, pero en la ficha de cada uno («Equipo comercial → Comerciales») está «Quitar verificación en dos pasos». Sin ella entra solo con su contraseña; «Exigir verificación en dos pasos» la vuelve a pedir.
- **Enlace del comercial**: el registro y la web llevan `?team=CÓDIGO` (antes `?comercial=`).
- **Liquidaciones en efectivo**: «Liquidar» en la ficha del comercial la deja pagada en el acto. No se le avisa: la ve en «Mis comisiones» → Liquidaciones.
- La página «Clientes» del comercial ya no dice que no ve los inquilinos ni la facturación de sus clientes.

## 153. Revisión del equipo comercial (2026-11-18)

Migración `20270205100000_sales_review` (se aplica sola al arrancar el API): `sales_commission_items.split`, tabla `sales_wins` y `platform_sales_settings.demo_resetting_at`. Sin variables nuevas.

- **Comisiones**: un reembolso, contracargo perdido o adeudo SEPA devuelto se descuenta del % del comercial en el siguiente cálculo horario (y, si se devuelve todo, el fijo por la venta). Contratar o quitar un extra no cambia la comisión de cobros anteriores. Un comercial desactivado deja de sumar comisiones nuevas.
- **Extras**: en «Equipo comercial → Por decidir», «Extras ya decididos» permite cambiar la decisión; si el fijo ya se liquidó, va un ajuste.
- **Objetivos**: cuentan lo que aportaba cada cliente al pagar por primera vez (no lo que paga hoy).
- **Demo**: el reinicio de cada noche deja también tipos, locales y trasteros como al crearla. Si falla, aviso en el panel («La cuenta de demostración no se ha podido poner a cero»).
- **Leads**: no se puede descartar ni borrar el lead de un cliente que lleva un comercial sin quitarle antes el comercial.

## 154. Funcionalidades del equipo comercial (2026-11-18)

Migración `20270206100000_sales_features` (se aplica sola al arrancar el API). Sin variables nuevas. La tarea `sales.hourly` cierra además el mes anterior (tramos y bonus, una vez).

- En la ficha de cada comercial («Equipo comercial → Comerciales»): **garantía de la venta** en meses, **bonus por cumplir el objetivo** y **tramos** del fijo por venta. Vacío o 0 = no se aplica.
- **Liquidaciones**: el comercial pulsa «Recibido» en «Mis comisiones → Liquidaciones» y los dos pueden descargar el justificante en PDF.
- «Equipo comercial» enseña la **comparativa del equipo** (con periodo) y las **comisiones previstas** de los próximos 6 meses; el comercial ve las suyas en «Mis comisiones».

## 155. Plan Basic por trastero, segundo usuario y Pro hasta 1.000 trasteros (2026-11-18)

Migración `20270207100000_plan_basic` (se aplica sola al arrancar el API). Sin variables nuevas. El `bootstrap` crea el plan **Basic** y los extras **«Trasteros de más»** y **«Segundo usuario»**.

- **Basic**: 1 € por trastero con un mínimo de 19 € (incluye 19), hasta 50 trasteros, 1 local y 1 usuario. Solo pago mensual. Sin funciones de pago; la domiciliación SEPA se puede contratar como extra (como en Starter; en Pro y Administrador va incluida).
- Los trasteros que pasan de los incluidos van en el extra interno «Trasteros de más» (1 €). La tarea `extra-units.daily` (06:15, hora de España) los fija **7 días antes de cada cobro** con los trasteros dados de alta ese día; lo que se dé de alta después cuenta en el siguiente. Sin prorrateos. Con Stripe van en la propia suscripción (y ya en el primer pago del Checkout); con remesa SEPA o Redsys, en el mismo cargo; con pago a mano, en la bandeja «Hoy» el día del cobro.
- **Segundo usuario** (10 €): solo en Basic, uno como mucho.
- **Pro** pasa a tener hasta **1.000 trasteros** y **Administrador** hasta **1.500** (los que ya tenían más no pierden nada: el límite solo frena altas nuevas). Al llegar al tope, el cliente ve que le contactaremos con un precio a medida y el equipo recibe un aviso y un seguimiento «Precio a medida» (de su comercial, si lo tiene), una sola vez mientras siga pendiente. Se amplía asignándole un extra que dé más trasteros con el precio pactado.
- El plan **gratis** deja de ofrecerse (se oculta de la web y del cambio de plan); quien lo tiene sigue igual hasta la siguiente PR.
- Los extras pueden limitarse a ciertos planes y a una cantidad máxima (panel admin → Extras). Al cambiar de plan, el cliente pierde los extras que su nuevo plan ya incluye o no admite, con un aviso en su panel. Bajar de plan exige caber en sus límites (`plan_limits_exceeded`).
- **Tras desplegar**: revisar en `/admin/plans` el precio de Basic y en `/admin/addons` el de los dos extras nuevos. Si se cobra por Stripe, los Price de los extras se crean solos la primera vez.

## 156. Prueba con el plan elegido, solo lectura al acabar y fin del plan gratuito (2026-11-18)

Migración `20270208100000_plan_trial` (`tenants.free_plan_ends_at`; se aplica sola). Sin variables nuevas.

- **Registro**: se elige el plan de la prueba (Basic, Starter, Pro o Administrador; Starter por defecto). Los botones de la tabla de precios llevan a `/register?plan=…`. La prueba dura 30 días, sin tarjeta, con los límites del plan elegido.
- **Fin de la prueba sin pagar**: la cuenta conserva su plan y pasa a **solo lectura** (suscripción `expired`): puede consultarlo todo, pagar, escribir a soporte y gestionar su perfil; cualquier otro cambio da 403 `subscription_expired_read_only`. Sus inquilinos, su web y los cobros siguen funcionando. Al pagar vuelve a la normalidad sola. «Finalizar prueba» del panel admin hace lo mismo y «Ampliar prueba» la reabre con su plan.
- **Avisos**: los correos de 7, 3 y 1 día antes dicen el plan, el día y lo que pagaría al mes (IVA incluido); el del fin y un aviso en el panel explican el solo lectura.
- **Plan gratuito**: la tarea diaria del ciclo de vida avisa una vez a cada cuenta (correo y aviso en el panel) con lo que pagará en Basic y, a los 30 días, la pasa a Basic; si no ha pagado, queda en solo lectura. Corre siempre, aunque los correos automáticos estén apagados.
- **Correos editados**: si en Comunicación → Correos automáticos se editaron «La prueba termina pronto» o «La prueba ha terminado», se mantiene ese texto: conviene revisarlo (ya no se pasa al plan gratuito) y usar las variables nuevas `{plan}`, `{fecha}` e `{importe}`. Hay dos correos nuevos: «El plan gratuito se acaba» y «Ha pasado al plan Basic».
- **Tras desplegar**: la primera ejecución diaria avisa a todas las cuentas del plan gratuito a la vez (pasan a Basic 30 días después).

## 157. Revisión de los planes nuevos (2026-11-18)

Sin migración ni variables nuevas. Arreglos tras analizar el plan Basic y la prueba con solo lectura (#973 y #974), y decisiones de Jota:

- **Trasteros de más de Basic**: se cuentan **en el momento de cobrar** y van siempre en el mismo cargo que la cuota, por cualquier vía (Stripe, remesa SEPA, Redsys —también el pago suelto— y pago a mano). Nunca se cobran aparte, no salen en «Hoy» ni se suspenden solos; el admin no puede quitarlos, suspenderlos ni cambiarles el slug. La tarea `extra-units.daily` los pone al día cada día (con Stripe deja la cantidad de la próxima factura, sin prorrateos). Solo cuentan los trasteros de locales que no están borrados. Un plan por trastero no se paga por adelantado por Redsys.
- **Solo lectura**:
  - A los **30 días** sin pagar se suspende como un impago (tarea del ciclo de vida diario; el correo de fin de prueba lo avisa).
  - Un pago tardío desde el solo lectura cuenta **desde el día en que paga** (pago a mano, Redsys y remesa).
  - Firmar el mandato SEPA en prueba o en solo lectura pasa la cuota a domiciliación; la remesa admite cuentas en solo lectura y al cobrarse vuelven a la normalidad.
  - En solo lectura se puede también desactivar usuarios, retirar invitaciones, aceptar los términos y exportar los datos.
- **Fin del plan gratuito**: al cancelar en Stripe la cuenta conserva su plan en solo lectura; «Pasar a Free» desaparece de Cobros pendientes y el panel ya no asigna ni da de alta el plan gratuito (400 `plan_retired`). En instalaciones nuevas el plan gratuito nace oculto.
- **Pagar el plan que ya tienes** está permitido aunque no quepas en él (solo no puedes crecer).
- **Panel admin**: las cuentas en solo lectura salen como «Solo lectura» (sin aportar al mes, salud baja), con «Reabrir la prueba» en la ficha (también para su comercial). La vista previa del cambio de plan incluye los trasteros de más y los extras que se darán de baja. El simulador y la propuesta a un contacto usan los trasteros reales, no ofrecen Basic anual ni extras de otro plan, y los selectores ya no ofrecen el plan gratuito.

## 158. Leads del admin asignados a un comercial (2026-11-18)

🐛 Un lead creado o editado en Leads del panel admin y asignado a un comercial solo guardaba «quién lo lleva» en el tablero, no el comercial (`sales_rep_id`), así que no salía en el panel del comercial. Ahora, si el asignado tiene el rol comercial, el lead pasa a su cartera con su asignación (y su cuenta, si ya la tiene y no tiene comercial) y se le avisa; reasignarlo a otro comercial lo cambia de cartera. La migración `20270209100000_lead_sales_rep_backfill` arregla los leads ya afectados (activos, sin comercial y asignados a un comercial activo). Sin variables nuevas.

## 159. Citas de los comerciales (2026-11-18)

Migración `20270210100000_sales_appointments` (tabla global `sales_appointments`, con REVOKE). Sin variables nuevas.

- **Comercial**: tarjeta «Citas» en la ficha de cada prospecto o cliente (llamada, videollamada o visita, con día, hora, duración, lugar o enlace y notas), página **Mis citas** (próximas y pasadas) y «Citas de hoy» en su «Hoy». Cada cita se marca como hecha, cancelada o «no se presentó».
- **Dirección**: pestaña «Citas» en la ficha del lead (Leads del panel admin) para ponerle una cita a un comercial, y **Equipo comercial → Citas** con las de todos y filtro por comercial. Si el lead aún no tiene comercial, pasa a la cartera del elegido; si es de otro, hay que reasignarlo antes.
- **Avisos al comercial** (campana y notificación en el móvil): al ponérsela otra persona (también al cambiarla o cancelarla), el día antes (24 h) y una hora antes. La tarea `sales.appointments` corre cada 5 minutos en el API; cada aviso se reserva en la propia cita. La dirección no recibe avisos de citas.

## 160. El primer pago en un solo pago (2026-11-19)

Sin migración ni variables nuevas. El primer pago de un contrato (la factura del alquiler y la fianza que va con ella) es un solo pago en todos los caminos:

- 🐛 **La página del enlace (`/sign`, «Completar el pago») cobraba la fianza sola** (el primer documento pendiente era el justificante, creado después de la factura) y el inquilino tenía que volver para pagar el alquiler: ahora cobra la factura con su fianza y enseña el total con el desglose.
- Pagar la fianza suelta mientras su factura está pendiente (tarjeta, Redsys, transferencia o en el local) cobra las dos. En el área de clientes salen como un solo pago, con «Alquiler + fianza = total» y el botón por el total.
- **Un solo «Pago recibido»**: con Redsys llegaban «Pago recibido» y «Fianza recibida»; el correo de la transferencia, el recordatorio de reserva sin pagar, «Enviar por correo» y los recordatorios de una factura con fianza pendiente dicen el total.
- **«Registrar cobro»** de una factura con fianza pendiente: casilla «Incluye la fianza», marcada por defecto, que registra las dos con la misma forma de pago.
- **Panel**: filtro «Pendiente de pago» en Facturas (`?awaiting=1`), búsqueda por número de contrato, «Contrato …» y «+ fianza … en el mismo pago» bajo el número, lo pendiente cuenta el primer pago, el primer pago se ve en la ficha del contrato y en «Hoy» hay una tarjeta «Primeros pagos pendientes» con el total y el plazo.

## 161. Revisión de Analítica (2026-11-19)

Sin migración ni variables nuevas. Arreglos tras analizar Analítica entera; decisiones de Jota: aplicar el precio de un tipo cambia también sus trasteros libres, las facturas de los propietarios van aparte (como en Fiscalidad) y los locales por abrir no cuentan hasta que abren.

- **Cambian cifras que ya se veían** (no es un error al desplegar):
  - **Ocupación y cuotas con todo alquilado** de toda la empresa sin los locales por abrir.
  - **Cobrado** sin la fianza aplicada a una factura (como la caja).
  - **Cuotas al mes** con el descuento por prepago de los contratos semestrales y anuales.
  - **Ingresos y deudas** solo de tu empresa si hay propietarios (selector «Facturas de…» para verlos o verlo todo).
  - **Bajas**: cuenta también quien entra y se va el mismo mes; la tasa va sobre los activos al empezar más las altas.
  - **Riesgo de baja** por inquilino (no por contrato); «sin método de pago» solo si el negocio cobra solo y «nunca ha entrado» solo con puertas conectadas.
  - **Ocupación mes a mes** desde quién tuvo cada trastero (los meses de una cartera importada dejan de salir a 0 %).
  - **Previsión** sin redondear mes a mes y con las medias de los meses que el negocio lleva funcionando.
  - **Comparativa del sector**: mínimo 10 negocios, sin demos ni cuentas exentas (puede dejar de salir hasta que haya suficientes).
- **Permisos**: Ingresos y Deudas solo para quien ve facturas y cobros; sin ese permiso el resto de Analítica y el Resumen no enseñan importes.
- **Aplicar el precio de un tipo** cambia también el de sus trasteros libres en todos los locales (antes solo el de catálogo, que no usaba la reserva online).

## 162. Mejoras de Analítica (2026-11-19)

Sin migración ni variables nuevas. Lo que cambia en Analítica:

- **Arriba, una línea con cómo va el mes** frente al pasado hasta el mismo día (facturado, ocupación, altas y bajas, contactos y lo vencido).
- **Periodo**:
  - comparar con el periodo anterior o con el mismo del año pasado;
  - opción «Sin el mes en curso»;
  - la pestaña y el periodo se recuerdan en el navegador.
- **Deudas**: quién debe más, por local, días hasta cobrar y retraso medio, con enlace a Deudores.
- **Riesgo de baja**: cuotas en juego y botones para llamar, escribir por WhatsApp u ofrecer retención.
- **Precios**:
  - «Aplicar todas» en la vista por trastero;
  - columna de libres y lo que sumaría aplicar todo en la vista por tipo;
  - pestaña «Inquilinos por debajo del precio» (candidatos a una subida).
- **Previsión**: escenarios prudente, esperado y optimista, el mes en que te llenarías y cuándo se llena cada local y tamaño.
- **Ocupación**: rendimiento por tipo de trastero (cuotas por m² y cuota media frente al precio de hoy).
- **Bajas**: cuotas que entran y salen cada mes, y cuánto llevaban los que se van.
- **Contactos**: tiempo hasta responder y hasta contratar, y coste por cliente de cada canal de Marketing.
- **Resumen del mes en PDF**: botón en Analítica; el informe queda también en Informes.
- **Tras desplegar**: los informes se generan en el worker, que debe tener esta versión para el «Resumen del mes».

## 163. Revisión de Mercado: Competencia y Posiciones en Google (2026-11-19)

Migración `20270210100000_search_console_days` (tabla `search_console_days` con RLS, totales de cada día de Search Console). Sin variables nuevas.

- **Cambian cifras que ya se veían**:
  - **Ocupación de mercado**: la tuya es la de Analítica (sin locales por abrir). La de la competencia solo cuenta inventarios completos comprobados en los últimos 180 días; la estimada con su total conocido sale aparte.
  - **Posiciones en Google**: los totales son los del panel de Search Console (algo mayores que la suma de las búsquedas). Los primeros días tras desplegar, hasta la siguiente descarga diaria, siguen saliendo como antes; se puede pulsar «Actualizar ahora».
- **«Sin revisar»**: cuenta cualquier comprobación de un trastero; los competidores fichados con trasteros recientes dejan de salir en el aviso.
- **Precios de 0 €** ya no se aceptan. Los que hubiera guardados se quedan: conviene corregirlos.
- La página de Competencia sigue el local de la cabecera.
- El informe mensual de SEO no se envía vacío ni a negocios suspendidos. «Enviármelo ahora» va solo a quien lo pulsa.

## 164. Mejoras de Mercado: Competencia y Posiciones en Google (2026-11-19)

Migración `20270211100000_market_improvements`: `competitor_facilities.review_every_days` y `promo_ends_at`, tabla `competitor_promotions` (histórico; se rellena con la promoción que tenía cada competidor), `tenant_search_console.brand_terms`, `report_recipient_ids` y `last_drop_alert_at`, y tablas `seo_tracked_keywords` y `search_console_devices`, todas con RLS. Sin variables nuevas.

- **Competencia**: tu precio frente al mercado por tipo de trastero (con gráfica), precio comparable y por m² en cada trastero suyo, evolución mensual de cada competidor, promociones con fecha de fin y su histórico, plazo de revisión por competidor, «Sin cambios» en un clic, pegar una tabla de trasteros, leer su página de tarifas con IA (necesita el asistente IA en el plan y gasta una consulta), tus características frente a las suyas, avisos de subidas de precio y de tamaños agotados y exportación a CSV.
- **Posiciones en Google**: clics por semana, comparación con el año pasado, búsquedas con tu marca frente a las demás, dispositivos, búsquedas que sigues con su objetivo, detalle de cada búsqueda y página, de Google a reservas, páginas que salen pero casi nadie pulsa, buscar, ordenar y exportar las búsquedas, elegir quién recibe el informe y aviso de caídas de clics.
- **Tras desplegar**: los negocios que ya tenían Search Console conectado no tienen los datos por dispositivo ni el año pasado hasta que se descarguen. Para traerlos, desconectar y volver a conectar (baja 16 meses de totales), o esperar: la descarga diaria va llenando los dispositivos desde el día del despliegue.

## 165. Cuenta de demostración con datos de todo tipo (2026-11-19)

Sin migración ni variables nuevas. El reinicio de cada noche (y «Reiniciar» en Equipo comercial → Demo) rellena la cuenta de demostración con datos para enseñar todas las pantallas (`apps/api/src/modules/admin/sales/sales-demo-data.ts`):

- **Inquilinos y contratos**: ~75 % de ocupación, con contratos en marcha, con baja pedida, terminados (fianza devuelta), altas y bajas de este mes y dos borradores esperando la firma. Seguro en ~30 %. Correos `@example.com`.
- **Facturas de los últimos seis meses** numeradas en orden (`FA/<año>/…`; la serie sigue desde la última), casi todas cobradas (tarjeta, domiciliación, transferencia y efectivo), las de este mes por cobrar, deudores con facturas vencidas, un cobro rechazado, un pago a cuenta y los justificantes de fianza.
- **El resto**: un trastero en mantenimiento y otro bloqueado, reservas y lista de espera, 12 contactos en todas las fases con seguimientos y llamadas, tareas, incidencias, seis meses de gastos (uno pendiente), puertas con PIN y una semana de entradas (los deudores, con el acceso cortado), valoraciones, mensajes, avisos y comunicaciones ya enviadas.
- **Lo que el vaciado conserva** (competencia, productos, plan de seguro y promoción) se crea solo si falta; los contactos de la demo (`metadata.demo`) se rehacen cada vez.
- La cuenta queda con la puesta en marcha completa (IBAN de transferencia, pago en el local y emisión automática de las facturas del mes).

**La cuenta de demostración nunca envía correos ni WhatsApp**: `CommunicationsService.dispatch` deja `skipped` cualquier envío de ese tenant («Cuenta de demostración: no se envía»).

Tras desplegar, **pulsar «Reiniciar» en Equipo comercial → Demo** para ver los datos sin esperar a la noche.

## 166. Demo: área de clientes y web pública (2026-11-19)

Sin migración ni variables nuevas. Además de «Abrir la demo» (el panel del negocio), el comercial (Mi enlace y QR → Cuenta de demostración) y la dirección (Equipo comercial → Cuenta de demostración) tienen:

- **Área de clientes**: entra como Laura Martín, una inquilina de la demo (contrato con seguro, la factura de este mes por pagar, su PIN a la vista y una conversación con el equipo). Lo que haga (un mensaje, pedir otro trastero, una incidencia) le llega al negocio de la demo. Es un enlace de un solo uso (`POST /admin/sales/demo/portal`, auditado `admin.sales.demo_portal_opened`).
- **Web pública**: `/s/<slug de la demo>`. Desde ahí se reserva como un cliente nuevo (pago por transferencia o en el local) y la reserva sale en el panel (contrato por firmar, trastero reservado y aviso).

La demo tiene los avisos por correo al equipo apagados y un contacto de ejemplo (`hola@example.com`): antes salía el correo real de quien la creó en la web y en el contrato que firma el cliente.

Tras desplegar, **poner la demo a cero** para que aparezca la inquilina.

## 167. Revisión de la demo (2026-11-19)

Sin migración ni variables nuevas. Arreglos tras revisar la cuenta de demostración, su área de clientes y su web:

- **Las puertas simuladas no avisan de «sin señal»**: una hora después de cada reinicio salían en «Hoy» del panel de administración (y en el aviso al móvil) como dispositivos sin conexión. Los dispositivos con proveedor `stub` quedan fuera de ese aviso.
- **La web de la demo no se indexa**: `noindex` en sus páginas y fuera del sitemap (`PublicTenantBrandDto.noindex`, etiqueta `demo` del tenant). El sitemap del web se renueva cada hora.
- **Los contactos de las reservas hechas en cada demo se borran al reiniciar** (el vaciado conserva los contactos y se acumulaban).
- **El resumen mensual de marketing no se envía desde la demo** (llegaba al correo real de quien la creó).
- **Nunca se envía correo a direcciones de ejemplo** (`@example.com`, `.test`, `.invalid`…) en producción: `EmailService` lo deja como no enviado. Cubre los enlaces de acceso al área de clientes de los inquilinos de la demo.
- **Datos más coherentes**: Laura es siempre la misma inquilina (un mediano del local Centro, con seguro, al día y con la factura del mes por pagar); los nombres no se repiten; las facturas vencidas llevan su escalado (recordatorio, segundo aviso, corte de acceso y aviso legal) y solo tiene el acceso cortado quien el escalado cortó; el tamaño Grande está siempre agotado en el local Norte, con su lista de espera («Agotado · Avísame» en la web).

Tras desplegar, **poner la demo a cero**.

## 168. Mejoras de la demo: pago con tarjeta simulado, extras y configuración (2026-11-19)

Sin migración ni variables nuevas.

- **Pago con tarjeta simulado**, solo en la cuenta de demostración: en la firma de la reserva y en el área de clientes sale «Pagar con tarjeta» con una tarjeta de prueba y el aviso de que no se cobra nada. `POST /portal/me/invoices/:id/demo-card-payment` (`DemoCardPaymentService`) no llama a ninguna pasarela: apunta el cobro dentro de la demo como un cobro a mano (forma de pago tarjeta, sin pasarela ni identificador externo, nota «Pago con tarjeta simulado…»), con su fianza, y emite el acceso como un pago real. Cualquier otro negocio recibe **403 `demo_only`**; `PortalPaymentOptionsDto.demoCard` solo es `true` en la demo.
- **El script de Stripe ya no se carga al abrir la firma o el área de clientes** (`@stripe/stripe-js/pure`): solo al pagar con Stripe.
- **Extras activados en la demo**: Web Premium (plantilla Cabe con textos, opiniones, preguntas, formulario y blog) y SEO local.
- **Configuración y catálogo se reinician**: color, plantilla y textos de la web, ajustes de cobro, referidos, pase nocturno e impagos vuelven a su valor, y se rehacen cupones, promociones, seguros, productos, competencia, preguntas frecuentes, canales, automatizaciones, planes de mantenimiento y entradas del blog. **Se conservan** las fotos de los locales, el logo, el favicon y las fotos de la portada: súbelas una vez desde la demo.
- **Datos nuevos**: 5 preguntas frecuentes, 2 entradas del blog, el cupón `TRESMESES`, 3 canales de marketing con su QR, 2 automatizaciones, 2 planes de mantenimiento, un mes de visitas de la web por origen, un expediente de impago con el candado puesto, el cierre de caja de ayer, 2 pases nocturnos (el local Norte cierra de 23:00 a 6:00) y los referidos de Laura (código `LAURA15`).

Tras desplegar, **poner la demo a cero** y, si quieres, subir las fotos de los dos locales.

## 169. Revisión de Informes y del Asistente IA (2026-11-19)

Migración `20270212100000_report_run_scope` (se aplica sola al arrancar el API). Sin variables nuevas.

- **Los informes en PDF vuelven a generarse**: fallaban todos (Puppeteer se cargaba con un `import` que en el servidor compilado es un `require`). Hay una prueba que impide que vuelva a pasar en cualquier PDF.
- **Cada informe sale con los locales de quien lo pide**. Con más de un local a la vista se puede pedir de uno solo. Quien solo ve algunos locales ve en la lista únicamente los informes que pidió él, y cada informe pide su permiso (facturas, cobros, contratos…).
- **Las cifras son las del Resumen**: los justificantes de fianza ya no cuentan como facturas ni como cobros, y la cuota de cada contrato lleva su descuento. «Facturas vencidas» con una fecha pasada enseña lo que se debía ese día.
- Textos en español (estados, cabeceras, nombres), fechas `dd/mm/aaaa`, apaisado con muchas columnas y pie con la hora del negocio.
- Las fechas se comprueban al pedir el informe; un informe que se queda a medias se da por fallido a los 15 minutos; los errores técnicos ya no se enseñan tal cual.
- En la lista: periodo y quién lo pidió, «Repetir» y «Quitar», y la descarga baja el fichero con su nombre (ya no abre otra pestaña).
- **Asistente IA**: quien solo ve unos locales ya no llega por el asistente a inquilinos, contactos, envíos, valoraciones ni planes de pago de otros; tampoco puede preparar un mensaje para ellos ni pedir una respuesta sugerida. Las notas internas no entran en la respuesta sugerida.
- **Importes del asistente como en el panel**: cuotas con descuento, deuda sin fianzas, la retención de IRPF no se resta dos veces, una factura cancelada o rectificada no debe nada, y los meses van en la hora del negocio. Sin permiso de facturas y cobros no da importes.
- «Facturas de octubre» ya incluye las del día 31 (el filtro se corría un día).
- Una consulta que falla ya no deja la pregunta sin respuesta; el chat no repite sola una pregunta que ya estaba en marcha; la conexión no se corta mientras el asistente piensa.
- Pantalla: «4 de 300 consultas» (salía «4,00 de 300,00»), conversaciones anteriores también en el móvil, el mensaje que se va a enviar se lee entero antes de confirmar y no se pierde lo escrito si falla el envío.

## 170. Asistente IA: arreglos pendientes de la revisión (2026-11-19)

Sin migración ni variables nuevas.

- **Cortes claros**: si Anthropic está saturado o tarda más de 2 minutos, el usuario ve «El asistente está muy ocupado…» en vez de un error genérico, y la consulta no cuenta. Una respuesta cortada por larga lo avisa al final; el tope de la respuesta sube de 2.048 a 4.096 tokens.
- **Si el usuario se va**, se deja de llamar al modelo (antes seguía gastando hasta el final).
- **Conversaciones largas**: se mandan los 40 últimos mensajes (antes, todos en cada pregunta).
- La octava vuelta de herramientas ya no deja acciones preparadas sin explicar.
- Acciones: una fecha que no existe se rechaza al prepararla; mientras se ejecuta sale «En curso»; una que falló se puede reintentar.
- «Sugerencias de hoy» usa la clave propia del negocio si la tiene (antes, la de la plataforma).
- El asistente trata como datos, no como órdenes, los textos que escriben inquilinos y contactos.
- La conversación abierta va en la dirección (`/assistant?c=…`): al recargar sigue abierta.
- Recuentos sin decimales («12» y no «12,00») en Mensajes, el informe de accesos, la tarjeta de IA del admin y el vaciado de datos de prueba.

## 171. Mejoras de Informes y del Asistente IA (2026-11-19)

Migraciones `20270213100000_report_schedules` y `20270213110000_ai_scheduled_questions` (se aplican solas al arrancar el API). Sin variables nuevas: los enlaces de los correos usan `API_BASE_URL` y `WEB_BASE_URL`, que ya están.

**Informes**

- **Seis informes nuevos**: deudores por inquilino (con teléfono y último contacto), vencimientos y bajas próximas, trasteros libres (días que llevan vacíos), fianzas retenidas (cobradas y sin cobrar), facturación por tipo de trastero y contactos por origen (con la conversión).
- **Vista previa**: antes de generar el informe se ven las primeras filas y los totales.
- **Marca del negocio**: el PDF y el Excel llevan el nombre y el color del negocio, y el logo si está subido (Configuración → Marca y SEO).
- **Envíos por correo**: un informe se puede recibir cada semana o cada mes, con el periodo que acaba de terminar, a hasta 5 direcciones (la asesoría, por ejemplo). El correo lleva un enlace que descarga el fichero durante 7 días. Si quien lo programó deja el equipo o pierde el permiso, el envío se pausa. La tarea va en el **worker** cada cuarto de hora.
- **Desde Analítica**: «Descargar como informe» abre el informe de esa pestaña con el periodo y el local que se estaban viendo.

**Asistente IA**

- **Detener** la respuesta en curso.
- Respuestas con formato (negritas, listas, tablas) y **enlaces a las fichas** de inquilinos, contratos, facturas, trasteros y locales.
- **Acciones nuevas** que se confirman antes de hacerse: apuntar una nota en la ficha de un inquilino, programarle un seguimiento y mandar un recordatorio de pago a varias facturas a la vez. Una propuesta sin confirmar caduca a los 7 días.
- **Preguntar al asistente** desde la ficha de un inquilino, contrato, factura o trastero: el asistente ya sabe de quién se habla.
- **Sugerencias del día** según lo que pasa: facturas vencidas, entradas y salidas de hoy, contratos que vencen, tareas atrasadas y trasteros libres.
- **Preguntas programadas**: una pregunta que el asistente responde cada día o cada semana y llega por correo a quien la programó (cada respuesta gasta una consulta). La tarea va en el **API** (el asistente no está en el worker).

## 172. Revisión de Configuración del panel del tenant: fallos (2026-11-20)

Migración `20270214100000_invoice_series_single_default` (se aplica sola): deja una sola serie por defecto por emisor (si hubiera varias, se queda la más antigua activa) y crea un índice único. Sin variables nuevas.

Qué cambia para los usuarios:

- **Entrar con verificación en dos pasos** ya no rompe el panel (también al aceptar una invitación).
- **Desactivar la verificación en dos pasos** funciona otra vez (antes la página se rompía).
- **Cerrar la sesión de otro dispositivo** ya no cierra también la tuya.
- **Roles a medida**: solo el propietario puede transferir la propiedad, crear roles, asignarlos y asignar locales.
- **Claves de API**: las nuevas tienen otro formato (`sk_live_<negocio>.<id>_<secreto>`); las antiguas siguen valiendo. Ahora piden al menos un permiso.
- **Recargo por mora**: se configura solo en Escalado de impagos.
- **Páginas sin permiso**: quien abra por dirección una página de Configuración que no le corresponde ve un aviso en vez del formulario.

Tras desplegar, revisar en Facturación que cada emisor tiene su serie por defecto.

## 173. Mejoras de Configuración del panel del tenant (2026-11-20)

Migración `20270215100000_settings_improvements` (se aplica sola): rol y locales en las invitaciones, fecha de recepción y motivo en las solicitudes de protección de datos, preguntas frecuentes en inglés, publicación programada del blog, recordatorios de impago por WhatsApp, dirección de respuesta de los correos y la tabla `web_slug_redirects` (con RLS). Sin variables nuevas.

- **Tarea nueva en el worker**: `blog.publish-scheduled` (cada 5 minutos) publica las entradas programadas.
- **Dominio propio con y sin `www`**: la web responde en las dos formas y redirige a la principal, pero para eso **el Proxy Host de NPM del tenant tiene que incluir las dos** (`dominio.com` y `www.dominio.com`) con su certificado. Al dar de alta un dominio nuevo, añadir las dos. En los que ya están, añadir la forma que falte cuando el tenant lo pida.
- **API de lectura**: los tenants pueden leer inquilinos, contratos y facturas con sus claves de API (`/v1/integrations/…`), con un límite de 120 peticiones por minuto por clave.

Qué cambia para los usuarios:

- **Equipo**: se ve cuántos usuarios del plan quedan; se puede invitar con un rol a medida y unos locales; el propietario puede quitar la verificación en dos pasos a un empleado que perdió el móvil.
- **Páginas con un solo «Guardar»**: Web, Marca y SEO, Textos legales y Plantilla de contrato guardan todo de una vez y avisan si sales con cambios sin guardar.
- **Suscripción**: se puede pasar de mensual a anual (y al revés) en el mismo plan.
- **Cobros**: «Probar TPV» de Redsys, y aviso de cuántas tarjetas o mandatos hay guardados antes de apagar una pasarela.
- **Escalado de impagos**: los recordatorios pueden salir también por WhatsApp.
- **Correo**: vista previa de cada correo automático, «Enviarme uno de prueba» y dirección de respuesta propia.
- **Horario de atención** con turno partido y días cerrados.
- **Blog y landings**: publicación programada, «Redactar con IA» y la dirección antigua redirige a la nueva.
- **Preguntas frecuentes** en inglés.
- **Protección de datos**: vista previa antes de anonimizar, fecha de recepción y motivo al denegar.
- **Integraciones**: evento de prueba, editar webhooks, cuatro eventos nuevos y API de lectura.

## 174. Revisión de Novedades, Cómo funciona y Soporte del panel del tenant: fallos (2026-11-21)

Migración `20270216110000_support_ticket_closed_reason` (se aplica sola): `support_tickets.closed_reason` (`tenant`, `admin` o `inactivity`). Sin variables nuevas.

Qué cambia para los usuarios:

- **Novedades**: quien entra nuevo ya no ve como «sin leer» lo publicado antes de su alta, la ventana de «novedad destacada» solo sale con novedades del último mes, la marca «Sin leer» se mantiene durante la visita, «Ver» solo sale si puede abrir esa página, error con reintentar y «Cargar más».
- **Cómo funciona**: once guías nuevas (WhatsApp, Informes, Asistente IA, Vencimientos, Gastos, Propietarios, Mensajes, Lista de espera, Cierre de caja, Cámaras y Veri\*Factu), los enlaces respetan permisos y plan, el enlace a una guía baja hasta ella y el buscador encuentra también por los enlaces y en plural.
- **Soporte**: validaciones en español, el aviso del menú cuenta los mensajes de TrasterOS, límite de 5 tickets por hora y 20 al día por persona, motivo del cierre en la ficha, no se valora un ticket sin respuesta, quién abrió cada ticket y su categoría, «Cargar más», lista legible en el móvil y firma «Soporte de TrasterOS».
- **Sesión de soporte (impersonación)**: entrar en el panel de un tenant ya no deja leídos sus tickets, mensajes ni novedades.

## 175. Mejoras de Novedades, Cómo funciona y Soporte del panel del tenant (2026-11-21)

Migraciones (se aplican solas): `20270217100000_product_updates_improvements` (novedades dirigidas por plan y rol, reacciones, pruebas de extras y mes del último resumen enviado), `20270217110000_help_topics` (guías editables, tabla global) y `20270217120000_support_improvements` (contexto del ticket, compañeros en copia y estado del servicio). Sin variables nuevas.

- **Tarea nueva en el worker**: `product-updates.digest` (día 2 a las 9:00 de Madrid) envía a cada usuario el resumen de las novedades del mes anterior; cada uno se da de baja desde su perfil o el enlace del correo.
- **Estado del servicio**: panel admin → Seguridad y sistema → «Estado del servicio». Cuando haya una incidencia, márcala ahí: los tenants la ven en Soporte y no abren tickets por lo mismo. Al resolverla, vuelve a «Todo bien».
- **Guías de ayuda**: panel admin → Comunicación → «Guías de ayuda». Las guías del código siguen siendo la base; desde ahí se cambian, se ocultan, se añaden y llevan imagen o vídeo de YouTube/Vimeo.

Qué cambia para los usuarios:

- **Novedades**: filtros por tipo, buscador y «Solo lo de mi plan»; «¿Te ha sido útil?»; «Probar gratis 14 días» en las de una función que no tienen (una prueba por función); resumen mensual por correo; el admin puede dirigir una novedad a unos planes o roles.
- **Cómo funciona**: botón «?» en la cabecera que lleva a la guía de la pantalla, búsqueda que se guarda en la dirección y resalta lo encontrado, y «Preguntar al asistente» cuando no hay guía.
- **Soporte**: guías relacionadas al escribir, temas fijos, la pantalla desde la que escribes, «Preguntar antes al asistente», filtros y búsqueda, reabrir durante 7 días, cambiar la prioridad, confirmación por correo, compañeros en copia, plazo de respuesta orientativo y aviso de incidencias.

## 176. Trasteros cedidos (2026-11-21)

Migraciones (se aplican solas): `20270218100000_unit_status_ceded` (estado `ceded` del trastero, va sola porque Postgres no deja usar un valor nuevo de un tipo en la misma transacción) y `20270218110000_unit_cessions` (tabla `unit_cessions` con RLS). Sin variables nuevas. Tarea nueva `unit-cessions.notices` (cada hora, en el worker).

**Está desactivado para todos los negocios.** Se activa uno a uno desde el panel admin → ficha del tenant → tarjeta de funciones → «Trasteros cedidos». No está en ningún plan ni se vende como extra.

Qué hace, con la función activada:

- El **propietario** (solo él) cede un trastero libre, en mantenimiento o bloqueado a una persona (nombre y teléfono) o a un inquilino, durante N meses o hasta un día. No hay contrato, cobro ni factura, y no se envía nada a nadie.
- El trastero queda **«Cedido»**: no sale en la web ni en la reserva online, no se puede reservar ni contratar y, en las cifras, cuenta como uno en mantenimiento.
- Se crea un **acceso PIN** solo para ese trastero, sin caducidad. El código se ve en la ficha para dárselo en mano y desde ahí se cambia, se deniega o se vuelve a permitir. No aparece en el área de clientes del inquilino enlazado.
- **Avisos al equipo** 7 días antes y el día del fin, también en «Hoy» (pestaña Operación). Al vencer **no se libera** ni se corta el acceso: hay que terminar la cesión a mano, y si quedan días pide confirmación con el tiempo que falta.
- Si se desactiva la función a un negocio con trasteros cedidos, sigue pudiendo terminar esas cesiones y gestionar su acceso, pero no cede nuevos trasteros ni amplía las cesiones.

## 177. Trasteros cedidos: arreglos (2026-11-21)

Sin migración ni variables nuevas.

- «Cedidos» solo sale en la lista y el plano a quien tiene la función o algún trastero cedido.
- El último día de una cesión cuenta como «vence hoy» y la vencida es desde el día siguiente (lista, ficha, «Hoy» y avisos con el mismo criterio). Ampliar una vencida cuenta los meses desde hoy.
- Fechas validadas: no existe un 31 de febrero, el inicio es hoy o antes y no se crea una cesión ya vencida.
- No se puede borrar un local con trasteros cedidos; una cesión sin acceso puede crearlo después; el repaso de credenciales retira el código de una cesión terminada.
- Ceder, reservar y contratar el mismo trastero a la vez ya no se cuelan (mismo candado por trastero, también en la reserva online).
- Durante una sesión de soporte no se ve ni se cambia el código de una cesión.

## 178. Trasteros cedidos: mejoras (2026-11-21)

Migración `20270220100000_unit_cessions_improvements` (se aplica sola): fecha de fin opcional, días de aviso, aplazamiento, recordatorio de las cesiones sin fecha y motivo de fin. Sin variables nuevas.

- **Avisos al propietario** también al móvil y por correo (tipo de aviso «Trasteros cedidos», solo propietarios, desactivable en su perfil o en Ajustes → Correo). A la persona cedida no le llega nada.
- **Página «Cesiones»** (menú Inventario): en curso y terminadas, con filtros, buscador y CSV.
- **Última entrada** de la persona en la tarjeta del acceso («No ha entrado en N días» a partir de 60).
- **Ampliar en un clic** (+1 mes, +3 meses) desde «Hoy» y la página.
- **Pasar a contrato**: termina la cesión y abre el asistente de contrato con el trastero (y el inquilino, si estaba enlazado), sin avisar a la lista de espera.
- **Sin fecha de fin**, con recordatorio cada 1, 3, 6 o 12 meses.
- **Avisar N días antes** (0, 3, 7, 15 o 30) y **posponer el aviso** de una vencida 7 o 30 días.
- **Acceso 24 h** y hasta 5 códigos por cesión, cada uno con su nombre.
- **Descuadres**: la revisión de inventario avisa de un «Cedido» sin cesión y de una cesión cuyo trastero no está cedido.

## 179. «Hoy» del super admin: arreglos (2026-11-21)

Migración `20270221100000_admin_today_snooze_fingerprint` (se aplica sola): huella de lo apartado. Sin variables nuevas.

- Lo apartado vuelve a salir si empeora (el cliente escribe, sube la deuda, hay más fallos…), con el motivo.
- «Colas con fallos» cuenta solo las últimas 24 h; webhooks, solo si siguen fallando.
- Si una sección no carga, el resto sigue y se avisa de cuál falló.
- Los números cuadran: la cabecera son las acciones urgentes y cada pestaña dice cuántas lleva.
- Leads asignados a un comercial ya no cuentan como urgentes del admin.
- El aviso inmediato no se repite cada día por lo mismo.
- Listas largas plegadas, contador del menú ligero (`GET /admin/today/count`, cacheado 30 s) y textos en plural correcto.

## 180. «Hoy» del super admin: mejoras (2026-11-21)

Migración `20270222100000_admin_today_improvements` (se aplica sola): `admin_reviewed_jobs` (trabajos de cola revisados) y `admin_today_visits` (última visita de cada admin), globales con REVOKE. Sin variables nuevas.

- **€ en riesgo hoy** (deuda vencida, pruebas que terminan, extras por cobrar y clientes que dejaron de entrar) y lo que hay en juego en cada fila.
- **Desde tu última visita**: nuevos, resueltos y empeorados.
- **Cobros de la suscripción rechazados** (Stripe, Redsys, SEPA devueltos) y **clientes de pago que han dejado de entrar** (14 días).
- **Tickets con plazo de respuesta**: urgentes solo si vencen en menos de 2 h o ya están fuera de plazo.
- **Leads**: sin asignar (urgentes) y asignados sin atender más de 24 h, con «Asignarme» y «Responder».
- **Colas**: los fallos de 24 h con reintentar y marcar revisado (solo superadmin).
- **Acciones en lote** (apartar, asignarme, recordar el pago), **atajos de teclado** (`j`/`k`, `Intro`, `a`, `m`, `?`) y botón «Siguiente».
- Orden por importancia en todas las listas.
- Un ticket con prioridad «urgente» cuenta siempre como urgente, aunque acabe de abrirse.

## 181. Métricas y Finanzas del super admin: arreglos (2026-11-22)

Migración `20270223100000_mrr_snapshots_without_vat` (se aplica sola): pasa a sin IVA las fotos mensuales de MRR ya guardadas, para que el primer mes no salga como una caída. Sin variables nuevas.

**Cambian cifras que ya se veían (a propósito):**

- **MRR, ingreso medio, cuotas de «Hoy» y de la lista de tenants**: sin IVA, con la cuota anual repartida entre 12 y con el descuento del último pago. Bajan respecto a antes (79 € → 65,29 €).
- **Activos**: ya no cuentan las cuentas en solo lectura (prueba terminada sin pagar) ni las de pago atrasado, que salen aparte.
- **Bajas, churn, retención y churn por razón**: solo de quien llegó a pagar. Una prueba que no pagó no es baja.
- **Pago atrasado**: sigue en el MRR hasta que se suspende la cuenta (ya no sale como baja y luego reactivación).
- **«Devuelto»**: en el mes de la devolución.
- Meses en hora de España; la previsión no proyecta con menos de 3 meses cerrados.

## 182. Métricas y Finanzas del super admin: mejoras (2026-11-22)

Migración `20270224100000_admin_metrics_finance_improvements` (se aplica sola): `mrr_forecasts`, `platform_finance_settings`, `platform_marketing_spend`, `platform_metric_annotations` (globales con REVOKE), `platform_alert_settings.alert_concentration_pct` (25) y `platform_business_goals.collected_target_monthly`. Sin variables nuevas.

**Después de desplegar, revisar en Finanzas → Margen → «Costes»** las estimaciones (las pasarelas no guardan su comisión real):

| Coste                      | Por defecto              |
| -------------------------- | ------------------------ |
| Stripe                     | 1,5 % + 0,25 € por cobro |
| Redsys                     | 0,4 %                    |
| Remesa SEPA                | 0,30 € por adeudo        |
| Dólar → euro (coste de IA) | 0,92                     |
| Cada correo enviado        | 0,001 €                  |

El gasto de marketing de cada mes se apunta ahí mismo (cuenta para el coste de adquisición). La precisión de la previsión empieza a llenarse con el cron mensual del worker.

## 183. Salud, Adopción y Uso del super admin: arreglos (2026-11-22)

Sin migración ni variables nuevas. Tarea nueva en el worker: `tenant-health.daily-snapshot` (03:20, hora de España) guarda la foto de salud del mes (la tendencia ya no depende de que alguien abra la página).

**Cambian cifras que ya se veían (a propósito):**

- **Salud**: por defecto solo clientes que pagan; pruebas (con su puntuación de activación), sin pagar y exentas en pestañas aparte. El último acceso cuenta el uso real de la sesión (la app instalada ya no parece inactiva) y la facturación mira si cada contrato factura dentro de su ciclo.
- **Adopción**: uso en los últimos 90 días; el control de accesos solo con puertas o accesos reales; la cuota, sin IVA (0 en prueba, «pagaría X»); candidatos por llegar a un límite con margen y solo con planes públicos.
- **Coste de IA**: con el precio de cada modelo (Opus 5.5 4/20 $, Sonnet 5.5 2/10 $, Haiku 5.5 0,10/0,50 $…); las variables `AI_COST_*` quedan de respaldo para modelos desconocidos.

## 184. Salud, Adopción y Uso del super admin: mejoras (2026-11-22)

Migración `20270226100000_admin_health_adoption_usage_improvements` (se aplica sola): `users.last_active_day`, tablas `tenant_activity_days`, `tenant_health_daily`, `platform_health_settings` (un registro con los pesos y umbrales por defecto) y `tenant_storage_usage_history` (copia la medición actual como la del mes en que se hizo). Todas globales del admin (`REVOKE` a `storageos_app`). Sin variables nuevas.

- **Actividad del equipo**: desde este despliegue se anota cada día de uso del panel (al entrar o al renovar la sesión, una vez por usuario y día). La frecuencia (días activos en 30) solo entra en la puntuación cuando el tenant lleve un mes de registro: hasta entonces la salud no cambia.
- **Foto diaria**: la tarea `tenant-health.daily-snapshot` (03:20, worker) guarda además la foto del día (historial de 90 días, mini gráfica de 8 semanas, se borra a los 400 días) y avisa al super admin cuando un cliente cae 15 puntos o más en una semana (aviso `health.drop`, una vez por caída en 7 días; también en los avisos de negocio).
- **Almacenamiento**: la medición diaria (`storage-usage.daily`) guarda también la del mes; la previsión necesita al menos dos meses medidos.
- **Ajustes** (Salud → «Ajustes» y Uso → «Ajustes», solo superadmin): pesos de los factores (deben sumar 100), puntos de caída y umbrales del consumo anómalo (3 veces la media de los 3 meses anteriores y por encima de 500 correos, 5 $ de IA o 1024 MB).
- **Avisos de negocio**: dos tipos nuevos, `health_drop` y `usage_anomaly`, en el resumen semanal y por chat si los avisos de negocio están activos.

## 185. Leads del super admin: arreglos (2026-11-22)

Migración `20270227100000_platform_leads_review` (se aplica sola): `platform_leads.awaiting_reply_since`. Sin variables nuevas.

- **CSV**: los textos que empiezan por `=`, `+`, `-` o `@` salen con `'` delante en todos los CSV del panel admin (leads, contacto, correos, facturas de suscripción, Negocio y Finanzas): una fórmula colada por el formulario de la web ya no se ejecuta en Excel.
- **Reasignar un lead mueve también la cartera del comercial** (decisión de Jota); si ya es cliente de un comercial, su cuenta no se toca.
- **Cambian cifras de Resultados (a propósito)**: el embudo no cuenta como contactados a quien se registró solo (sale aparte), la primera respuesta solo mide a quien escribe solo, «Pagan al mes» va sin IVA y el periodo empieza el día 1 del mes.
- Una prueba terminada solo pasa a «Perdido» a los 7 días, en solo lectura y sin cobros en marcha; un cliente que se da de baja pasa a «Cliente que se dio de baja».

## 186. Leads del super admin: mejoras (2026-11-22)

Migración `20270228100000_platform_leads_improvements` (se aplica sola): columnas nuevas en `platform_leads` (motivo de descarte, fusión, dirección de respuesta, reparto, parados, sin secuencia), `platform_lead_activities.attachments`, `platform_quote_offers.open_count/last_opened_at/open_notified_at` (las ya abiertas cuentan una vez y no vuelven a avisar) y tablas globales `platform_lead_settings`, `platform_lead_sequences` y `platform_lead_sequence_enrollments` (con `REVOKE` a `storageos_app`). Crea la secuencia por defecto «Si no contesta» (días 2, 5 y 10). Sin variables nuevas.

- **Respuestas por correo al hilo**: usa `INBOUND_EMAIL_DOMAIN` (la misma de los contactos de los tenants). Sin ella, los correos a los leads salen como hasta ahora (al comercial o al email del formulario) y las respuestas no vuelven a la ficha.
- **Secuencias automáticas**: activadas por defecto; empiezan solas con el primer correo o la propuesta de los leads abiertos y las manda el **worker** (tarea `platform-leads.sequences`, cada 15 minutos): redesplegar también el worker. Se pueden desactivar en Leads → Ajustes → «Correos automáticos».
- **Reparto automático**: apagado por defecto (Leads → Ajustes → «Reparto»). Plazo de primera respuesta 4 h y reasignación una vez; leads parados con 1/5/7/10 días según la fase y «alto valor» desde 150 € al mes sin IVA. La reasignación y los avisos de parados van en la vigilancia de los leads del API (cada 15 minutos).
- **Cambia «Hoy»**: sección nueva «Leads parados» (urgentes solo los de alto valor). La primera vez saldrán todos los parados de antes; se pueden apartar.
- **Alta rápida**: `/admin/leads/capture` (y «Alta rápida» en el panel de los comerciales): conviene guardarla en la pantalla de inicio del móvil.

## 187. Tenants del super admin: arreglos (2026-11-23)

Migración `20270301100000_admin_tenants_review` (se aplica sola): `users.tokens_valid_after`. Sin variables nuevas. Redesplegar api, worker y web.

- **Cerrar sesiones corta ya**: «Cerrar sesiones» de un usuario (soporte, cambio de contraseña…) invalida también su acceso en curso (401 `session_revoked`), no solo la renovación.
- **Cobros que ya no reactivan a quien se suspendió a mano**: un cobro de Stripe o un pago manual solo saca de la suspensión a quien se suspendió por impago (decisión de Jota). Al suspender, el panel avisa si Stripe, SEPA o Redsys siguen cobrando.
- **Quitar la exención**: el periodo empieza el día que se quita (un mes) y los extras manuales cobran en un mes; ya no aparecen meses de deuda por el tiempo exento.
- **Vaciar los datos de prueba**: se bloquea si el tenant ya pagó cuotas (`paid_subscription`) o hay cobros reales por pasarela (`live_gateway_payments`); la vista previa enseña en rojo las facturas emitidas.
- **Impersonación**: la sesión de solo lectura (ahora la opción por defecto) lleva los permisos del propietario para verlo todo; con cambios, no puede crear claves de API ni webhooks, traspasar la propiedad, invitar ni dar acceso al portal.
- **Rol soporte**: ve el documento de los inquilinos enmascarado (`***` + 4 últimos) y la lista llega a 500; sincronizar pagos y descargar el mandato SEPA pasan a ser de superadmin.
- **Anonimizar**: cancela antes la suscripción de Stripe (si Stripe no lo confirma, no anonimiza: 409 `stripe_cancel_failed`), da de baja el mandato SEPA y la tarjeta de Redsys y borra mucho más (tareas, comentarios, expedientes, registros de acceso, cámaras, correos de la plataforma, enlaces de un solo uso, dominio propio…).
- **Cambian cifras (a propósito)**: facturación, resumen y cabecera del tenant con las definiciones del Resumen (sin fianzas, sustitutivas solo la diferencia, inquilinos de prueba fuera, contratos vigentes y usuarios activos); el límite de IA = el propio (o el del plan) más los extras.
- **Aprobaciones**: caducan a los 30 días (al aprobar una vencida: 409 `approval_expired`).

## 188. Tenants del super admin: mejoras (2026-11-23)

Migración `20270302100000_admin_tenants_improvements` (se aplica sola): bajas y anonimizaciones programadas en `tenants`, pagos a mano anulados, usuario de la impersonación, estado del tenant en las aprobaciones, columnas y orden en las vistas guardadas, nota fijada del historial y tabla `tenant_data_exports` (con RLS). Sin variables nuevas. Redesplegar api, worker y web.

- **Cron nuevo** `admin-tenants.scheduled` (00:30, hora de España, en el **API**): aplica las bajas programadas que tocan y ejecuta las anonimizaciones cuyo periodo de gracia acaba.
- **Exportación en segundo plano**: la del super admin la genera la cola `reports` (en producción, el **worker**): hay que redesplegar el worker para que se procese. Avisa en la campana al terminar.
- **Dar de baja ≠ suspender**: «Dar de baja» corta todos los cobros y cuenta como baja; «Suspender» sigue siendo cortar el acceso un tiempo.
- **Anonimizar** pasa a cuatro pasos y, por defecto, con 30 días de gracia y aviso al propietario (0 = ahora).
- **Cambia a propósito**: la lista de Tenants incluye los anonimizados (pestaña «Bajas»), su ficha se abre con lo que queda y el rol soporte puede cortar las impersonaciones que abrió él.

## 189. Comerciales: reparto masivo de prospectos (2026-11-24)

Migración `20270303100000_sales_bulk_assign` (se aplica sola): en `platform_leads`, el lote del reparto (`sales_batch`), cuándo abrió el comercial el prospecto (`sales_seen_at`; lo que ya llevaban los comerciales queda como visto) y el aviso previo a la liberación (`sales_release_warned_at`). Sin variables nuevas. Redesplegar api y web.

- **Reparto desde la dirección**: «Importar y repartir prospectos» en Equipo comercial y en la ficha de cada comercial (CSV o Excel con vista previa), y «Repartir entre comerciales» en la selección de Tenants → Leads (lista). Solo el rol superadmin.
- **Duplicados** (decisión de Jota): sin comercial → se asigna; de otro comercial → no se toca (sale en la vista previa con su nombre); con cuenta → se omite.
- **Avisos**: un solo aviso por comercial y reparto, en su panel y por correo (remitente de «avisos al equipo»). Los prospectos le salen como «Nuevo para ti» hasta que los abre.
- **Cambia la liberación por inactividad** (decisión de Jota): también se liberan los que repartió la dirección, contando desde el reparto, pero **antes se avisa a la dirección** (campana del panel, con la lista) hasta 7 días antes. Tras el despliegue, los prospectos que ya estaban pasados del plazo no se liberan esa noche: primero se avisa y quedan libres a los 7 días.

## 190. Comerciales: cartera manejable (2026-11-24)

Sin migración ni variables nuevas. Redesplegar api y web (va apilada sobre el §189).

- **Prospectos del comercial en tres vistas** (`/admin/sales/leads`): «Por hacer» (la cola del día con su motivo: seguimientos atrasados y de hoy, nuevos sin tocar por cuota prevista, calientes sin hablar en 7 días y pruebas que acaban en 7 días), «Lista» y «Tablero» por fases. El aviso de un reparto (`?filter=new_for_you&batch=…`) abre la lista.
- **Modo llamadas** (`/admin/sales/leads/calls`, también desde «Hoy»): recorre la cola ficha a ficha; anotar el resultado (con su siguiente seguimiento) pasa al siguiente.
- **Lista sin corte de 500**: por páginas («Cargar más»), orden por prioridad, cuota prevista, último contacto o asignación, filtros por lote, ciudad, tamaño, temperatura, «sin tocar» y «nuevos para ti», vistas guardadas propias y acciones en lote (seguimiento, cadencia, fase y «no interesado», que de momento lo pierde con su motivo). En el móvil, tarjetas.
- **Clientes**: filtros (prueba que acaba, con deuda, con algo que ofrecer…), búsqueda, temperatura, lote, orden y vistas guardadas.
- Las vistas guardadas de los comerciales usan la misma tabla que las del panel (`super_admin_saved_views`, páginas `sales_leads` y `sales_clients`): un comercial solo ve y guarda las suyas de esas dos pantallas.
- Tras desplegar, mirar como comercial en el móvil «Prospectos» (las tres vistas) y el modo llamadas.

## 191. Comerciales: no interesados y recuperación (2026-11-24)

Migración `20270305100000_sales_recovery` (se aplica sola): `platform_leads.sales_archived_at`, `sales_recover_on`, `sales_recover_notified_at` y `do_not_contact`; `platform_sales_settings.recover_months`; tabla `sales_recoveries` (global, sin acceso del rol de la app) y `sales_commission_items.recovery_id`. Los perdidos que ya tenían los comerciales pasan a sus archivados y la migración `20270305110000_sales_recovery_backfill` les pone la fecha de volver a intentarlo según su motivo, contando desde que se perdieron (decisión de Jota): los perdidos hace más de ese plazo salen en «Para recuperar» desde el primer día. Sin variables nuevas. Redesplegar api y web (va apilada sobre el §190).

- **«No interesado»** (en la ficha, en lote y al anotar una llamada): el prospecto sale de la cartera activa a «Archivados» con la fecha de volver a intentarlo (propuesta por el motivo y editable) o como «No volver a contactar». Sigue siendo del comercial y, con fecha (o «No volver a contactar»), no se libera por inactividad.
- **Plazos por motivo** en Equipo comercial → Reglas del equipo (por defecto: no es el momento 6 meses, caro u otro programa 12, no responde 3, el resto y las bajas 12).
- **Al llegar la fecha**: «Para recuperar» en «Hoy» y en «Por hacer», y un aviso cada mañana (tarea `sales.recovery`, 08:10, en el API) al comercial; si ya no está activo, a la dirección. «Recuperar» lo devuelve activo con su historial.
- **«No volver a contactar»**: sin recordatorios, correos, secuencias ni cadencias; el reparto no lo da a nadie.
- **Clientes que se dan de baja**: pasan solos a los archivados de su comercial con recordatorio a 12 meses; si vuelven a contratar, el comercial cobra la mitad de la comisión (venta y cuota según su plan), marcada «Recuperación».
- **Recuperados** por comercial en «Mis comisiones» y en la comparativa del equipo; lista para la dirección en `GET /admin/sales-team/recoveries`.
- Tras desplegar, mirar como comercial (escritorio y móvil) «No interesado» en una ficha, «Prospectos» → «Archivados» y «Hoy»; como dirección, las Reglas del equipo y la comparativa.

## 192. Comerciales: carteras para la dirección (2026-11-24)

Migración `20270306100000_sales_portfolios_view` (se aplica sola): `platform_sales_settings.first_contact_alert_days` (5 por defecto) y `platform_leads.sales_first_contact_warned_at`. Sin variables nuevas. Redesplegar api y web (va apilada sobre el §191).

- **Equipo comercial → Carteras** (`/admin/sales-team/portfolios`, solo superadmin; soporte no la ve en el menú y el API le responde 403, igual que a los comerciales): todos los prospectos y clientes de todos los comerciales en una tabla con comercial, fase, temperatura, último contacto, siguiente paso, valor, días sin tocar, lote y archivado. Embudo por fases, archivados y «sin tocar» arriba; filtros (comercial o sin comercial, temperatura, nunca contactados o sin tocar en 7-90 días, lote, prospectos o clientes, activos o archivados), orden, «Cargar más» y CSV (hasta 5.000 filas).
- **Ficha en un panel lateral**: ficha comercial, cronología entera (llamadas, notas, correos, citas, propuestas, cadencias, seguimientos, reparto, archivo y recuperación) y lo que puede hacer la dirección: **nota al comercial** (le llega un aviso), **reasignar** (a otro o sin comercial), **editar la ficha comercial**, **mover de fase**, **archivar** y **recuperar**. Todo queda marcado «Dirección» en la cronología, en el registro de acciones (`admin.sales.direction_*`) y con aviso al comercial. Una nota o un cambio de la dirección no cuenta como contacto con el cliente (no mueve el último contacto ni lo saca de «sin tocar») ni como trabajo del comercial para la liberación por inactividad.
- La pestaña **Cartera** de la ficha de cada comercial usa esa misma tabla filtrada por él, con su embudo y sus sin tocar arriba («Pasar su cartera a otro» sigue debajo).
- **Aviso a la dirección**: en la tarea nocturna de comerciales (`sales.daily`, 03:40, en el API), los prospectos que repartió la dirección (en un reparto o a mano) sin primer contacto de su comercial en los días de Reglas del equipo («Avisarte si no llaman a un prospecto que repartiste en…», 0 = nunca) salen en un aviso con la lista, una vez por prospecto y reparto.
- Tras desplegar, mirar como dirección (escritorio y móvil) Equipo comercial → Carteras, abrir una cuenta y dejar una nota, y la pestaña Cartera de un comercial.

## 193. Seguimientos, Trials, En riesgo y Oportunidades: arreglos (2026-11-25)

Migración `20270307100000_risk_snooze_kind` (se aplica sola): `tenants.risk_snoozed_kind`. Los tenants ya ignorados en «En riesgo» (sin sección guardada) siguen ocultos en todas las secciones hasta que venza su plazo; lo que se ignore a partir de ahora solo se oculta en su sección. Sin variables nuevas. Redesplegar api y web.

- **Seguimientos**: los de los prospectos de los comerciales ya no salen en la bandeja de la dirección ni en «Hoy» (están en Carteras). Lo que crea un super admin desde la ficha, el playbook o las propuestas queda a su nombre salvo que diga otro (los automáticos, sin asignar). «Precio a medida» ya no se asigna al comercial (no podía verlo): va sin asignar con su nombre en la nota. Fechas en hora de España. La bandeja avisa si llega a su tope (500 de tenants, 300 de leads), avisa de los errores en vez de quedarse cargando, los leads tienen el mismo «Posponer» y «Quién se encarga» que los tenants y en el móvil las acciones van debajo del título.
- **Trials**: una prueba vencida que la tarea nocturna aún no ha cerrado sale como «Vencida» (también en En riesgo y en «Hoy»); «Vence hoy» y los días cuentan en hora de España. El rol soporte ya no ve «+14 días», la selección ni el lote (le daban 403). «+14 días» pide motivo y el lote dice cuáles se ha saltado y por qué.
- **En riesgo**: «Ignorar» oculta solo la sección en la que se pulsa (un impago o un fin de prueba nuevo sale igual) y «Hoy» no lo tiene en cuenta (tiene su propio «apartar»). Lista plegable «Ignorados» con la sección, hasta cuándo, el motivo y «Volver a mostrar». «Inactivos» son solo los que pagan y llevan más de 14 días de alta; las pruebas caducadas sin pagar (en solo lectura) tienen su propia sección. Textos claros («La cuota no se ha podido cobrar», «Debe desde»), el nombre lleva a la ficha y la fila dice si ya se lanzó el playbook (y el botón espera).
- **Oportunidades**: el mismo extra no se vuelve a proponer al mismo tenant en 14 días (409 `addon_offer_recent`); una sola prueba gratis por extra y tenant, también desde el panel (409 `addon_trial_used`); a suspendidos o de baja, nada (400 `tenant_not_live`); sin destinatarios no se activa la prueba ni se deja nada (400 `no_recipients`). La propuesta es comercial: no llega a quien se dio de baja de las ofertas y lleva su enlace de baja. Cámaras solo a quien usa el control de accesos de verdad; SEPA y automatizaciones cuentan inquilinos con contrato vivo; los extras de capacidad usan el 80 % (como Adopción) y cuentan lo que ya dan sus extras, y hay regla para el de usuarios. La página oculta por defecto a los tenants en prueba («Incluir pruebas»). El interés en funciones ya no cuenta lo que hace el soporte entrando como el tenant.
- Tras desplegar, mirar en el panel admin (escritorio y móvil) Seguimientos, Trials, En riesgo (ignorar una fila y verla en «Ignorados») y Oportunidades.

## 194. Seguimientos, Trials, En riesgo y Oportunidades: mejoras (2026-11-25)

Migraciones (se aplican solas): `20270308100000_followup_outcome` (`tenant_followups` y `platform_lead_followups` ganan `outcome` y `completed_by_id`) y `20270308110000_opportunity_dismissals_offers` (tablas de la plataforma `platform_opportunity_dismissals` y `platform_addon_offers`, sin acceso del rol de la app; rellena `platform_addon_offers` con las propuestas que ya constaban en el registro de acciones). Sin variables nuevas. Redesplegar api y web (va apilada sobre el §193).

- **Seguimientos** (`/admin/followups`): una sola bandeja para tenants y leads con pestañas Hoy, Atrasados, Próximos y Hechos (30 días, con quién lo cerró y «qué pasó»), buscador, filtro por responsable y por tipo, «Nuevo seguimiento» con buscador de tenant o lead, editar (título, nota, fecha, responsable), posponer, reasignar y marcar hechos varios a la vez. Al marcar hecho se puede escribir qué pasó (queda en la conversación del tenant o en la actividad del lead) y crear el siguiente seguimiento. El menú «Seguimientos» avisa de los atrasados tuyos o sin asignar.
- **Trials** (`/admin/trials`): cifras arriba (pruebas en curso, conversión del mes, días hasta pagar, ampliadas este mes), buscador, filtros (vencen esta semana, vencidas, sin usar, con uso real, por comercial), páginas de 25, progreso de la puesta en marcha con lo que falta y probabilidad de pagar con su motivo, comercial y lead de origen, escribir a varios con plantillas (sale como anuncio a esos tenants) y la pestaña «Caducadas sin pagar» (reabrir la prueba, pasar a un plan, escribir).
- **En riesgo** (`/admin/at-risk`): cuota en juego por fila y en total, secciones de más dinero a menos, quién lo lleva y último contacto, y dos secciones nuevas: «Baja programada» y «Cancelará al final del periodo» (se ignoran por sección, como las de la §193). Sigue siendo un solo endpoint (`GET /admin/tenants/at-risk`, ampliado). El playbook abre un diálogo con el correo propio del motivo (impago, prueba que vence o caducada, inactivo, salud baja, baja) y un mensaje opcional, con vista previa; se mantiene el enfriamiento de 14 días.
- **Oportunidades** (`/admin/opportunities`): ingreso posible por extra y en total (con «IVA incl.» o «sin IVA» según los precios de la plataforma), vista «Por cliente», buscador, estado de cada propuesta (enviada, probándolo, contratado, sin respuesta tras 14 días) y tasa de aceptación por extra en 90 días, «No le interesa» (30/90/180 días o siempre, con motivo; lista de descartados con deshacer), proponer a varios a la vez con vista previa de los correos y de los que se saltan, y «Al comercial» si el tenant tiene comercial (seguimiento en su prospecto y aviso en su campana).
- Tras desplegar, mirar como superadmin (escritorio y móvil) las cuatro pantallas, y como soporte que no salen los botones de escritura de Trials, En riesgo y Oportunidades.

## 195. Problemas de facturación y Dominios propios: arreglos (2026-11-26)

Migración `20270309100000_admin_custom_domain_health` (se aplica sola): `tenants.custom_domain_paused_verified_at`, `custom_domain_checked_at`, `custom_domain_check_ok` y `custom_domain_check_issue`. Sin variables nuevas. Redesplegar api, worker y web.

- **Dominio propio en pausa por plan.** Si un negocio con dominio activo deja de tener la función (cambio de plan, cortesía o prueba que caduca, extra que se quita), su dominio pasa a «En pausa»: `custom_domain_verified_at` queda en null (los enlaces de firma, portal, reserva, correos, avisos, web y CORS vuelven solos a la dirección de la plataforma, sin tocar los ~40 sitios que construyen enlaces) y la fecha de activación se guarda en `custom_domain_paused_verified_at`. Si recupera la función, se reactiva solo. Lo sincroniza `reconcileCustomDomainPause` (`common/custom-domain-pause.ts`) al cambiar de plan o de funciones desde el panel, al contratar o quitar un extra y al caducar una cortesía, y la tarea `custom-domains.plan-sync` (cada 10 minutos, API) como red de seguridad: tras un cambio hecho por otro camino (p. ej. el webhook de Stripe) puede tardar hasta 10 minutos.
- **Activar un dominio** (`POST /admin/tenants/:id/custom-domain/verify`) comprueba el plan, el DNS (principal y su forma con o sin `www`) y que responda por https; si no, 409 `custom_domain_not_ready` con el detalle por nombre. `{ "force": true }` («Activar igualmente», solo superadmin) salta las comprobaciones; sin la función del plan queda activo pero «En pausa». Al activar o desactivar, el tenant recibe un aviso en el panel y un correo a sus propietarios. «Desactivar» pide confirmación.
- **Vigilancia de los dominios activos**: tarea diaria `custom-domains.active-check` (06:40, API; con las mejoras del §196 la sustituye la comprobación completa `custom-domains.full-check`, que da el mismo estado y el mismo aviso) y «Comprobar ahora» en la fila. Si el DNS deja de apuntar o el https no responde, aviso al super admin `custom_domain.broken` (una vez por episodio) y la fila muestra «Ya no apunta». Un dominio pendiente cuyo DNS deja de apuntar pierde su «DNS listo desde…». Si el tenant cambia o quita su dominio, el super admin recibe `custom_domain.removed` («borra el Proxy Host de…»).
- **Problemas de facturación** (`/admin/billing-health`, también «Hoy»): salen los registros de Veri\*Factu que nunca llegaron a enviarse (más de 48 h pendientes o con el emisor fallando 3 veces seguidas, con el último error), las facturas aceptadas con errores, los envíos enteros fallidos o rechazados de los últimos 7 días (si no hay uno correcto después) y los tenants con Veri\*Factu activado y envío real sin certificado. Los certificados de propietarios cuentan y se nombran. Los tenants borrados, cancelados o con Veri\*Factu apagado, y el certificado de quien emite en Holded, ya no cuentan. La lista de facturas dice «se muestran las 50 más recientes de N». Con «Solo con problemas» desmarcado se ven también los tenants con Veri\*Factu activo y sano (último envío y modo: simulado, pruebas o real).
- «Reenviar» una factura a la AEAT pide confirmación y un motivo (3 caracteres como mínimo, `POST /admin/billing-health/invoices/:id/resend-aeat {reason}`), que viaja a la subsanación y queda en el historial del tenant y en el registro de acciones.
- Tras desplegar, mirar en el móvil y en escritorio **Dominios propios** (las tres listas, «Comprobar ahora», «Activar igualmente») y **Problemas de facturación**, y repasar los dominios que ya estaban activos: los que su plan no incluya pasan a «En pausa» en los 10 primeros minutos.

## 196. Problemas de facturación y Dominios propios: mejoras (2026-11-26)

Migración `20270310100000_admin_domains_ops` (se aplica sola): tablas globales (sin acceso del rol de la app) `platform_domain_checks` (cada comprobación completa de un dominio), `platform_domain_checklists` (casillas de la guía por tenant), `platform_domain_cleanups` (Proxy Hosts por borrar) y `platform_domain_settings` (un registro: aviso por correo al tenant, **apagado por defecto**). Sin variables nuevas. Redesplegar api y web (va apilada sobre el §195). `BillingModule` exporta ahora `VerifactuDispatcher`.

- **Problemas de facturación** (`/admin/billing-health`, ahora con pestañas): **Resumen** (lo de siempre), **Facturas** (lista por páginas de 25 con filtro por tenant y tipo —rechazada, con error, aceptada con errores, sin respuesta, sin enviar—, selección y acciones en lote de hasta 50, exportar a CSV de hasta 5.000 filas, y la ficha de cada una), **Envíos atascados** (emisores con registros en cola desde hace más de 30 minutos o con envíos fallidos seguidos, con el último error y «Reintentar ahora», solo superadmin), **Tenants** (todos los que tienen Veri\*Factu, también los sanos: modo —pruebas, real o simulado—, último envío correcto, pendientes y certificado, con «Avisar al tenant»), **Certificados** (calendario a 60 días, incluidos los de propietarios; quien emite en Holded no cuenta) y **Otros** (primera factura sin emitir, factura de suscripción sin NIF o domicilio, sin serie por defecto, sin datos fiscales).
- **Ficha de la incidencia**: mensaje completo de la AEAT, código, qué hay que hacer (tabla de códigos frecuentes en `packages/shared/src/admin/billing-ops-health.ts`, orientativa: manda el mensaje de la AEAT), el registro y su historial, y acciones: consultar, reenviar con motivo obligatorio (superadmin; queda en el historial del tenant y en el registro de acciones), copiar el XML guardado y abrir la ficha del tenant (la impersonación de solo lectura se lanza desde allí).
- **Avisos al tenant** con el correo ya redactado (certificado a punto de caducar, falta el certificado, facturas rechazadas, Holded para revisar), vista previa y mensaje opcional; no se repite el mismo aviso al mismo tenant en 7 días. Queda en el historial del tenant.
- **Dominios propios** (`/admin/custom-domains`): «Comprobar ahora» hace la comprobación completa (DNS de la raíz y de `www`, respuesta https con su tiempo y validez y caducidad del certificado; en el servidor se conecta solo a dominios válidos que no resuelvan a direcciones internas) y deja el resultado en la fila; «Comprobar todos»; buscador y filtros (pendientes, activos, en pausa, con problemas); «Cómo se activa» (registros DNS exactos y pasos de Nginx Proxy Manager para copiar, con casillas de lo hecho); «Historial» por dominio; dominio de correo del tenant en la fila.
- **Una sola vigilancia** (tarea `custom-domains.full-check`, 06:40, en el API; sustituye a la `custom-domains.active-check` del §195): comprueba cada día los dominios activos y en pausa con la comprobación completa (DNS, https y certificado) y guarda el resultado en las mismas columnas del §195 (la fila dice «Responde», «Ya no apunta», «No responde por https» o «Certificado con problema»). Si un activo deja de responder, un único aviso por episodio (`custom_domain.broken`); un dominio en pausa no avisa (sus enlaces ya usan la plataforma). El certificado avisa a 14, 7 y 1 días (`custom_domain.cert_expiring`, una vez por hito) y, con el interruptor de la página activado, se escribe al tenant (como mucho cada 3 días por problema).
- **Pendiente de limpiar**: cuando un tenant cambia o quita su dominio ya activado, en pausa o con el DNS listo, llega un único aviso (`custom_domain.removed`, del §195) y queda en la página el Proxy Host de NPM que hay que borrar, con «Hecho».
- Un dominio **en pausa** (su plan no incluye la función) es un estado propio: filtro «En pausa», comprobaciones e historial, y nunca cuenta como activo ni como «con problemas» por la función.
- Las facturas con problemas, los conteos, la lista y «Hoy» usan un único criterio (`aeatProblemWhere`, del §195): envíos atascados, aceptadas con errores, sin tenants de baja ni con Veri\*Factu apagado o simulado, y el certificado solo cuenta con envío real y sin Holded.
- Tras desplegar: abrir «Comprobar todos» en Dominios propios y revisar la lista; decidir si se activa el aviso por correo a los tenants.

## 197. SEO Avanzado, PR 1: proyectos y Search Console (2026-11-26)

Migraciones (se aplican solas): `20270311100000_seo_advanced_base` (tablas `seo_projects`, `seo_project_domains`, `seo_gsc_metrics` y `seo_sync_runs`, con su política de filas: lo de la plataforma tiene `tenant_id` nulo y el rol de la app no lo ve) y `20270311110000_seo_migrate_search_console` (crea la función `seo_migrate_search_console()` y la ejecuta: cada tenant con Search Console conectado en «SEO local» recibe su proyecto, su dominio principal y una copia de lo descargado —totales por día, por dispositivo y búsqueda × página—; las tablas antiguas no se tocan y siguen alimentando «Posiciones en Google»). Redesplegar api, worker y web.

- **Cola nueva `seo`** (en el worker): las descargas de Search Console. El worker importa `SeoAdvancedModule`; al arrancar vuelve a poner en la cola lo que quedó a medias.
- **Cron `seo.gsc-daily`** (07:00 en España, worker): últimos 5 días de cada dominio conectado de la plataforma y de los tenants con SEO Avanzado (activos o en prueba). Un dominio sin la carga inicial hecha (los que vienen de «SEO local») hace la inicial (16 meses).
- **Extra nuevo «SEO Avanzado»** (`addon-seo-advanced`, 199 €/mes, función `seo_advanced`, incluye «SEO local»): lo siembra el bootstrap. Revisar el precio y la descripción en `/admin/addons`.
- Variables opcionales: `SEO_GSC_INITIAL_DAYS` (486, días de la carga inicial) y `RETENTION_SEO_GSC_DETAIL_DAYS` (760: los cruces búsqueda × página y búsqueda × país se borran a los 25 meses; el resto no caduca). Usa la cuenta de servicio de siempre (`GSC_SERVICE_ACCOUNT_JSON`).
- Tras desplegar: en el panel admin → SEO → Proyectos, crear el proyecto de `trasteros.pro`, añadir `sc-domain:trasteros.pro` (la cuenta de servicio debe estar como usuario de la propiedad), comprobar el acceso y esperar a que termine la carga inicial (barra de progreso; con 16 meses tarda unos minutos). Mirar el resumen de 28 días y compararlo con el panel de Search Console (clics e impresiones deben coincidir). En «Sistema y colas», la cola `seo` sin fallos. En «Proyectos de los tenants», GUÁRDALO con su proyecto migrado (sin el extra no se descarga: activarlo como cortesía desde su ficha si se quiere).

## 198. SEO Avanzado, PR 2: dominio secundario, Excel históricos y panel (2026-11-26)

Migración (se aplica sola): `20270312100000_seo_advanced_panel` (`seo_project_domains.verification` —`own` en todos los existentes—, tablas `seo_gsc_imports` y `seo_gsc_import_rows` con su política de filas, y `seo_gsc_metrics.source` —`api` en todo lo existente— + `import_id`). Redesplegar api, worker y web.

- **Dominio secundario de otra web**: un tenant puede añadir como secundaria una propiedad de Search Console que no sea «suya» en TrasterOS si nuestra cuenta de servicio tiene acceso a ella, no es de la plataforma y no la usa nadie más (ni otro tenant ni un proyecto de TrasterOS). El principal sigue siendo solo una web del negocio. Para GUÁRDALO: pedir que añadan la cuenta de servicio como usuario de `trasterosmislata.es` en Search Console y añadirlo desde Análisis → SEO Avanzado → Dominios.
- **Importar histórico**: en la ficha del proyecto (admin, solo los de la plataforma) y en Análisis → SEO Avanzado (tenant, `settings:manage`) → «Importar histórico». Acepta el Excel o el zip de CSV que exporta Search Console (Rendimiento → Exportar), en español o en inglés, hasta 20 MB. Primero enseña la vista previa (periodo, filas por pestaña, días que ya tiene la API y los que se añadirán, filtros) y después importa. El mismo fichero no entra dos veces.
- **Panel nuevo** en las dos fichas (sustituye al resumen de la PR 1): periodos de 7, 28 y 90 días, 6 y 12 meses y a mano; comparación con el periodo anterior y con el mismo del año pasado (si hay datos); gráficos de clics, impresiones, CTR y posición; por dispositivo, país y tipo de búsqueda; búsquedas y páginas con variación, buscador, orden, «Cargar más», CSV y su cruce. Panel admin → SEO → Proyectos: tabla «Todos los proyectos, últimos 28 días».
- El módulo se parte en dos: `SeoAdvancedModule` (núcleo, también en el worker) y `SeoAdvancedHttpModule` (rutas, panel e importación, solo en el API). El worker no cambia de dependencias.
- Tras desplegar: abrir el proyecto de `trasteros.pro` y comprobar que los clics e impresiones de 28 días coinciden con Search Console; exportar de Search Console un Excel de hace más de 16 meses, importarlo y ver que en «12 meses» o con «Personalizado» aparecen esos días marcados «Importado» y que la comparación con el año anterior se activa.

## 199. SEO Avanzado, PR 3: SISTRIX (2026-11-26)

Migración (se aplica sola): `20270313100000_seo_sistrix` — `seo_projects.use_platform_sistrix`; columnas nuevas en `seo_sync_runs` (`data_type`, `progress`, `items_*`, `paused_*`, `credits_used`); tablas `seo_provider_connections`, `seo_sync_settings`, `seo_competitors`, `seo_project_keywords`, `seo_keyword_metrics`, `seo_domain_metrics`, `seo_domain_keywords`, `seo_serp_results`, `seo_domain_opportunities`, `seo_backlink_targets`, `seo_ai_visibility`, `seo_api_requests` y `seo_api_cache` (con su política de filas; el `tenant_id` es el dueño de la conexión con que se pidió el dato, nulo = la plataforma) y las globales `seo_keywords` y `seo_oauth_states` (con `REVOKE` para el rol de la app). Redesplegar api, worker y web.

- **Dependencia nueva**: `@modelcontextprotocol/sdk` 1.32.2 (api y worker), el SDK oficial del MCP. Viene en la imagen; no hay que instalar nada.
- **Módulos**: las tandas, los clientes de SISTRIX y sus crons van en el núcleo `SeoAdvancedModule` (también en el worker); el OAuth, las integraciones y las rutas de datos, en `SeoAdvancedHttpModule` (solo el API).
- **Cola nueva `seo-sistrix`** (worker, concurrencia 1) y **crons** `seo.sistrix-schedule` (cada hora, minuto 15), `seo.sistrix-resume` (00:05 de Madrid) y `seo.sistrix-daily` (06:30). Salen en Sistema y colas.
- **Variables opcionales**: `RETENTION_SEO_API_REQUESTS_DAYS` (90, registro de peticiones a SISTRIX) y `SISTRIX_MODE=stub` (solo desarrollo: simula SISTRIX). La conexión y las claves no van en variables: se configuran en el panel y se guardan cifradas con `MASTER_ENCRYPTION_KEY`. `API_BASE_URL` y `WEB_BASE_URL` deben ser las de producción: la dirección de vuelta del OAuth es `${API_BASE_URL}/v1/admin/seo/sistrix/callback`.
- **Tras desplegar**: panel admin → SEO → Integraciones → «Conectar SISTRIX» con la cuenta de Jota (se abre SISTRIX, se autoriza y se vuelve al panel con «SISTRIX conectado»). Comprobar que salen las herramientas y que «Probar la conexión» da la visibilidad de trasteros.pro. La API clásica queda desactivada: solo si se quiere poder «Continuar por API» cuando el MCP agote la cuota, poner la clave, un presupuesto semanal pequeño y activarla. En la ficha del proyecto de trasteros.pro añadir competidores y palabras y «Sincronizar ahora» la visibilidad. Para GUÁRDALO: en su proyecto (Proyectos de los tenants) marcar «Usar la conexión de SISTRIX de la plataforma».

## 200. SEO Avanzado, PR 4: motor de oportunidades (2026-11-26)

Migración (se aplica sola): `20270314100000_seo_opportunities` — `seo_projects.opportunity_settings` (umbrales; los pesos siguen en `weights`) y `seo_projects.opportunities_calculated_at`; tabla `seo_opportunities` (proyecto, dominio, tipo, clave estable, puntuación y factores, métricas, estado, motivo al descartar, asignación, notas y fechas) con su política de filas (`tenant_id` del proyecto, nulo = la plataforma). Se borra al anonimizar un tenant. Redesplegar api, worker y web.

- **Sin variables nuevas ni dependencias.** El cálculo va en el núcleo `SeoAdvancedModule` (también en el worker); las rutas, en `SeoAdvancedHttpModule`.
- **Cola**: job nuevo `opportunities` en la cola `seo` (lo procesa el worker): un recálculo pendiente por proyecto (`seo-opp-<proyecto>`), a los 60 s de terminar una descarga de Search Console o una tanda de SISTRIX de oportunidades, palabras de dominios o métricas. No bloquea la descarga.
- **Tras desplegar**: en la ficha del proyecto de trasteros.pro (y en GUÁRDALO desde su panel) pulsar «Recalcular ahora» en Oportunidades para tener la primera lista sin esperar a la descarga de mañana. Revisar con Jota los pesos y umbrales por defecto (botón de ajustes de la tarjeta) con los datos reales.

## 201. SEO Avanzado, PR 5: diagnóstico (2026-11-26)

Migración (se aplica sola): `20270315100000_seo_diagnostics` — `seo_projects.diagnostic_settings` (umbrales de canibalización y reglas de indexación; vacío = los de por defecto) y `seo_projects.diagnostics_calculated_at`; tablas `seo_cannibalizations` y `seo_index_findings` (estado, notas y fechas, con su política de filas; `tenant_id` del proyecto, nulo = la plataforma; se borran al anonimizar un tenant); índice `seo_gsc_metrics (domain_id, grain, query, date)` para la evolución de cada palabra (en una tabla grande tarda unos segundos en crearse). Redesplegar api, worker y web.

- **Sin variables nuevas ni dependencias.** El cálculo va en el núcleo `SeoAdvancedModule` (también en el worker) y corre en el mismo job `opportunities` de la cola `seo`, después de las oportunidades; las rutas, en `SeoAdvancedHttpModule`.
- **Mapas del sitio**: se enseña lo que da la API de Search Console (URL enviadas, avisos y errores); no se descarga el contenido de cada mapa.
- **Tras desplegar**: en la ficha del proyecto de trasteros.pro (y en GUÁRDALO desde su panel) pulsar «Recalcular» en «Palabras seguidas y diagnóstico» para no esperar a la descarga de mañana. Revisar con Jota las reglas de indexación por defecto (Ajustes de la tarjeta) y añadir las de cada web (por ejemplo los centros de demostración). Dar de alta las palabras desde Search Console o importar el Excel de palabras objetivo, y poner la URL objetivo de las principales (o aceptar la propuesta).

## 202. SEO Avanzado, PR 6: actuaciones y tareas (2026-11-26)

Migración (se aplica sola): `20270316100000_seo_plan` — tablas `seo_changes` (actuaciones: día y hora del cambio, tipo, URLs como se apuntaron y normalizadas, palabras, enlaces a la oportunidad, canibalización, hallazgo y tarea, y quién la apuntó) y `seo_tasks` (tareas: tipo, estado, prioridad, responsable, fechas límite y de publicación, URL, palabras, orden en su columna, enlaces y los avisos ya dados), con su política de filas (`tenant_id` del proyecto, nulo = la plataforma). Se borran al anonimizar un tenant. Redesplegar api, worker y web.

- **Sin variables nuevas ni dependencias.** El antes y después no se guarda: se calcula al abrir la lista o la ficha desde `seo_gsc_metrics`.
- **Cron nuevo** `seo.tasks-due` (08:00 de Madrid, en el worker): avisa de las tareas abiertas que vencen hoy o van atrasadas (una vez por tarea y día). Sale en Sistema y colas.
- **Avisos**: en el tenant, notificaciones del panel (`seo.task_assigned`, `seo.task_due`); en la plataforma, avisos del super admin con destinatario (también por push si lo tiene activado).
- **Tras desplegar**: en la ficha del proyecto de trasteros.pro (y en GUÁRDALO desde su panel), sección «Plan»: apuntar como actuaciones los cambios hechos en las últimas semanas (con su fecha, URL y palabras) para tener ya su comparación a 7 y 28 días, y pasar al tablero lo que haya pendiente de las oportunidades y la canibalización («Crear tarea» en su ficha).

## 203. SEO Avanzado, PR 7: importación de los Excel maestros (2026-11-26)

Migración (se aplica sola): `20270317100000_seo_master_import` — tablas `seo_master_imports` (cada maestro importado, con su Resumen, sus reglas, lo que hizo cada hoja y las filas con aviso), `seo_master_import_items` (lo que creó o rellenó, con los valores que puso, para deshacerlo al borrar) y `seo_keyword_groups` (grupos del catálogo con prioridad, URL objetivo y nota), con su política de filas (`tenant_id` del proyecto, nulo = la plataforma; se borran al anonimizar un tenant); columna `master_import_id` en `seo_project_keywords`, `seo_competitors` y `seo_tasks` (origen; `SET NULL` al borrar la importación) y en `seo_keyword_metrics`, `seo_domain_keywords` y `seo_gsc_imports` (se borran con ella); `seo_tasks.external_ref` (P01… del plan). Redesplegar api y web (el worker no cambia).

- **Sin variables nuevas ni dependencias.** El lector de Excel de las importaciones (`apps/api/src/modules/imports`) ahora abre también los Excel del OpenXML SDK (prefijo `x:` y destinos absolutos), que exceljs no leía: los normaliza con jszip antes de abrirlos. Vale para todas las importaciones (inquilinos, trasteros, contratos, Search Console…).
- **Importar un maestro**: en la ficha del proyecto (admin, solo los de la plataforma y con el rol superadmin) y en Análisis → SEO Avanzado (tenant, `settings:manage`) → «Importar maestro». El dominio de la hoja Resumen tiene que ser uno del proyecto. Primero enseña qué hace cada hoja (nuevas, rellenadas, que ya estaban y omitidas con el motivo) y después importa. El mismo fichero no entra dos veces; una versión nueva no pisa lo cambiado a mano ni duplica las tareas del plan.
- **Tras desplegar**: importar `SEO_maestro_TRASTEROS_PRO.xlsx` en el proyecto de trasteros.pro (panel admin → SEO → Proyectos) y `SEO_maestro_GUARDALO.xlsx` desde el panel de GUÁRDALO (Análisis → SEO Avanzado, con su dominio `guardalobox.es` dado de alta). En local, con los ficheros reales: trasteros.pro 185 palabras nuevas y 2 rellenadas (39 «sin seguir»), 40 con métricas de SISTRIX, 86 posiciones de la competencia (3 repetidas, se guarda la mejor), 9 competidores, 17 grupos y 15 tareas; de Search Console no entra ningún día porque los 130 ya los tiene la API. GUÁRDALO: 118 palabras (42 «sin seguir»), 36 con métricas, 132 posiciones (12 repetidas), 7 competidores, 16 grupos, 12 tareas y 51 días de Search Console. Revisar luego las fechas límite de las tareas (cuentan desde el día de la importación) y la intención de las palabras «Mixta» (se quedan sin intención para que la deduzcan SISTRIX o las reglas).

## 204. SEO Avanzado, PR 8: conversiones, alertas e informes (2026-11-26)

Migración (se aplica sola): `20270318100000_seo_advanced_reports` — tablas `seo_conversions_daily` (conversiones de Google por día, tipo y página de entrada), `seo_alerts` (una viva por clave, índice parcial) y `seo_reports` (informes enviados; el cron, uno por proyecto y periodo), con su política de filas (`tenant_id` del proyecto, nulo = la plataforma; se borran al anonimizar un tenant, también los PDF de `<tenant>/seo-reports/`); `seo_projects.alert_settings`, `report_settings`, `platform_conversions`, `conversions_calculated_at` y `alerts_checked_at`; página de entrada y origen donde faltaban: `leads.landing_path`, `waitlist_entries.utm_source/utm_medium/utm_campaign/landing_path`, `platform_contact_messages.kind/utm_*/landing_path` y `tenants.signup_utm_*/signup_landing_path`. Redesplegar api, worker y web.

- **Sin variables nuevas ni dependencias.** El PDF lo dibuja Puppeteer (ya en las imágenes de api y worker) y se guarda en el bucket privado `reports`.
- **Crons nuevos**: en el worker, `seo.conversions-daily` (05:15 de Madrid: recalcula los últimos 7 días de cada proyecto), `seo.report-weekly` (lunes 09:00) y `seo.report-monthly` (día 3, 09:00); en el API, `seo.alerts` (cada hora, minuto 20; solo mira los proyectos con datos nuevos o sin mirar desde hace 6 horas). Las alertas van en el API porque los avisos de la plataforma por Telegram o Slack salen del panel admin.
- **SEO local**: con SEO Avanzado y el informe mensual del proyecto activado (lo está por defecto), el informe mensual de «Posiciones en Google» no se envía (le llega el nuevo, que lo incluye); igual con su aviso de caída de clics si la alerta `clicks_drop` está activa. Si el tenant apaga el informe o la alerta en SEO Avanzado, vuelven los de SEO local.
- **Atribución**: la web manda ahora la página de entrada (`landingPath`) con la reserva, el contacto, la lista de espera, el formulario de trasteros.pro y el registro; lo anterior a este despliegue no la tiene y sale como «No se sabe».
- **Tras desplegar**: en la ficha del proyecto de trasteros.pro, en «Lo que trae Google», comprobar que dice que cuenta lo de la plataforma (si el dominio no es el de `WEB_BASE_URL`, marcarlo a mano) y pulsar «Recalcular»; en GUÁRDALO, lo mismo desde su panel. Revisar con Jota los umbrales de las alertas (Ajustes de la tarjeta) y a quién le llegan los informes (el mensual sale activado; el semanal, no), y probar «Enviármelo ahora» para ver el PDF real.

## 205. SEO Avanzado, PR 9: inspección de URL y PageSpeed (2026-11-26)

Migración (se aplica sola): `20270319100000_seo_url_inspection` — tablas `seo_url_inspections` (cada inspección de URL con lo que dijo Google, histórico; también las que esperan a la cuota) y `seo_pagespeed_runs` (cada medición de PageSpeed por URL y estrategia, histórico), con su política de filas (`tenant_id` del proyecto, nulo = la plataforma; se borran al anonimizar un tenant); `seo_projects.technical_settings`, `technical_updated_at` y `pagespeed_scheduled_at`; índice `seo_index_findings (project_id, evidence)`. Redesplegar api, worker y web.

- **Variable nueva (opcional)**: `PAGESPEED_API_KEY` en api y worker (ya está en `x-app-env` de `docker-compose.portainer.yml`). Es gratuita: Google Cloud (el mismo proyecto de la cuenta de servicio vale) → APIs y servicios → Biblioteca → activar «PageSpeed Insights API» → Credenciales → Crear credenciales → Clave de API, y restringirla a esa API. Con clave, Google deja unas 25.000 mediciones al día; sin ella funciona, pero con una cuota muy baja y compartida y responde 429 a menudo (las mediciones fallan y se ve en la pantalla). `PAGESPEED_MODE=stub` simula en desarrollo.
- **Search Console**: la inspección usa la misma cuenta de servicio y el mismo ámbito de solo lectura (`webmasters.readonly`): la documentación de la URL Inspection API admite ese ámbito, así que **no hace falta dar permiso completo** a la cuenta en la propiedad; basta el usuario restringido que ya tiene. Comprobar que la API «Google Search Console API» sigue activada en el proyecto (es la misma). Cuota de Google: 2.000 inspecciones al día y 600 al minuto por propiedad; aquí se cuentan por día de la hora del Pacífico, con un tope propio por proyecto (200 en un tenant, 1.000 en la plataforma) editable en la pestaña «Técnico».
- **Crons nuevos** (en el worker, hora de España): `seo.inspection-batch` (06:30; solo los proyectos con el lote activado, apagado por defecto), `seo.inspection-queue` (cada hora, minuto 20: lo que esperaba a que se reiniciara la cuota) y `seo.pagespeed-weekly` (lunes 04:30: la portada, las URL objetivo de prioridad alta y las páginas con más clics, en móvil y ordenador). Jobs nuevos `url-inspections` y `pagespeed` en la cola `seo`.
- **Web**: la página de un proyecto SEO (panel admin y Análisis → SEO Avanzado) pasa a pestañas (Rendimiento · Palabras y diagnóstico · Oportunidades · Competencia · Técnico · Plan · Informes y alertas · Ajustes), con la pestaña en la URL (`?tab=`); los enlaces de avisos y correos con ancla (`#alertas`, `#informes`, `#plan`) abren su pestaña.
- **Qué comprobar tras desplegar**: en trasteros.pro (y en GUÁRDALO desde su panel), pestaña «Técnico» → «Inspeccionar URL» con la portada: debe salir «Indexación confirmada (fecha)» y «Hoy: 1 de 1.000 inspecciones». Si da 403, la cuenta de servicio no está en esa propiedad. Medir la portada en «Velocidad» y comprobar que a los 30 s aparecen las puntuaciones y, si la web tiene visitas, los datos de usuarios reales. Decidir con Jota si se activa el lote diario y su tamaño, y revisar el umbral de la alerta de velocidad (Ajustes de «Alertas»).

## 206. SEO Avanzado, PR 10: rastreador (2026-11-26)

Migración (se aplica sola): `20270320100000_seo_crawler` — tablas `seo_crawls` (cada rastreo; uno vivo por proyecto), `seo_crawl_pages` (cada URL de cada rastreo; se conservan los 10 últimos rastreos de cada proyecto) y `seo_crawl_issues` (incidencias con su ciclo de vida), con su política de filas (`tenant_id` del proyecto, nulo = la plataforma; se borran al anonimizar un tenant); `seo_projects.crawl_settings`. Redesplegar api, worker y web. Sin variables nuevas.

- **Qué es**: un rastreador propio (peticiones HTTP, sin navegador sin cabeza) que recorre la web del proyecto como Google, respetando su robots.txt, y saca las incidencias técnicas en la pestaña «Técnico» → «Rastreo». Agente de usuario: `TrasterOS-SEO-Crawler/1.0 (+https://trasteros.pro/rastreador)`; la página `/rastreador` de la web explica qué es y cómo pararlo (`User-agent: trasteros-seo-crawler` / `Disallow: /`).
- **Seguridad**: solo pide páginas de los dominios del proyecto (con y sin `www`), comprueba la IP al conectar en cada redirección (nada privado, de loopback ni de metadatos), sigue como mucho 5 redirecciones, corta a los 3 MB y a los 15 s por petición, una petición a la vez con pausa (1 s por defecto) y un tope de páginas (500 en un tenant, 2.000 en la plataforma) y de tiempo por rastreo. Si en el servidor hay un cortafuegos de salida, debe dejar salir al worker por 80/443 hacia las webs de los proyectos.
- **Cola y crons nuevos** (en el worker): cola `seo-crawl` (concurrencia 2: dos proyectos a la vez como mucho; sale en Panel admin → Sistema y colas) y cron `seo.crawl-weekly` (cada hora, minuto 5, hora de España): el rastreo semanal de los proyectos que lo tienen activado en ese día y hora. **En la plataforma va encendido por defecto** (lunes a las 03:00); en los tenants, apagado (lo activan en Ajustes del rastreo). Al arrancar el worker, los rastreos que quedaron en cola o a medias vuelven a la cola y siguen donde iban.
- **Rutas excluidas**: en «Rastreo» → «Ajustes», una por línea: `/ruta` deja fuera esa ruta y lo que cuelga de ella, `?parámetro` las URL con ese parámetro y `*texto*` las que lo contienen. Útil para listados con paginación o filtros infinitos.
- **Qué comprobar tras desplegar**: en trasteros.pro, pestaña «Técnico» → «Rastrear ahora»; a los pocos minutos deben salir el resumen (páginas, robots.txt y mapas del sitio leídos) y las incidencias. Revisar que lo bloqueado por robots.txt (el panel, el área de clientes, la firma, el pago) sale como «Bloqueada por robots.txt» y no como pedida, y que «Huérfanas» y «Enlazado interno» tienen sentido. En los registros de Nginx Proxy Manager se ven las peticiones con el agente de usuario. Si el rastreo falla con «robots.txt no responde», comprobar que `https://trasteros.pro/robots.txt` responde 200. Decidir con Jota si se activa el semanal en GUÁRDALO.

## 207. SEO Avanzado, PR 11: asistente y borradores de contenido (2026-11-26)

Migración (se aplica sola): `20270321100000_seo_ai` — tablas `seo_ai_conversations`, `seo_ai_messages`, `seo_ai_actions` (acciones propuestas por el asistente) y `seo_content_briefs` (borradores de contenido), con su política de filas (`tenant_id` del proyecto, nulo = la plataforma; se borran al anonimizar un tenant), y la tabla global `platform_ai_usage_events` (consumo de IA de la plataforma, sin tenant; con su REVOKE). Redesplegar api y web (el worker no cambia de comportamiento, pero se redespliega con el resto). Sin variables nuevas: usa la IA ya configurada en Panel admin → Plataforma → Asistente IA.

- **Qué es**: pestaña «Asistente» en cada proyecto de SEO Avanzado (panel admin y tenant) con un chat que responde con las cifras del proyecto (Search Console, SISTRIX, rastreo, inspecciones, plan…) y su origen y fecha, y los «Borradores de contenido» (briefs) con 3 propuestas de título y descripción. «Preparar contenido» en la ficha de una palabra seguida, de una oportunidad y en cada grupo de palabras (vista por grupo).
- **Coste**: en los tenants va incluido en SEO Avanzado y gasta del límite mensual de consultas de IA del negocio (o su clave propia); se ve aparte en Panel admin → Uso por tenant («Asistente de SEO»). En el panel admin gasta con la clave de la plataforma, sin límite, y aparece como «Uso de la propia plataforma» en Plataforma → Asistente IA.
- **Seguridad**: solo lee; lo que propone (tareas, actuaciones, poner una oportunidad en curso, seguir una palabra) se hace al confirmarlo. El texto de fuera (competencia, páginas rastreadas, mensajes de Google) llega al modelo marcado como dato. Pasar un brief a borrador crea la entrada del blog **sin publicar**.
- **Qué comprobar tras desplegar**: en trasteros.pro, pestaña «Asistente» → «¿Qué páginas han caído este mes?»: debe consultar los datos y citar Search Console con fechas. Preparar un brief desde una palabra seguida y revisar que las propuestas traen su longitud; pasarlo a borrador y comprobar que la entrada del blog de la plataforma queda sin publicar. En GUÁRDALO, lo mismo con el blog del negocio (necesita Web Premium). Revisar el gasto en Plataforma → Asistente IA al cabo de unos días.

## 208. SEO Avanzado, PR 12: Google Analytics y visibilidad en IA (2026-11-26)

Migración (se aplica sola): `20270322100000_seo_ga4_ai_visibility` — `seo_projects.ga4_*` (la propiedad de GA4 del proyecto y su estado) y `ai_visibility_settings` (prompts que se siguen); tablas `seo_ga4_landing_daily` (tráfico orgánico de Google por página de entrada y día), `seo_ai_prompts` y `seo_ai_sources` (visibilidad en buscadores de IA), con su política de filas (se borran al anonimizar un tenant); `seo_ai_visibility.subject_type` (dominio o marca) con su índice único rehecho. Redesplegar api, worker y web. Sin variables nuevas.

- **Google Analytics (Data API)**: usa la misma cuenta de servicio que Search Console y Marketing (`GSC_SERVICE_ACCOUNT_JSON`). En el proyecto de Google Cloud de esa cuenta tiene que estar activada «Google Analytics Data API» (ya lo estaba para Marketing, §35). Para cada propiedad: Google Analytics → Administrar → Gestión del acceso a la propiedad → «+» → añadir el correo de la cuenta de servicio (sale en la pantalla, con un botón para copiarlo) con el rol **Lector**. El **ID numérico de la propiedad** está en Administrar → Detalles de la propiedad → «ID de la propiedad» (solo números; no es el «G-…» del ID de medición de la web, que es lo que va en `platform_website.seo` y en Marca y SEO del tenant).
- **Dónde se conecta**: en la ficha del proyecto → pestaña «Ajustes» → «Google Analytics» (en el panel admin, el rol superadmin y solo en los de la plataforma; en el tenant, quien puede configurar). En un negocio que ya tiene GA4 conectado en Marketing sale «Usar esa conexión»: no hay que poner nada más. La carga inicial (16 meses) va por la cola `seo` y tarda unos minutos.
- **Cron nuevo** (en el worker): `seo.ga4-daily` (07:20, hora de España): descarga los últimos días de los proyectos con GA4 conectado (los de los tenants, solo con SEO Avanzado). Job nuevo `ga4-sync` en la cola `seo`.
- **Visibilidad en IA**: va en la tanda «Visibilidad en IA» de SISTRIX (mensual por defecto, Integraciones → frecuencias) y solo por el MCP; sin cambios de configuración. Revisar en Panel admin → SEO → Integraciones que el MCP sigue conectado. Por proyecto, unas 25–45 consultas al mes (sin créditos por el MCP; cuenta en el tope diario de peticiones del fondo).
- **Qué comprobar tras desplegar**: en trasteros.pro, «Ajustes» → «Google Analytics» → conectar la propiedad de la plataforma; a los pocos minutos, en «Rendimiento», la tabla «Páginas: Google, Analytics y conversiones» debe tener sesiones (si da «no puede leer la propiedad», falta el permiso de Lector). En GUÁRDALO, «Usar esa conexión» si tiene GA4 en Marketing. En «Competencia» → «Visibilidad en IA», sincronizar y comprobar que salen tu dominio, tu marca (pon los términos de marca en el proyecto si faltan) y los competidores, y los prompts en los que sale la competencia y tú no; probar «Preparar contenido» en uno. Revisar con Jota el umbral de la alerta «Dejas de salir en los buscadores de IA» (Alertas → Ajustes).

## 210. SEO Avanzado: arreglos de la revisión (2026-11-26)

Migración (se aplica sola): `20270323100000_seo_review_fixes` — `seo_project_domains.synced_until` y `detail_since` (hasta qué día se ha descargado Search Console con éxito y desde cuándo hay detalle por búsqueda y página; se rellenan con lo que ya había), `seo_sync_runs.updated_at` (detecta las descargas atascadas), `seo_content_briefs.content_edited` y, del proyecto de la plataforma, **se borra lo descargado de Google Analytics y se vuelve a descargar solo** (antes sumaba las webs de los negocios `/s/<negocio>` a `/` y `/precios`). Sin variables nuevas.

- **Search Console**: un dominio secundario externo se rechaza si es el dominio propio verificado, el del correo o el sitio de «SEO local» de otro negocio, o de la plataforma; y la descarga diaria comprueba que el dominio sigue siendo del proyecto (si cambia de dueño, el anterior deja de descargarlo). La descarga guarda hasta qué día llegó por dominio: un dominio nuevo no se compara con huecos, la carga inicial retoma por donde iba, los errores de red y los 403 que no son de permisos se reintentan, y una tanda «Descargando» sin trabajo en la cola vuelve a encolarse.
- **SISTRIX**: las tandas rotan (cada una sigue por lo que lleva más tiempo sin consulta) y enseñan «N de M»; solo se dan por terminadas cuando cubren todo. Antes de pedir por la API se estima el coste y se niega si no cabe en lo autorizado (nunca se asume 0). Una respuesta 401 del MCP renueva el token, una forma de respuesta desconocida es un error visible y no un vacío, y «sin créditos» se distingue de «clave no válida».
- **Rastreador**: todo el parseo de lo que viene de fuera (robots.txt, mapas del sitio, HTML, rutas excluidas) es lineal y acotado; ya no hay expresiones regulares con retroceso. Un rastreo que se reinicia, se retoma o lo bloquea el servidor (401/403/429) lo dice y no resuelve incidencias de páginas que no respondieron.
- **PageSpeed**: cola propia `seo-pagespeed` (en Panel admin → Sistema y colas), tope de 40 mediciones manuales por proyecto y día y el semanal repartido en el tiempo.
- **Informes y alertas**: el informe semanal se calcula hasta el último día con datos (con aviso); el cron del semanal (jueves y viernes) y del mensual (días 5 y 6) reserva el periodo después de enviar y se puede reintentar cada hora; una alerta resuelta a mano no vuelve a avisar hasta pasados 7 días (salvo que suba la gravedad) y los avisos van agrupados por proyecto.
- **Oportunidades y tareas**: una oportunidad hecha vuelve si el problema reaparece tras 60 días de datos; la descartada, solo si su puntuación sube 20 puntos o más (el umbral «reaparece» de los ajustes). El factor de interacción de GA4 ya no resta puntos. La persona responsable o creadora de una tarea la mueve con permiso de lectura; crear, editar, reasignar y borrar siguen con «configuración».
- **Asistente y Google Analytics**: todo texto de fuera (URL, páginas de entrada, mensajes de Google) llega al modelo delimitado; la ruta de entrada del formulario público se sanea al guardarla. Quien solo tiene SEO Avanzado ve su contador de consultas, puede poner su clave de IA (Configuración → Asistente IA) y contratar «IA ampliada». Una propiedad de GA4 no puede ser la de un proyecto de otro negocio ni el ID de medición el de la plataforma.
- **Qué comprobar tras desplegar**: (1) Panel admin → SEO → proyecto de trasteros.pro → «Ajustes» → «Google Analytics»: a los pocos minutos debe volver a tener sesiones (la descarga se rehace sola). (2) En un negocio con SEO Avanzado, pestaña «Asistente»: sale «Este mes: X de Y consultas». (3) Sistema y colas: aparece la cola `seo-pagespeed`. (4) Un dominio externo que sea el dominio propio de otro negocio debe dar «ya lo usa otro proyecto» al añadirlo como secundario.

## 211. SEO Avanzado: mejoras (2026-11-26)

Migración `20270324100000_seo_improvements` (se aplica sola). Variables nuevas, opcionales: `SEO_ADVANCED_UPSELL_MIN_CLICKS` (100: clics mensuales de Google a partir de los que se propone el extra) y `SEO_AUTO_START` (`on`; `off` apaga el primer rastreo automático). Ya están en `.env.example`, `env.schema.ts` y `docker-compose.portainer.yml`.

- **Marca y zonas**: dos indicadores marca / no marca (con `brandTerms` del proyecto; sin términos invita a ponerlos), interruptor en búsquedas y páginas, y municipios por proyecto con filtro «por zona» y la oportunidad «búsqueda de tu zona sin página» (factor opcional, no cambia las puntuaciones existentes).
- **Competencia**: quién sube y baja, comparativa por grupo, evolución de un competidor en una palabra, títulos (se guardan desde ahora) y competidores por directorio (`/valencia/`).
- **Importar CSV de SISTRIX** (palabras de un dominio, resultados de una búsqueda, competidores) como `manual_import`, con vista previa y sin duplicar. La API clásica gana el aviso al 80 % del presupuesto y el botón «Probar la API con una consulta» (solo tras la autorización expresa; guarda la muestra y registra el gasto real).
- **Anotaciones propuestas** desde el registro de actividad (nunca se crean sin confirmar), palabras en lote, páginas que fallan en móvil, comparación con el año anterior e indexación (fuera del mapa del sitio, parejas de idioma).
- **Arranque automático**: al conectar el dominio principal de un tenant sale un primer rastreo, una medición de velocidad y un rastreo mensual.
- **Venta**: regla de oportunidad de `seo_advanced` y descripción del extra sin «Próximamente»; la exportación del tenant incluye proyecto, competidores e importaciones.
- **Qué comprobar tras desplegar**: (1) un tenant con SEO Avanzado ve «Marca / sin marca» en Rendimiento; (2) en Panel admin → SEO → Integraciones, «Probar la API» pide autorización y no gasta nada sin ella; (3) Oportunidades del admin propone el extra a quien supere los clics.
