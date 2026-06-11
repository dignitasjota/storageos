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

`chmod 600` obligatorio. Plantilla mínima:

```dotenv
# ---------- Releases ----------
RELEASE_TAG=v0.4.0

# ---------- Dominios ----------
WEB_BASE_URL=https://app.tu-dominio.com
NEXT_PUBLIC_API_URL=https://api.tu-dominio.com
ALLOWED_ORIGINS=https://app.tu-dominio.com

# ---------- Postgres ----------
POSTGRES_USER=storageos
POSTGRES_PASSWORD=<openssl-1>
POSTGRES_DB=storageos
POSTGRES_APP_USER=storageos_app
POSTGRES_APP_PASSWORD=<openssl-2>
# Las DATABASE_URL definitivas las construye docker-compose.prod.yml,
# pero las dejamos aqui por si necesitas conectarte desde un cliente.
DATABASE_URL=postgresql://storageos_app:<openssl-2>@postgres:5432/storageos?schema=public
DATABASE_ADMIN_URL=postgresql://storageos:<openssl-1>@postgres:5432/storageos?schema=public

# ---------- Redis ----------
REDIS_PASSWORD=<openssl-3>
REDIS_DB=0

# ---------- MinIO ----------
MINIO_ROOT_USER=storageos
MINIO_ROOT_PASSWORD=<openssl-4>
MINIO_ACCESS_KEY=storageos
MINIO_SECRET_KEY=<openssl-4>
MINIO_BUCKET_UPLOADS=storageos-uploads
MINIO_BUCKET_INVOICES=storageos-invoices
MINIO_BUCKET_PLANS=storageos-plans
MINIO_BUCKET_REPORTS=storageos-reports
MINIO_PUBLIC_URL=https://files.tu-dominio.com
MINIO_USE_SSL=true

# ---------- JWT ----------
JWT_ACCESS_SECRET=<openssl-jwt-1>
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_SECONDS=604800
JWT_2FA_PENDING_SECRET=<openssl-jwt-2>
JWT_2FA_PENDING_TTL_SECONDS=300
SUPER_ADMIN_JWT_SECRET=<openssl-jwt-3>
SUPER_ADMIN_JWT_TTL_SECONDS=28800
IMPERSONATION_TTL_SECONDS=3600

# ---------- Cifrado simétrico AES-256-GCM ----------
MASTER_ENCRYPTION_KEY=<openssl-base64-32-bytes>

# ---------- Cookies ----------
COOKIE_DOMAIN=.tu-dominio.com
COOKIE_SECURE=true
COOKIE_SAMESITE=lax

# ---------- Stripe ----------
STRIPE_SECRET_KEY=sk_live_xxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxx

# ---------- Verifactu ----------
AEAT_MODE=sandbox          # sandbox para piloto, production cuando esté listo
AEAT_TENANT_TAX_ID=B12345678

# ---------- Email (Resend) ----------
EMAIL_PROVIDER=resend
EMAIL_FROM_NAME=StorageOS
EMAIL_FROM_ADDRESS=no-reply@tu-dominio.com
RESEND_API_KEY=re_xxxxxxxx

# ---------- WhatsApp (Fase 5 stub hasta WABA) ----------
WHATSAPP_PROVIDER=stub

# ---------- Locks (Fase 7 stub) ----------
LOCK_PROVIDER=stub

# ---------- Logger ----------
LOG_LEVEL=info
LOG_PRETTY=false

# ---------- Backups ----------
BACKUP_GPG_PASSPHRASE=<openssl-backup>
BACKUP_LOCAL_DIR=/opt/storageos/backups
BACKUP_RETENTION_DAYS=30
B2_BUCKET=storageos-backups
B2_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
B2_REGION=eu-central-003
B2_ACCESS_KEY_ID=<keyID>
B2_SECRET_ACCESS_KEY=<applicationKey>
```

```bash
chmod 600 /opt/storageos/.env.prod
chown deploy:deploy /opt/storageos/.env.prod
```

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

# 6.8 Crear los buckets MinIO
docker compose -f docker-compose.prod.yml --env-file .env.prod exec minio \
  /bin/sh -c "
    mc alias set local http://localhost:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD &&
    mc mb --ignore-existing local/storageos-uploads &&
    mc mb --ignore-existing local/storageos-invoices &&
    mc mb --ignore-existing local/storageos-plans &&
    mc mb --ignore-existing local/storageos-reports
  "

# 6.9 Levantar api + web
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d api web

# 6.10 Comprobar logs
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api web
```

---

## 7. Tenant inicial y super admin

El registro público crea un tenant + owner, pero el primer super admin se inyecta manualmente. Hasta tener un script dedicado en Fase 8D:

```bash
# Crear super admin desde psql (el seed lo hará automáticamente si lo invocas con
# SEED_SUPERADMIN_EMAIL/PASSWORD definidos en .env.prod en Fase 8D).
docker compose -f docker-compose.prod.yml --env-file .env.prod exec api \
  node -e "
    const argon2 = require('@node-rs/argon2');
    const { PrismaClient } = require('@prisma/client');
    (async () => {
      const prisma = new PrismaClient();
      const hash = await argon2.hash('CAMBIAR_INMEDIATAMENTE', { algorithm: argon2.Algorithm.Argon2id });
      await prisma.superAdmin.upsert({
        where: { email: 'tu@correo.com' },
        update: { passwordHash: hash },
        create: { email: 'tu@correo.com', passwordHash: hash, name: 'Owner' },
      });
      console.log('Super admin OK');
    })();
  "
```

Luego entrar en `https://app.tu-dominio.com/super-admin/login`, cambiar la contraseña y activar 2FA.

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

---

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
EMAIL_FROM_NAME=StorageOS
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

# Identificación del Sistema Informático (StorageOS) — comunes a todos los tenants
AEAT_SISTEMA_NIF=B12345678         # NIF del desarrollador/operador del software
AEAT_SISTEMA_NOMBRE=StorageOS
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
- **Versión del sistema informático**: si actualizas StorageOS a una versión que altera el comportamiento del registro (campos, hash, formato XML), incrementa `AEAT_SISTEMA_VERSION` para que el campo declarado en el XML refleje la versión real desplegada.
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
   # Debes ver: "StorageOS worker started"
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

---

## 13. Observabilidad (mínima)

- **Sentry**: definir `SENTRY_DSN` en `.env.prod` (misma variable para `api` y `worker`; ambos la leen en su `instrument.ts`). Sin DSN, Sentry es un no-op. El API reporta los errores 5xx desde `HttpExceptionFilter`; el worker captura unhandled rejections/exceptions. Opcional: `SENTRY_TRACES_SAMPLE_RATE` (default `0`, solo errores).
- **Uptime Kuma**: contenedor adicional monitoreando `https://app.tu-dominio.com` y `https://api.tu-dominio.com/health/ready`. Usar `/health/ready` (no `/health`): comprueba Postgres + Redis de verdad y devuelve 503 con `details: { database, redis }` si alguna dependencia está caída. `/health` es solo liveness (el proceso responde HTTP).
- **Logs**: `docker compose ... logs -f api` para inspección puntual. En Fase 8D se añade Loki + Grafana.

---

## 14. Pendiente (Fase 8D)

- Pipeline CI/CD con GitHub Actions construyendo imágenes a GHCR y desplegando vía SSH.
- Staging dedicado (`develop` branch → `staging.tu-dominio.com`).
- Loki + Grafana para logs agregados.
- Política formal de rotación de secretos cada 90 días.
- Runbook de recuperación ante desastre (RTO/RPO documentados).
