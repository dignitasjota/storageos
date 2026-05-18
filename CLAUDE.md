# CLAUDE.md

Este archivo proporciona contexto persistente a Claude Code para este proyecto. Léelo siempre al inicio de cada sesión.

## Resumen del proyecto

**Nombre:** StorageOS (provisional)
**Tipo:** SaaS multi-tenant para la gestión integral de locales de self-storage.
**Cliente objetivo:** empresas propietarias de uno o varios locales de trasteros que necesitan gestionar trasteros, contratos, inquilinos, facturación, accesos y operativa diaria.

### Jerarquía de usuarios
1. **Super Admin** (nosotros): gestiona la plataforma y los tenants.
2. **Tenant** (empresa cliente): tiene N facilities (locales físicos) y varios usuarios internos con roles (owner, manager, staff, readonly).
3. **Customer** (inquilino final): alquila trasteros; opcionalmente tiene acceso a un portal propio.

## Stack tecnológico

### Backend
- **Node.js 20 LTS + NestJS** (TypeScript estricto)
- **Prisma ORM** sobre PostgreSQL 16
- **Redis** para caché, sesiones y colas
- **BullMQ** para tareas en background (facturación recurrente, emails, generación de PDFs)
- **Zod / class-validator** para validación
- **Passport + JWT** (access + refresh tokens) para autenticación, con 2FA TOTP

### Frontend
- **Next.js 15 (App Router) + React 19 + TypeScript**
- **Tailwind CSS + shadcn/ui**
- **TanStack Query** para data fetching y caché
- **Zustand** para estado global ligero
- **react-konva** para el editor visual de planos
- **Recharts** para dashboards
- **react-hook-form + Zod** para formularios

### Infraestructura
- **Docker + docker-compose** para todos los servicios
- **Despliegue**: VPS con Portainer y Nginx Proxy Manager (SSL vía Let's Encrypt)
- **Almacenamiento de archivos**: MinIO (S3-compatible, autohospedado)
- **Email transaccional**: Resend o Brevo (NO autohospedar SMTP)
- **Pagos**: Stripe (tarjeta) + GoCardless (SEPA); preparar abstracción para añadir Redsys
- **Observabilidad**: Sentry (errores), Uptime Kuma (uptime), Loki + Grafana o Better Stack (logs)

### Estructura del repositorio (monorepo)
Usamos **pnpm workspaces + Turborepo**:

```
storage-saas/
├── apps/
│   ├── api/           # Backend NestJS
│   ├── web/           # Frontend Next.js (panel del tenant)
│   ├── portal/        # Portal del inquilino final (puede empezar como ruta en web/)
│   └── admin/         # Panel super admin (puede empezar como ruta en web/)
├── packages/
│   ├── database/      # Prisma schema + cliente generado + migraciones
│   ├── shared/        # Tipos compartidos, DTOs, utilidades
│   ├── ui/            # Componentes UI compartidos (shadcn/ui)
│   └── config/        # ESLint, TypeScript, Tailwind configs compartidas
├── docker/            # Dockerfiles y docker-compose.yml
├── docs/              # Documentación adicional (ARCHITECTURE.md, DATA_MODEL.md, etc.)
├── CLAUDE.md          # Este archivo
├── README.md
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## Multi-tenancy

- Estrategia: **shared database, shared schema con `tenant_id`** en todas las tablas.
- Refuerzo de aislamiento: **Row-Level Security (RLS) de PostgreSQL**.
- En el backend, todo request autenticado debe inyectar `tenant_id` en el contexto vía un guard/middleware. Las consultas Prisma DEBEN filtrar siempre por `tenant_id` (usar una extensión Prisma o un repositorio base).
- NUNCA exponer endpoints que devuelvan datos sin filtrar por tenant.

## Convenciones de código

- **TypeScript estricto** (`strict: true`, `noUncheckedIndexedAccess: true`).
- Imports absolutos con alias (`@/`, `@api/`, `@shared/`).
- Naming:
  - Tablas y columnas en **snake_case** (Postgres).
  - Modelos Prisma y propiedades TypeScript en **camelCase** (Prisma hace el mapping con `@map`).
  - Componentes React en **PascalCase**.
  - Hooks en **camelCase** con prefijo `use`.
- DTOs separados por capa: `CreateXxxDto`, `UpdateXxxDto`, `XxxResponseDto`.
- Validación con Zod en el frontend, class-validator en el backend (compartir esquemas vía `packages/shared` cuando tenga sentido).
- Errores: usar excepciones de NestJS (`BadRequestException`, etc.) con mensajes traducibles.
- Tests: Jest para unit, Supertest para e2e backend, Playwright para e2e frontend.
- Commits: **Conventional Commits** (`feat:`, `fix:`, `chore:`, `refactor:`...).
- Branches: trabajamos sobre `main` hasta tener un entorno de staging. Cuando lo montemos, se creará `develop`. Para cambios sustanciales se usan ramas `feat/...` o `fix/...`.

## Seguridad

- 2FA obligatorio para usuarios con rol `owner` y `manager`.
- Hash de passwords con argon2id.
- Tokens JWT de corta vida (15 min) + refresh tokens en cookies httpOnly + secure + sameSite=strict.
- Rate limiting en endpoints sensibles (login, reset password, pagos).
- CSP estricta en frontend.
- Sanitización de inputs de texto enriquecido.
- Logs de auditoría (`audit_logs`) para toda acción crítica: creación/modificación de contratos, pagos, cambios de precio, accesos administrativos.
- RGPD: exportación y borrado de datos del inquilino bajo demanda.

## Internacionalización

- Locale por defecto: `es-ES` (España, euros, IVA 21%).
- Preparar i18n desde el inicio con `next-intl` y formato de fechas/monedas según el locale del tenant.
- Fechas siempre almacenadas en UTC, mostradas en la timezone del facility correspondiente.

## Documentación que debes leer y mantener actualizada

- `docs/ARCHITECTURE.md` — decisiones de arquitectura.
- `docs/DATA_MODEL.md` — modelo de datos completo.
- `docs/ROADMAP.md` — fases del proyecto y MVP.
- `docs/API.md` — convenciones de la API REST.
- `docs/DEPLOYMENT.md` — cómo desplegar en el VPS.

## Cómo trabajar conmigo (el desarrollador)

1. **Antes de escribir código nuevo**, comprueba si ya existe algo similar; reutiliza.
2. **Antes de cambios grandes**, propón un plan y espera mi confirmación.
3. **Después de cada feature**, actualiza la documentación relevante.
4. **Tests**: añade tests para lógica de negocio crítica (facturación, pricing, control de accesos, multi-tenancy).
5. **Migraciones Prisma**: nunca edites una migración ya aplicada; crea una nueva.
6. **Variables de entorno**: documenta cada nueva variable en `.env.example`.
7. **Idioma**: responde y comenta en **español**, código y nombres de variables en **inglés**.

## Estado actual

Proyecto recién iniciado. Próximos pasos definidos en `docs/ROADMAP.md`.
