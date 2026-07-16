# apps/web

Frontend Next.js 15 (App Router) + React 19 de TrasterOS. Aloja el panel del
tenant, el panel de super admin y el widget público hasta que el alcance
justifique separarlos en apps dedicadas.

## Scripts

```bash
pnpm -F web dev          # Next dev server en :3000
pnpm -F web build        # Build de producción
pnpm -F web start        # Servir build de producción
pnpm -F web lint         # ESLint (warnings = error)
pnpm -F web typecheck    # tsc --noEmit
pnpm -F web test:e2e     # Smoke tests Playwright (ver abajo)
```

## E2E con Playwright

Tenemos 5 smoke tests Playwright en `e2e/` que cubren los flujos críticos
antes del primer cliente. Son **smoke tests**, no exhaustivos: verifican
"esto sigue arrancando y conectando con la API" más que cada caso límite.

### Escenarios

1. `01-tenant-onboarding.spec.ts` — registro + verificación email + 2FA.
2. `02-billing-flow.spec.ts` — login + crear customer + ver factura emitida + VerifactuBadge.
3. `03-rectify-invoice.spec.ts` — emitir una factura rectificativa R1.
4. `04-admin-2fa-impersonate.spec.ts` — super admin login + impersonar tenant.
5. `05-public-widget.spec.ts` — widget público sin auth + envío de lead.

### Prerrequisitos

Antes de ejecutar:

1. **Docker compose levantado** con Postgres, Redis, MinIO, Mailpit:

   ```bash
   docker compose up -d
   ```

2. **Migraciones + seed** aplicados:

   ```bash
   pnpm --filter @storageos/database migrate:dev
   pnpm db:seed
   ```

3. **API corriendo** en `:3001`:

   ```bash
   pnpm --filter api start:dev
   ```

4. **Web corriendo** en `:3000` (en otra terminal):

   ```bash
   pnpm -F web dev
   ```

5. **Navegadores Playwright instalados** (solo la primera vez):

   ```bash
   pnpm -F web test:e2e:install
   ```

   En macOS local con `playwright install chromium` basta; el `--with-deps`
   sólo lo necesitas en Linux/CI.

### Ejecutar

```bash
pnpm -F web test:e2e            # headless, todos los escenarios
pnpm -F web test:e2e:ui         # modo UI interactivo, ideal para depurar
pnpm -F web test:e2e -- 01      # filtrar por nombre de archivo
```

El reporter HTML queda en `apps/web/playwright-report/`. Para abrirlo:

```bash
pnpm -F web exec playwright show-report
```

### Test 04: super admin con 2FA

El escenario 4 requiere un super admin precreado. El seed por defecto **no**
lo crea con 2FA activo; usa estas envs si quieres habilitarlo:

| Variable                | Default                 | Notas                           |
| ----------------------- | ----------------------- | ------------------------------- |
| `E2E_ADMIN_EMAIL`       | `admin@storageos.local` | Email del super admin a usar    |
| `E2E_ADMIN_PASSWORD`    | `Admin69!`              | Password del super admin        |
| `E2E_ADMIN_TOTP_SECRET` | _(vacío)_               | Si lo defines, el test hace 2FA |

Para preparar el super admin:

```bash
pnpm --filter @storageos/database seed:superadmin -- \
  --email admin@storageos.local --password 'Admin69!' --name 'Admin E2E'
```

Para activar 2FA sobre ese admin desde la UI: log in en `/admin/login`,
navega al panel de seguridad y captura el secret antes de verificar para
poder pasarlo como `E2E_ADMIN_TOTP_SECRET`.

### Variables de entorno

| Variable              | Default                        |
| --------------------- | ------------------------------ |
| `PLAYWRIGHT_BASE_URL` | `http://localhost:3000`        |
| `PLAYWRIGHT_API_URL`  | `http://localhost:3001`        |
| `MAILPIT_API_URL`     | `http://localhost:8026/api/v1` |

### CI

CI activo: ver `.github/workflows/e2e.yml`. Failures **NO** bloquean merge
(workflow separado del CI principal `.github/workflows/ci.yml`). Los
developers verán el aviso en el PR pero pueden mergear igualmente si el
fallo es por flakiness conocida; corregir cuanto antes.

El workflow levanta sus propios `services:` (Postgres + Redis + Mailpit),
aplica migraciones, seedea datos demo, compila API + web y lanza ambos
procesos antes de ejecutar `pnpm -F web test:e2e`. El reporter HTML queda
subido como artifact `playwright-report` (retention 7 días).

Si en el futuro se quiere bloquear merges con Playwright, basta con marcar
el job como required en la branch protection de `main`.
