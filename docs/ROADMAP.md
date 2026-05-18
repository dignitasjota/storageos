# ROADMAP

Plan de desarrollo por fases. El objetivo es llegar a un MVP funcional con el menor scope posible, y luego iterar.

## Fase 0 — Setup (1-2 días)

- [ ] Inicializar monorepo con pnpm workspaces + Turborepo
- [ ] Configurar TypeScript estricto, ESLint, Prettier, Husky + lint-staged
- [ ] Esqueleto NestJS en `apps/api`
- [ ] Esqueleto Next.js 15 en `apps/web` con Tailwind + shadcn/ui
- [ ] Paquete `packages/database` con Prisma inicializado
- [ ] `docker-compose.yml` para desarrollo: postgres, redis, minio, mailhog
- [ ] `docker-compose.prod.yml` para producción
- [ ] `.env.example` documentado
- [ ] README con instrucciones de instalación y arranque
- [ ] CI básico (GitHub Actions): lint + typecheck + tests

## Fase 1 — Fundamentos multi-tenant (MVP core, 1-2 semanas)

### Backend
- [ ] Schema Prisma inicial: `tenants`, `users`, `subscription_plans`, `tenant_subscriptions`
- [ ] Auth completo: registro de tenant, login, refresh tokens, recuperación de password, 2FA TOTP
- [ ] Guard `TenantContext` que inyecta `tenant_id` en cada request
- [ ] Row-Level Security policies en Postgres
- [ ] Módulo de gestión de usuarios del tenant (CRUD, invitaciones, roles)
- [ ] Logs de auditoría base

### Frontend
- [ ] Páginas públicas: landing mínima, registro, login, recuperación de password
- [ ] Layout de panel autenticado con sidebar y switcher de facility
- [ ] Páginas de configuración del tenant: perfil de empresa, usuarios, planes
- [ ] Componentes UI base: tabla, formulario, modal, toast, loading states

## Fase 2 — Locales, trasteros y plano (1-2 semanas)

- [ ] Schema: `facilities`, `facility_floors`, `unit_types`, `units`, `unit_status_history`
- [ ] API CRUD para facilities, unit_types, units
- [ ] Frontend: gestión de facilities
- [ ] Frontend: gestión de unit_types con colores
- [ ] **Editor visual de planos** con react-konva:
  - Cargar imagen de plano de fondo (subida a MinIO)
  - Crear/editar trasteros como rectángulos sobre el plano
  - Snap a grid, edición de medidas
  - Asignar unit_type, código, precio base
  - Vista de estados con código de colores en tiempo real
- [ ] Vista de listado de trasteros con filtros (estado, tipo, precio)
- [ ] Dashboard de ocupación: % por facility, por tipo

## Fase 3 — Inquilinos, contratos y reservas (2 semanas)

- [ ] Schema: `customers`, `customer_documents`, `contracts`, `contract_events`, `reservations`
- [ ] CRUD de inquilinos con documentos (subida de DNI/CIF a MinIO)
- [ ] CRUD de contratos:
  - Asignación cliente ↔ trastero
  - Cálculo de precio con tarifas y descuentos
  - Generación de PDF con plantilla (Puppeteer)
  - Estados del contrato y transiciones permitidas
  - Sincronización automática del estado de `units`
- [ ] Reservas con bloqueo temporal del trastero
- [ ] Vista de timeline del contrato (eventos)

## Fase 4 — Facturación y pagos (2-3 semanas)

- [ ] Schema: `invoices`, `invoice_items`, `payments`, `payment_methods`, `dunning_actions`, `pricing_rules`, `promotions`
- [ ] Integración Stripe: tarjeta + Stripe SEPA
- [ ] Integración GoCardless (opcional en MVP)
- [ ] Job recurrente con BullMQ para generar facturas mensuales
- [ ] Generación de PDFs de facturas
- [ ] Gestión de impagos: reintentos, recargos, escalado
- [ ] Conformidad Verifactu (España) — investigar requisitos exactos según fecha de lanzamiento
- [ ] Portal de facturas para inquilino (descarga + pago online)
- [ ] Exportación contable (CSV)

## Fase 5 — Comunicaciones y CRM básico (1-2 semanas)

- [ ] Schema: `leads`, `communications`, `message_templates`, `automation_rules`
- [ ] Integración con Resend para emails transaccionales
- [ ] Plantillas con variables: bienvenida, recordatorio de pago, aviso de impago, fin de contrato
- [ ] Pipeline de leads con kanban
- [ ] Widget de reserva embebible para la web del cliente

## Fase 6 — Operativa y reporting (1 semana)

- [ ] Schema: `tasks`, `incidents`, `products`, `product_sales`
- [ ] Gestión de tareas e incidencias
- [ ] Venta de productos accesorios
- [ ] Dashboard analítico con KPIs: ocupación física vs económica, MRR, churn, morosidad
- [ ] Informes exportables a Excel/PDF

## Fase 7 — Control de accesos físicos (variable)

Dependiente del hardware que se quiera soportar.
- [ ] Schema: `access_credentials`, `access_logs`, `access_devices`
- [ ] Generación de PINs/QRs
- [ ] Bloqueo automático por impago
- [ ] Integración inicial con un proveedor de cerraduras (a elegir)

## Fase 8 — Super Admin y facturación SaaS (1 semana)

- [ ] Panel super admin: listado de tenants, métricas globales, soporte
- [ ] Stripe Billing para facturación de los tenants
- [ ] Onboarding de nuevo tenant con trial

## Backlog / Post-MVP

- App móvil (React Native o PWA)
- WhatsApp Business API
- Marketplace público de trasteros
- API pública + webhooks
- IA: predicción de churn, recomendación de precios
- Multi-idioma completo
- Firma biométrica en tablet
- Integración con software contable español (Holded, A3)

## Criterio de "MVP listo para vender"

Fases 0 a 4 completas + un subset esencial de la 5 (al menos email transaccional y recordatorios de pago) + Fase 8 mínima para poder cobrar suscripciones.
