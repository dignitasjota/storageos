# Observabilidad — Loki + Promtail + Grafana

Stack **autohospedado** de logs agregados, dashboards y alertas. Apagado por
defecto (perfil `observability`); los datos no salen del VPS.

## Componentes

| Servicio   | Imagen                   | Rol                                                             |
| ---------- | ------------------------ | --------------------------------------------------------------- |
| `loki`     | `grafana/loki:3.2.1`     | Almacén de logs (single-binary, filesystem, retención 30d).     |
| `promtail` | `grafana/promtail:3.2.1` | Descubre contenedores por el socket Docker y envía logs a Loki. |
| `grafana`  | `grafana/grafana:11.3.1` | Dashboards + alertas. Datasources Loki + Postgres.              |

## Estructura

```
observability/
├── loki/loki-config.yml                  # config Loki
├── promtail/promtail-config.yml          # scrape docker + parse pino/CSP
└── grafana/
    ├── provisioning/
    │   ├── datasources/datasources.yml   # Loki + Postgres
    │   ├── dashboards/dashboards.yml      # provider de dashboards
    │   └── alerting/
    │       ├── contactpoints.yml          # email (GF_ALERT_EMAIL)
    │       ├── policies.yml               # política de notificación
    │       └── rules.yml                   # reglas: pico CSP + pico errores
    └── dashboards/storageos-overview.json  # dashboard principal
```

## Activar

```bash
# Compose directo:
docker compose -f docker-compose.prod.yml --profile observability up -d

# Portainer (stack Repository): añade en Environment del stack
#   COMPOSE_PROFILES=observability
# y vuelve a desplegar.
```

Expón Grafana (`grafana:3000`) con un Proxy Host propio en NPM
(`grafana.tu-dominio.com`). No publiques Loki ni Promtail.

## Variables (Portainer / `.env.prod`)

| Variable               | Obligatoria | Descripción                                           |
| ---------------------- | ----------- | ----------------------------------------------------- |
| `GF_ADMIN_PASSWORD`    | sí          | Password del admin de Grafana (usuario `admin`).      |
| `GF_SERVER_ROOT_URL`   | recomendada | URL pública de Grafana (enlaces correctos en emails). |
| `GF_ALERT_EMAIL`       | recomendada | Destino de las alertas. Cae a `SECURITY_ALERT_EMAIL`. |
| `GF_SMTP_ENABLED`      | para email  | `true` para que Grafana envíe los emails de alerta.   |
| `GF_SMTP_HOST`         | para email  | `smtp.host:587` (Resend, Brevo, etc.).                |
| `GF_SMTP_USER`         | para email  | Usuario SMTP.                                         |
| `GF_SMTP_PASSWORD`     | para email  | Password / API key SMTP.                              |
| `GF_SMTP_FROM_ADDRESS` | para email  | Remitente de las alertas.                             |

El datasource Postgres reutiliza `POSTGRES_USER` / `POSTGRES_PASSWORD` /
`POSTGRES_DB` (solo lectura; los paneles solo ejecutan `SELECT`).

## Dashboard

**StorageOS — Overview**: volumen de logs por servicio, errores API/worker
(24h), violaciones CSP (24h), intentos de login fallidos (desde
`security_events`), top emails/IP con login fallido, y paneles de logs de
errores + violaciones CSP recientes.

## Alertas

- **Pico de violaciones CSP** — > 50 en 5 min (posible inyección o CSP roto).
- **Pico de errores API/worker** — > 20 logs de error en 5 min.

> El brute-force de login ya tiene su propia alerta por email vía
> `SecurityAlertsService` (cron `*/5 * * * *`); el dashboard de Grafana añade
> visibilidad histórica, no la sustituye.
