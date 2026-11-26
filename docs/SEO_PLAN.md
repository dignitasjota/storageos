# Sistema propio de análisis y seguimiento SEO — plan técnico

> Estado: **propuesta pendiente de aprobación** (2026-11-25). No hay nada desarrollado de este plan.
> Alcance: auditoría del código actual + plan por fases. Sin migraciones, sin contrataciones y sin consultas de pago hasta que se apruebe.
>
> ⚠️ **Corrección de alcance (§20)**: el sistema tiene **dos ámbitos**. El SEO de `trasteros.pro` va en el panel del super admin; el SEO de cada tenant (GUÁRDALO es uno de ellos) va en el panel del tenant como **extra de pago aparte**. Donde las secciones 0 a 19 digan «módulo del super admin independiente de los tenants» o «el SEO de los tenants no se toca», manda la §20.

## 0. Resumen

- **Ya existe medio sistema**: Search Console por tenant (cliente, descarga diaria, histórico de 16 meses, palabras seguidas, informe mensual, aviso de caídas), GA4, revisión de SEO on-page, páginas de zona con IA, asistente de IA con herramientas, colas, tareas programadas vigiladas, avisos, informes en Excel/PDF y cifrado de credenciales. **No hay nada de SISTRIX**, ni rastreador, ni gestor de palabras clave con competencia, ni proyectos multidominio.
- **Lo existente está atado al tenant** (`tenant_id` obligatorio, un solo dominio por tenant, función de pago `local_seo`). Tus tres dominios no encajan ahí: `trasteros.pro` es la plataforma, no un tenant.
- **Propuesta**: un módulo nuevo **«SEO» en el panel del super admin**, con proyectos independientes de los tenants, que **reutiliza el cliente de Search Console, la cuenta de servicio de Google, la IA, las colas, los avisos y los informes**, y añade un proveedor de SISTRIX con control de créditos. No se toca el SEO de los tenants.
- **Primera versión útil (fases 1 y 2)**: proyectos, Search Console con histórico, SISTRIX básico con presupuesto, panel, palabras clave, competencia y oportunidades. Estimación: **6–7 PR**.
- **Crítica principal a la propuesta**: es demasiado grande para arrancar de una vez, y hay tres puntos donde propongo algo más sencillo (OAuth, calendario de contenidos, rastreador). Y un aviso: el índice de visibilidad de SISTRIX será casi cero para dominios tan pequeños y locales; el dato fiable para ti es Search Console.

## 1. Inventario de lo que existe hoy

| Pieza                                                                     | Dónde                                                                                                                                                                                  | Estado real                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cliente de Search Console (cuenta de servicio, JWT sin SDK, solo lectura) | `apps/api/src/modules/search-console/search-console.client.ts`, `apps/api/src/common/google/google-service-account.ts`                                                                 | Funciona. Descarga por `date+query+page`, totales por día y por dispositivo. Tope de 25.000 filas **por rango** (no por día). Sin país, sin tipo de búsqueda, sin sitemaps ni inspección de URL. |
| Descarga y almacenamiento                                                 | `search-console.service.ts`, tablas `tenant_search_console`, `search_console_rows`, `search_console_days`, `search_console_devices`                                                    | Funciona: 190 días al conectar, 6 días cada día (reescribe los recientes), conserva 480 días. Upsert idempotente. Una propiedad por tenant.                                                      |
| Palabras seguidas                                                         | tabla `seo_tracked_keywords`, `GET/POST /seo/keywords`                                                                                                                                 | Básico: palabra + posición objetivo, con datos de Search Console. Sin volumen, competencia, URL objetivo ni estados.                                                                             |
| Posiciones, detalle, embudo Google → reservas                             | `GET /seo/positions`, `/seo/detail`, `/seo/google-funnel`; web `apps/web/src/app/(app)/seo/`                                                                                           | Funciona, para el tenant.                                                                                                                                                                        |
| Informe mensual y aviso de caídas                                         | `seo-report.service.ts`, crons `search-console.daily` (06:30) y `seo-report.monthly` (día 3)                                                                                           | Funciona. Correo a propietarios; un aviso de caída por semana como mucho.                                                                                                                        |
| Cálculos compartidos                                                      | `packages/shared/src/web/search-console.ts` (`summarizeSearchConsole`, `summarizeRange`, `expectedCtr`, `isBrandQuery`, `seoReportTips`) con vitest                                    | Reutilizable tal cual: CTR = clics/impresiones, posición ponderada, CTR esperado por posición, marca/no marca.                                                                                   |
| GA4                                                                       | `apps/api/src/modules/marketing/ga4/`, tablas `tenant_ga4`, `ga4_source_rows`, `ga4_page_rows`                                                                                         | Funciona, por tenant (Web Premium).                                                                                                                                                              |
| Revisión de SEO on-page                                                   | `AnalyticsService.getSeoChecklist` (`analytics.service.ts:814`), `GET /analytics/seo-checklist`                                                                                        | Solo comprueba la configuración de la web del tenant (títulos, descripciones, fotos…). No rastrea nada.                                                                                          |
| SEO de trasteros.pro                                                      | `platform_website.seo` (título, descripción, verificación de Google/Bing, GA4), `apps/web/src/app/admin/website/seo-card.tsx`                                                          | Solo ajustes. Sin datos de rendimiento.                                                                                                                                                          |
| Contenido                                                                 | blog del tenant (`blog_posts`), blog de la plataforma (`platform_blog_posts`, `/admin/blog`), páginas de zona (`web_area_pages`), landings de promoción                                | Funcionan. Sirven como destino del calendario de contenidos.                                                                                                                                     |
| Competencia                                                               | `competitor_facilities`, `competitor_units` (`/competitors`)                                                                                                                           | Es competencia de **precios**, no de SEO. No reutilizable.                                                                                                                                       |
| IA                                                                        | `apps/api/src/modules/ai/` (`AiProvider`, Anthropic por `fetch`, herramientas de solo lectura, cuotas, clave en panel admin)                                                           | Reutilizable: mismo proveedor y patrón de herramientas.                                                                                                                                          |
| Colas y tareas programadas                                                | BullMQ (`queues/queue-names.ts`), worker `apps/worker`, `cron-monitor`, `common/cron-claim.ts`                                                                                         | Reutilizable. Habría que añadir una cola `seo`.                                                                                                                                                  |
| Avisos                                                                    | `super_admin_notifications`, `admin/alert-state.ts` (`claimAlert`), push del super admin, Telegram/Slack (`chat-alerts.service.ts`), correo de alertas                                 | Reutilizable tal cual.                                                                                                                                                                           |
| Informes y exportación                                                    | `exceljs`, `common/puppeteer.ts` (`loadPuppeteer`), `lib/csv.ts`, resumen semanal del admin                                                                                            | Reutilizable.                                                                                                                                                                                    |
| Seguridad                                                                 | `CryptoService` (AES-256-GCM), `common/security/safe-http-post.ts`, `safe-outbound-url.ts`, `packages/shared/src/security/ssrf.ts`, `AdminGuard` con 2FA y roles, registro de acciones | Reutilizable.                                                                                                                                                                                    |
| SISTRIX u otro proveedor SEO                                              | —                                                                                                                                                                                      | **No existe.**                                                                                                                                                                                   |
| Rastreador / auditoría técnica                                            | —                                                                                                                                                                                      | **No existe.**                                                                                                                                                                                   |
| Seguimiento de posiciones geolocalizado                                   | —                                                                                                                                                                                      | **No existe.**                                                                                                                                                                                   |

## 2. Qué se reutiliza, qué se adapta y qué falta

| Funcionalidad pedida                                  | Clasificación                                               | Nota                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Cliente de Search Console y autenticación             | Existente, necesita adaptación                              | Añadir país, tipo de búsqueda, sitemaps, lista de propiedades e inspección de URL; paginar por día en la carga inicial. |
| Cálculos de CTR, posición ponderada, marca            | Existente y reutilizable                                    | `packages/shared/src/web/search-console.ts`.                                                                            |
| Almacenamiento de Search Console                      | Desarrollo nuevo (mismo diseño)                             | Tablas propias por proyecto; las del tenant no sirven (`tenant_id` obligatorio, un dominio).                            |
| Gestión multidominio y proyectos                      | Desarrollo nuevo                                            |                                                                                                                         |
| Proveedor de SISTRIX y control de créditos            | Desarrollo nuevo                                            |                                                                                                                         |
| Panel general y comparativas por periodo              | Desarrollo nuevo, con componentes existentes                | Recharts, `PeriodSelector`, `Delta`, `CsvButton`.                                                                       |
| Gestor de palabras clave                              | Desarrollo nuevo                                            | Sustituye a `seo_tracked_keywords` solo para tus proyectos; el del tenant queda igual.                                  |
| Competencia y keyword gap                             | Desarrollo nuevo                                            |                                                                                                                         |
| Motor de oportunidades                                | Desarrollo nuevo, reutiliza `expectedCtr` y `seoReportTips` |                                                                                                                         |
| Mapeo palabra clave ↔ URL                             | Desarrollo nuevo, simplificado                              | Campo «URL objetivo» en la palabra + tabla de páginas derivada de Search Console y sitemap.                             |
| Tareas SEO                                            | Desarrollo nuevo, patrón existente                          | Tablero como el de leads del admin.                                                                                     |
| Calendario de contenidos                              | Pospuesto, fusionado con tareas                             | Una tarea de tipo «contenido» con fecha ya da el calendario.                                                            |
| Alertas                                               | Existente y reutilizable                                    | `claimAlert` + notificaciones + chat + correo.                                                                          |
| Informes semanal y mensual                            | Existente, necesita adaptación                              | Plantilla nueva sobre el envío del resumen semanal del admin; Excel con `exceljs`.                                      |
| Asistente de IA SEO                                   | Existente, necesita adaptación                              | Mismo proveedor; herramientas nuevas sobre los datos SEO. Fase 5.                                                       |
| Auditoría técnica / rastreador                        | Pospuesto (fase 4)                                          | Versión ligera primero: sitemap + páginas propias.                                                                      |
| Backlinks                                             | Pospuesto                                                   | Caro en créditos y poco accionable al principio.                                                                        |
| SEO local geolocalizado                               | Pospuesto, a decidir                                        | Requiere otro proveedor de pago.                                                                                        |
| GA4, Bing, Business Profile, visibilidad en IA        | Pospuesto (fase 5+)                                         | GA4 ya tiene cliente reutilizable.                                                                                      |
| Importar los Excel históricos de Search Console       | Desarrollo nuevo, con piezas existentes                     | Lector de Excel del importador (`exceljs`). Ver §18.1.                                                                  |
| Métricas diarias por palabra, URL, país y dispositivo | Desarrollo nuevo                                            | Por dimensión para todo el sitio y cubo completo solo para las palabras seguidas. Ver §18.2.                            |
| Agrupar palabras por intención                        | Desarrollo nuevo                                            | Manual, SISTRIX y reglas. Ver §18.3.                                                                                    |
| URL objetivo por palabra                              | Desarrollo nuevo (ya previsto)                              | Campo de la palabra en el proyecto. Ver §18.4.                                                                          |
| Canibalización con consulta + URL                     | Desarrollo nuevo (ya previsto)                              | Sale del cruce consulta + página. Ver §18.5 y §19.2.                                                                    |
| Impresiones reales frente a volumen de SISTRIX        | Desarrollo nuevo                                            | Ver §18.6.                                                                                                              |
| Páginas indexadas que no deberían estarlo             | Desarrollo nuevo, en dos pasos                              | Reglas sobre lo que Google ya enseña; el rastreador lo confirma después. Ver §18.7.                                     |
| Registro de cambios y antes/después                   | Desarrollo nuevo, con piezas existentes                     | Parte de los cambios se anota sola desde el registro de acciones. Ver §18.8.                                            |
| Reservas, demos y suscripciones del tráfico orgánico  | Existente, necesita adaptación                              | El origen ya se guarda en leads y reservas. Ver §18.9.                                                                  |
| Histórico de posiciones de competidores               | Desarrollo nuevo (ya previsto)                              | Sale de la misma consulta semanal. Ver §18.10.                                                                          |

## 3. Arquitectura propuesta

- **Ubicación**: módulo `apps/api/src/modules/admin/seo/` y sección **«SEO»** en el panel del super admin (`apps/web/src/app/admin/seo/`). Solo rol superadmin escribe; soporte, solo lectura.
- **Datos**: tablas globales `seo_*` sin `tenant_id`, con `REVOKE` para el rol de la app (como el resto de tablas de plataforma). Un proyecto puede enlazarse opcionalmente a un tenant (`tenant_id` nulo o no) por si en el futuro se ofrece a clientes.
- **Proveedores desacoplados**: interfaz `SeoDataProvider` con dos implementaciones, `GoogleSearchConsoleProvider` (envuelve el cliente actual) y `SistrixProvider` (nuevo, `fetch`, sin SDK). Cada uno con modo simulado para tests (`NODE_ENV=test`), como Search Console, GA4 y Meta hoy.
- **Trabajos**: cola BullMQ nueva `seo` procesada en el worker; cada sincronización es un registro `seo_sync_runs` (estado, progreso, error, créditos) con reintentos, bloqueo por proyecto y tipo, y reanudación.
- **Tres capas de datos separadas**: lo que da el proveedor (crudo), lo calculado (oportunidades, puntuaciones) y lo generado por IA (propuestas), cada una en sus tablas y con su origen y fecha.
- **Sin infraestructura nueva**: mismo Postgres, Redis, worker y MinIO.

## 4. Modelo de datos propuesto (orientativo)

| Tabla                   | Contenido                                                                                                                                                                                                                                            | Clave única                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `seo_projects`          | nombre, dominio principal, país, idioma, tipo de negocio, estrategia (local/nacional/internacional), ubicación objetivo, palabras de marca, pesos de la puntuación (jsonb), frecuencias (jsonb), presupuesto de créditos, alertas (jsonb), objetivos | dominio principal                                               |
| `seo_project_domains`   | dominios secundarios o redirigidos, con su propiedad de Search Console y su papel (`primary`, `redirect`)                                                                                                                                            | proyecto + dominio                                              |
| `seo_gsc_metrics`       | una sola tabla para todos los cruces diarios de Search Console, con una columna `grain` que dice cuál es: `site`, `device`, `country`, `search_type`, `query`, `page`, `query_page`, `query_device`, `query_country`, `page_device`                  | propiedad + cruce + fecha + consulta + URL + país + dispositivo |
| `seo_keywords`          | palabra, país (diccionario compartido entre proyectos) y sus métricas de SISTRIX (volumen/tráfico, competencia, CPC, intención, fecha)                                                                                                               | palabra + país                                                  |
| `seo_project_keywords`  | palabra en un proyecto: clúster, etiquetas, prioridad comercial, estado, URL objetivo, notas, puntuación y su desglose                                                                                                                               | proyecto + palabra                                              |
| `seo_keyword_positions` | histórico de posición por proveedor (`gsc`/`sistrix`), dominio, fecha, URL y **estado** (`ranked`, `not_ranked`, `no_data`, `error`)                                                                                                                 | palabra + país + dominio + proveedor + fecha                    |
| `seo_competitors`       | competidor por proyecto, con restricción de directorio opcional y origen (manual/descubierto, validado o no)                                                                                                                                         | proyecto + dominio                                              |
| `seo_domain_metrics`    | por dominio y semana: índice de visibilidad, nº de palabras, reparto por posiciones                                                                                                                                                                  | dominio + país + fecha                                          |
| `seo_domain_keywords`   | extracción de palabras de un dominio (propio o competidor) con posición, URL y **cobertura** (límite y filtros de la consulta)                                                                                                                       | dominio + país + fecha + palabra                                |
| `seo_pages`             | URLs del proyecto: tipo, palabra principal, título/descripción/H1 conocidos, estado                                                                                                                                                                  | proyecto + URL                                                  |
| `seo_opportunities`     | tipo, palabra/URL, puntuación, motivos, confianza, estado                                                                                                                                                                                            | proyecto + tipo + clave                                         |
| `seo_tasks`             | acción, palabras, URL, prioridad, impacto, esfuerzo, estado, fechas, métricas antes/después                                                                                                                                                          | —                                                               |
| `seo_changes`           | registro de cambios hechos en las webs (para cruzar con el rendimiento)                                                                                                                                                                              | —                                                               |
| `seo_sync_runs`         | ejecuciones: proveedor, tipo, estado, progreso, filas, créditos, error                                                                                                                                                                               | —                                                               |
| `seo_api_usage`         | cada petición a SISTRIX: endpoint, parámetros (huella), créditos reales, fecha                                                                                                                                                                       | —                                                               |
| `seo_api_cache`         | respuesta guardada por huella de petición, con caducidad por tipo de dato                                                                                                                                                                            | huella                                                          |
| `seo_alerts`            | reglas y estado de enfriamiento (o reutilizar `security_alert_states`)                                                                                                                                                                               | —                                                               |
| `seo_gsc_imports`       | cada Excel importado: propiedad, periodo que cubre, filtros que llevaba, quién y cuándo                                                                                                                                                              | propiedad + huella del fichero                                  |
| `seo_gsc_import_rows`   | filas de un Excel que no se pueden repartir por días (consultas, páginas, países y dispositivos **del periodo**)                                                                                                                                     | importación + dimensión + valor                                 |
| `seo_index_findings`    | URL que Google enseña y no debería (motivo, primera y última vez vista, estado)                                                                                                                                                                      | proyecto + URL + motivo                                         |
| `seo_conversions_daily` | por día y página de entrada: reservas, solicitudes y altas con origen orgánico (calculado de los datos propios)                                                                                                                                      | proyecto + fecha + tipo + página                                |

Decisiones de diseño:

- **Search Console por cruces de dos dimensiones**, todos diarios y en una sola tabla (ver §19.1): consulta + página, consulta + dispositivo, consulta + país, consulta + fecha, página + dispositivo y página + fecha, más los totales del sitio. No un cubo de cinco dimensiones, que es lo que Google más recorta. Cada cruce se pide por separado a la API, así que **nunca se suman entre sí**: los totales salen siempre del cruce `site`, que cuadra con el panel de Google, y las consultas anónimas se ven como la diferencia.
- **Dominios secundarios**: cada uno guarda sus datos bajo su propia propiedad. La vista del proyecto muestra el principal y, aparte, «tráfico que aún llega por el secundario». No se suman.
- **Retención**: totales y posiciones de palabras seguidas, sin caducidad (para comparar año contra año más allá de los 16 meses de Google). Los cruces grandes (`query_page`, `query_country`), 25 meses. Caché de SISTRIX, según el tipo de dato.
- **Posición no encontrada**: nunca es 0. Estado explícito.
- Migraciones a mano, aditivas (tablas nuevas), sin tocar las existentes: se pueden deshacer borrando las tablas.

## 5. Search Console: integración y autenticación

- **Propongo no usar OAuth y mantener la cuenta de servicio que ya funciona.** Añades su correo como usuario de solo lectura en cada propiedad y no hay tokens que caduquen ni pantalla de consentimiento que verificar con Google. Cumple «permisos mínimos de lectura» y «almacenamiento seguro» (la clave vive en una variable del servidor). OAuth solo aportaría «descubrir propiedades» de tu cuenta personal; con la cuenta de servicio, `sites.list` devuelve las propiedades a las que la has añadido, que es lo mismo.
- **Carga inicial**: 16 meses, día a día para la granularidad consulta × URL (así el tope de 25.000 filas es por día y no se pierde cola larga), con reintentos y reanudación por día.
- **Diaria**: últimos 5 días, reescritos (Google corrige los datos recientes). Marca hasta qué fecha hay datos definitivos y avisa si el retraso pasa de 4 días.
- **Además**: sitemaps (estado y errores) y la inspección de URL **bajo demanda** (2.000 al día por propiedad), presentada como «lo que dice Google de esta URL», no como auditoría de indexación.
- **Límites**: reintento con espera creciente ante 429/5xx, y tope de consultas por minuto.

## 6. SISTRIX: endpoints, costes y control

Datos comprobados en su documentación (2026-11-25):

- Base `https://api.sistrix.com/<método>?api_key=…&format=json`. La clave se genera en «API access» de la cuenta.
- Máximo 300 peticiones por minuto y 300 ms entre peticiones.
- Los créditos se cobran por dato devuelto y **cada respuesta dice cuántos ha gastado**. El método `credits` da el saldo y no gasta.
- Créditos por semana según plan: Plus 10.000, Professional 30.000, Premium 100.000. Extra: 75 € por cada 10.000 a la semana.
- **Ningún método de dominio o palabra clave necesita un proyecto de Optimizer.** Los métodos `project.*` sí, y no los usaríamos.
- **MCP**: según su documentación, sus consultas no descuentan créditos y, desde el 31-8-2026, solo admite OAuth. No sirve para un proceso autónomo del servidor. La API HTTP usa la clave de API.

| Método                                                                                  | Para qué                                              | Coste documentado                             |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| `credits`                                                                               | saldo                                                 | 0                                             |
| `domain.visibilityindex`                                                                | índice de visibilidad, actual e histórico             | 1 por valor devuelto                          |
| `domain.kwcount.seo`, `domain.ranking.distribution`                                     | nº de palabras y reparto por posiciones               | sin confirmar (se mide en la primera llamada) |
| `keyword.domain.seo`                                                                    | palabras de un dominio con posición y URL             | 1 por fila                                    |
| `keyword.seo`                                                                           | resultados de una búsqueda (posición de cada dominio) | 1 por fila                                    |
| `keyword.seo.metrics`                                                                   | competencia, CPC, tráfico, reparto móvil/escritorio   | **5 por palabra**                             |
| `keyword.seo.searchintent`, `keyword.questions`, `domain.ideas`, `domain.opportunities` | intención, preguntas, ideas                           | sin confirmar                                 |
| `domain.competitors.seo`                                                                | competidores orgánicos                                | 1 por competidor                              |
| `links.overview`, `links.list`                                                          | enlaces                                               | sin confirmar; se pospone                     |

**Consumo estimado en régimen normal** (2 proyectos, 11 competidores, 150 palabras objetivo):

| Proceso                                                 | Frecuencia | Créditos                   |
| ------------------------------------------------------- | ---------- | -------------------------- |
| Visibilidad de 13 dominios                              | semanal    | 13                         |
| Resultados de 150 palabras, 10 primeros                 | semanal    | 1.500                      |
| Palabras de los 2 dominios propios (hasta 500 cada uno) | quincenal  | hasta 500/semana           |
| Palabras de 11 competidores (hasta 300 cada uno)        | quincenal  | hasta 1.650/semana         |
| Métricas de 150 palabras                                | mensual    | unos 190/semana            |
| Competidores orgánicos                                  | mensual    | unos 10/semana             |
| **Total**                                               |            | **unos 3.900 a la semana** |

Carga inicial única: histórico de visibilidad de 13 dominios (limitado a 2 años: unos 1.350 créditos) más las primeras extracciones (unos 4.300). Entra en una semana de un plan Plus. Son estimaciones: el primer paso de la fase 1 es una prueba con una sola petición de cada tipo para medir el coste real.

**Control de consumo** (va en la fase 1, no después):

- Saldo consultado antes de cada tanda; presupuesto semanal y mensual por proyecto y global.
- Estimación de coste antes de una consulta masiva (filas pedidas × coste por fila) y confirmación en pantalla.
- Bloqueo automático al llegar al presupuesto; «autorizar una consulta extraordinaria», con registro.
- Caché persistente compartida entre proyectos (el volumen de «trasteros valencia» se pide una vez).
- Registro de cada petición con sus créditos reales.
- Si no hay créditos o SISTRIX no responde, el panel sigue con lo guardado y lo dice.

**Aviso sobre SISTRIX para tus dominios**: el índice de visibilidad nacional de un dominio local pequeño suele ser cercano a cero y moverse poco; y muchas búsquedas locales («trasteros mislata») pueden no estar en su base. SISTRIX te servirá sobre todo para **mirar a la competencia y descubrir palabras**, no para medirte. Tu medida real es Search Console.

## 7. Sincronización y almacenamiento

| Proceso                         | Frecuencia por defecto      | Proveedor        |
| ------------------------------- | --------------------------- | ---------------- |
| Search Console (últimos 5 días) | diaria, 07:00               | Google           |
| Visibilidad                     | semanal (lunes)             | SISTRIX          |
| Posiciones de palabras objetivo | semanal                     | SISTRIX + Google |
| Palabras de competidores        | cada 15 días                | SISTRIX          |
| Volumen, CPC, intención         | mensual                     | SISTRIX          |
| Descubrir palabras              | manual                      | SISTRIX          |
| Detección de oportunidades      | semanal, tras las descargas | cálculo propio   |
| Informe                         | semanal y mensual           | —                |

Todas configurables por proyecto. Cada proceso: cola `seo`, un trabajo por proyecto y tipo (clave única, sin duplicados), upsert idempotente, reintentos con espera creciente, estado y progreso visibles, cancelable, y se reanuda tras un reinicio.

## 8. Navegación y pantallas

Grupo nuevo **SEO** en el menú del admin, con selector de proyecto arriba:

1. **Resumen** — indicadores, gráficos y comparativa por periodo; vista «Todos los proyectos».
2. **Palabras clave** — tabla con filtros, estados, importación y acciones en lote; ficha con su histórico.
3. **Páginas** — URLs con su rendimiento y sus palabras.
4. **Competencia** — visibilidad, keyword gap, descubrir competidores.
5. **Oportunidades** — lista puntuada con motivos y «Crear tarea».
6. **Plan** — tablero de tareas y vista de calendario (fase 3).
7. **Auditoría** — fase 4.
8. **Asistente** — fase 5.
9. **Ajustes** — proyectos, dominios, conexiones, frecuencias, presupuesto de créditos, alertas y ejecuciones.

En todas las pantallas, los datos de Google van marcados como «datos reales» y los de SISTRIX como «estimación».

## 9. Motor de oportunidades

Reglas, no IA, con el motivo visible:

- **Mejora rápida**: posición media 4–20 con impresiones suficientes.
- **CTR bajo**: CTR real por debajo del esperado para su posición (ya existe `expectedCtr`), sin contar marca.
- **Sin página objetivo**: palabra seleccionada sin URL, o cuya URL posicionada no es la objetivo.
- **Keyword gap**: palabras de competidores donde no apareces, indicando la cobertura de la extracción.
- **Canibalización**: dos o más URLs con impresiones relevantes para la misma consulta en el mismo periodo, marcada como «a revisar», no como error.
- **Pérdida**: caída frente al periodo anterior y, si hay histórico, frente al mismo periodo del año pasado.
- **Contenido con potencial**: página con impresiones por consultas que no están en su título ni en su palabra principal.
- **SEO local**: consultas con municipios y barrios de la zona objetivo.

Puntuación de 0 a 100 con tus pesos (25/20/20/15/10/10), editables por proyecto. Sin volumen conocido no se penaliza: ese factor se reparte entre los demás y baja la **confianza**, que se muestra aparte.

Enlazado interno y backlinks quedan para la fase 4 (necesitan el rastreador o créditos de enlaces).

## 10. Dependencias externas

- Cuenta de servicio de Google (ya existe) con la API de Search Console activada.
- Clave de API de SISTRIX.
- Opcionales más adelante: clave de PageSpeed Insights (gratuita), GA4, y un proveedor de posiciones geolocalizadas.
- Ninguna librería nueva obligatoria. Para leer HTML en la auditoría habría que añadir un analizador (por ejemplo `cheerio`).

## 11. Riesgos

| Riesgo                                                         | Mitigación                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gastar créditos de SISTRIX sin control                         | Presupuesto y bloqueo desde la fase 1; prueba inicial de coste real; nada masivo sin confirmación.                                                        |
| SISTRIX sin datos para búsquedas locales                       | Estado «sin datos» explícito; Search Console como fuente principal; decisión aparte sobre un proveedor local.                                             |
| Confundir posición nacional con la de Mislata                  | Etiqueta del origen en cada posición; nunca se mezclan en una misma columna.                                                                              |
| Licencia de SISTRIX: no compartir datos con terceros           | El módulo es interno del super admin. Si algún día se ofrece a tenants, los datos de SISTRIX no pueden mostrarse sin su autorización.                     |
| Volumen de filas de Search Console                             | Cruces de dos dimensiones en una tabla, retención de 25 meses en los más grandes (`query_page`, `query_country`), índices por propiedad, cruce y fecha.   |
| SSRF en el rastreador                                          | Solo dominios del proyecto, validación de IP en cada salto, sin seguir redirecciones a ciegas, topes de páginas, tamaño y tiempo. Ya existen los helpers. |
| Inyección de instrucciones desde páginas de competidores       | En las fases 1–3 no se rastrea contenido ajeno. En la 5, el texto externo va delimitado como dato y las herramientas del asistente son de solo lectura.   |
| Clave de la cuenta de servicio con acceso a varias propiedades | Solo lectura; la clave no sale del servidor; registro de acciones.                                                                                        |
| Acoplar una herramienta interna al SaaS                        | Módulo aislado con tablas propias; se puede extraer sin tocar el resto.                                                                                   |

## 12. Fases, prioridades y esfuerzo

| Fase                 | Contenido                                                                                                                                                                                                                                                                                                                                                             | PR estimadas |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **1. Base**          | Proyectos y dominios; Search Console ampliado con histórico y métricas diarias por dimensión; **importación de los Excel históricos**; proveedor de SISTRIX con caché, presupuesto y registro; cola y ejecuciones; panel con comparativas; exportación CSV                                                                                                            | 3–4          |
| **2. Investigación** | Gestor de palabras clave (manual, CSV/Excel, desde Search Console y desde SISTRIX) con **intención, URL objetivo y cubo diario de las seguidas**; competidores, keyword gap e **histórico de sus posiciones**; páginas; oportunidades con puntuación, **canibalización**, **impresiones frente a volumen** y **páginas que no deberían estar indexadas** (por reglas) | 4            |
| **3. Estrategia**    | Tareas con tablero y calendario; **registro de cambios con antes y después**; **reservas, demos y suscripciones del tráfico orgánico**; alertas; informes semanal y mensual; Excel maestro                                                                                                                                                                            | 3            |
| **4. Auditoría**     | Rastreador ligero de los dominios propios, incidencias con histórico, inspección de URL, PageSpeed                                                                                                                                                                                                                                                                    | 2–3          |
| **5. IA y avanzado** | Asistente con herramientas SEO, briefings, GA4 y conversiones, visibilidad en buscadores de IA                                                                                                                                                                                                                                                                        | 2–3          |

Cada PR es del tamaño de las que venimos haciendo (una sesión de trabajo, con sus pruebas y su revisión en el navegador). **El MVP de tus 14 criterios se cumple al acabar la fase 2**, salvo «detectar oportunidades básicas», que llega con su última PR. Con los diez requisitos añadidos (§18), las tres primeras fases pasan de 8–10 PR a **10–11**.

## 13. Estrategia de pruebas

- Unitarias (vitest en `packages/shared`): puntuación, reglas de oportunidades, agregados de CTR y posición, estimación de créditos.
- Unitarias del API con `fetch` simulado: cliente de SISTRIX (parseo, créditos, 429, sin saldo) y cliente de Search Console ampliado.
- e2e con proveedores simulados: alta de proyecto, carga inicial, repetición sin duplicados, bloqueo por presupuesto, reanudación tras fallo, dominios secundarios sin mezclar, permisos (soporte no escribe).
- Prueba real controlada: una petición por método de SISTRIX para fijar costes, con tu visto bueno.
- Revisión en el navegador, escritorio y móvil, como en las PR anteriores.

## 14. Criterios de aceptación

Los 14 de tu propuesta, más:

15. Los totales de un periodo coinciden con el panel de Search Console.
16. Ninguna consulta a SISTRIX se hace sin pasar por el presupuesto, y su coste real queda registrado.
17. Con SISTRIX sin saldo o caído, el panel sigue funcionando con los datos guardados.
18. Una posición no encontrada nunca se muestra como 0.

## 15. Lo que simplificaría de tu propuesta

1. **OAuth de Google → cuenta de servicio.** Ya está hecha y es más sencilla y estable.
2. **Calendario de contenidos → vista del tablero de tareas.** Dos módulos para lo mismo es duplicar.
3. **Mapeo palabra ↔ URL → un campo y una tabla derivada**, no un módulo de gestión de páginas completo.
4. **Rastreador con JavaScript → rastreador simple primero.** Tus webs se sirven ya renderizadas en el servidor; el navegador sin cabeza solo si hace falta.
5. **Backlinks → fuera de las tres primeras fases.** Caro y poco accionable hasta tener lo demás.
6. **Rendimiento por país → solo totales.** Tus dos negocios son de España.
7. **Asistente de IA al final.** Sin datos acumulados no puede decir nada fundado.
8. **Control de roles propio → los del panel admin.** Eres el único usuario.

## 16. Decisiones pendientes de tu aprobación

1. ¿Módulo en el panel del super admin, independiente de los tenants? (recomendado)
2. ¿Mantener la cuenta de servicio de Google en lugar de OAuth? (recomendado)
3. ¿Qué plan de SISTRIX tienes y qué presupuesto semanal de créditos reservamos? (propuesta: 4.000 a la semana, con aviso al 80 %)
4. ¿Autorizas la prueba inicial de coste real, de unos 50 créditos?
5. ¿Histórico de visibilidad de SISTRIX limitado a 2 años en la carga inicial?
6. ¿Calendario de contenidos fusionado con las tareas?
7. SEO local geolocalizado: ¿lo dejamos para después de la fase 2 y entonces comparo proveedores y precios?
8. ¿El SEO que ya tienen los tenants se queda como está? (recomendado)
9. ¿Empezamos por la fase 1 completa (3–4 PR) o prefieres una primera PR solo con Search Console para ver datos cuanto antes?
10. ~~Métricas diarias por país y dispositivo~~ **Resuelta** por tu segundo mensaje: se guardan los seis cruces de dos dimensiones que pides (§19.1).
11. Histórico de posiciones de competidores hacia atrás: ¿solo desde que arranquemos (gratis), o compramos también el pasado? (unos 1.500 créditos por cada fecha pasada con 150 palabras; ver §18.10)
12. Conversiones de trasteros.pro: ¿qué cuenta como «solicitud de demo»? Hoy existen el formulario de contacto y el alta de la prueba gratis; no hay un formulario de demo como tal (ver §18.9).

## 17. Lo que tendrás que facilitar

- Añadir el correo de la cuenta de servicio como usuario (lectura) en las tres propiedades de Search Console: `guardalobox.es`, `trasteros.pro` y `trasterosmislata.es`.
- La clave de API de SISTRIX (se guarda cifrada desde el panel, no en el repositorio) y el plan contratado.
- País e idioma de cada proyecto, ubicación objetivo de GUÁRDALO (Mislata y municipios cercanos) y palabras de marca de cada uno.
- La lista inicial de palabras clave objetivo, si ya tienes una (CSV o Excel).
- Confirmar los competidores iniciales y, para los que tengan varios negocios, a qué directorios restringir el análisis.
- Los Excel históricos de Search Console que tengas, indicando de qué propiedad es cada uno si el nombre del fichero no lo dice.
- Qué partes de cada web **no** deben estar en Google (por ejemplo área de clientes, firma, pago), para las reglas de §18.7.

## 18. Requisitos añadidos el 2026-11-25

### 18.1. Importar los Excel históricos de Search Console

- Sirve para lo que la API ya no da: lo anterior a los 16 meses.
- **Límite que conviene conocer**: el Excel que exporta Search Console no trae datos diarios por consulta. Trae una hoja «Fechas» con los totales de cada día y hojas de consultas, páginas, países y dispositivos **sumadas para todo el periodo exportado**. No se puede reconstruir «qué posición tenía esta palabra el 3 de marzo».
- Qué se guarda:
  - La hoja de fechas rellena los totales diarios (cruce `site` de `seo_gsc_metrics`) de los días que la API no tenga. Si un día está en los dos sitios, manda la API.
  - Las demás hojas se guardan como **foto del periodo** (`seo_gsc_import_rows`), con sus fechas de inicio y fin, y se enseñan aparte, marcadas «importado», para comparar periodos enteros. No se mezclan con los datos diarios.
  - La hoja de filtros del Excel se guarda con la importación: un Excel exportado con un filtro (un país, un tipo de búsqueda) no vale como total del sitio y se avisa.
- Vista previa antes de confirmar (periodo detectado, filas, solapes con lo ya guardado) y sin duplicados: el mismo fichero no entra dos veces.
- Acepta el `.xlsx` y el `.zip` de CSV que da Google, en español o en inglés.

### 18.2. Métricas diarias por palabra clave, URL, país y dispositivo

Concretado por tu segundo mensaje: se guardan a diario los seis cruces de dos dimensiones que pides, además de los totales. El detalle está en §19.1. El cubo completo de cinco dimensiones no se guarda: es lo que Google más recorta y sus sumas no cuadran con los totales.

### 18.3. Agrupar palabras por intención de búsqueda

- Cuatro intenciones: informativa, comercial, transaccional y de navegación (marca), más «local» como marca aparte, porque en GUÁRDALO casi todo lo comercial es también local.
- De dónde sale, por este orden: lo que tú pongas a mano, lo que diga SISTRIX (`keyword.seo.searchintent`, coste por confirmar) y, si no hay nada, reglas sencillas sobre el texto («precio», «alquilar», «cerca», «qué es», nombre de municipio). Se guarda siempre el origen.
- En el gestor de palabras: filtro y vista agrupada por intención y por clúster, con el rendimiento sumado de cada grupo.
- La intención alimenta el 25 % de «intención comercial» de la puntuación.

### 18.4. URL objetivo de cada palabra

- Campo de la palabra en su proyecto; se puede asignar en lote y proponer sola (la URL que más clics recibe por esa consulta).
- Con ella se detecta: palabra sin URL objetivo, URL objetivo que no es la que Google posiciona, y varias palabras de intención distinta apuntando a la misma URL.

### 18.5. Canibalización con consulta y URL combinadas

- Se calcula sobre el cruce consulta + página: misma consulta, dos o más URL, cada una con una parte relevante de las impresiones en 28 días, y posiciones que se alternan.
- Se excluyen las búsquedas de marca y los casos en que la segunda URL es un enlace de sitio.
- Se presenta como «a revisar», con las URL, su reparto de impresiones y clics y su posición, no como error. La ficha propone cuál debería ser la URL objetivo.

### 18.6. Impresiones reales frente a volumen estimado de SISTRIX

- Por palabra y mes: impresiones de Search Console entre volumen de SISTRIX = **cuota de impresiones**.
- Lecturas:
  - Volumen alto e impresiones bajas: no apareces en la primera página. Oportunidad.
  - Impresiones por encima del volumen: SISTRIX se queda corto con esa búsqueda (típico de lo local). Se marca y **baja la confianza** de sus cifras para ese proyecto.
  - Sin volumen en SISTRIX pero con impresiones reales: la búsqueda existe; se usa la impresión como medida de demanda.
- Avisos que se muestran junto al dato: el volumen es nacional y la impresión solo cuenta cuando apareces, así que no son la misma cosa y la cuota no es una cuota de mercado exacta.
- Habrá que confirmar en la prueba inicial qué campo de SISTRIX usar: `keyword.seo.metrics` devuelve «traffic», no un volumen mensual explícito.

### 18.7. Páginas indexadas que no deberían estarlo

- **Límite**: Google no ofrece ninguna lista de todo lo que tiene indexado. Lo que sí se sabe con certeza es que **toda URL con impresiones está indexada**.
- Primer paso (fase 2, sin rastreador): cada URL con impresiones se contrasta con reglas por proyecto:
  - No está en el sitemap.
  - Casa con un patrón que has marcado como privado o técnico (área de clientes, firma, pago, parámetros, pruebas).
  - Es del dominio secundario, que debería redirigir (`trasterosmislata.es` con impresiones propias).
  - Variantes duplicadas: con y sin `www`, `http`, con barra final, con parámetros.
- Segundo paso (fase 4): el rastreador y la inspección de URL bajo demanda confirman el motivo (sin `noindex`, canónica mal puesta, redirección que falta).
- Cada hallazgo guarda cuándo se vio por primera y última vez y su estado (nuevo, conocido, resuelto, ignorado).

### 18.8. Registro de modificaciones y antes/después

- Cada cambio: fecha, tipo (título, contenido, enlazado, técnica, página nueva, redirección), URL y palabras afectadas, y quién.
- **Parte se anota sola**: los cambios hechos desde la propia plataforma ya quedan en el registro de acciones (título y descripción de trasteros.pro, entradas del blog, SEO de la web del tenant, páginas de zona). Se leen de ahí; el resto se apunta a mano o al cerrar una tarea.
- Comparación automática de 28 días antes y 28 después (y 90/90 cuando haya pasado el tiempo) de clics, impresiones, CTR y posición de las URL y palabras afectadas.
- Para no atribuir al cambio lo que es estacionalidad, se enseña al lado la evolución del resto del sitio en las mismas fechas y, si hay histórico, el mismo periodo del año anterior. La pantalla dice «coincide con», no «causó».
- Los cambios salen como marcas en los gráficos del panel.

### 18.9. Reservas, demos y suscripciones del tráfico orgánico

- **No hace falta GA4 para empezar**: la plataforma ya guarda de dónde viene cada visitante (`packages/shared/src/web/attribution.ts` distingue Google orgánico) y lo arrastra hasta el contacto y la reserva.
- GUÁRDALO: visitas, contactos, reservas, firmas y primer pago con origen Google orgánico. Ya existe un embudo así para el tenant (`GET /seo/google-funnel`); se lleva al proyecto.
- trasteros.pro: altas de prueba y mensajes del formulario de contacto con origen orgánico (los leads de la plataforma guardan `utm_source` y `utm_medium`), y de ahí a suscripción de pago siguiendo el lead hasta su tenant y sus cobros.
- Dos huecos que habría que cerrar:
  - **Página de entrada**: hoy se guarda el origen pero no siempre la primera página que vio. Hay que añadirla al contacto y al alta para saber qué página trae clientes.
  - **trasteros.pro no registra visitas propias** (solo tiene GA4, con consentimiento). Las conversiones se pueden contar igualmente; el tráfico orgánico por página saldría de Search Console.
- Con esto el panel puede enseñar, por página y por palabra, clics → contactos → reservas o altas → de pago, y la puntuación de oportunidades puede premiar lo que de verdad trae clientes.
- Límite: una reserva no se puede atribuir a una palabra concreta (Google no la da); se atribuye a la página de entrada.

### 18.10. Histórico de posiciones de los competidores

- **Desde que arranquemos, sale gratis**: la consulta semanal de cada palabra (`keyword.seo`, 10 primeros) devuelve la posición de todos los dominios a la vez. Se guarda la de cada competidor registrado, con su URL (`seo_keyword_positions`).
- Además, cada quincena se guarda la extracción de palabras de cada competidor (`seo_domain_keywords`), que da su evolución general y las palabras que gana o pierde.
- **Hacia atrás** se puede comprar con el parámetro de fecha de SISTRIX: unas 1.500 créditos por cada fecha pasada con 150 palabras. Seis fechas mensuales serían unos 9.000 créditos, una sola vez. Decisión 11.
- Se recuerda siempre que son posiciones nacionales de SISTRIX, no las de Mislata.
- Vistas: evolución de un competidor en una palabra, comparativa de varios en un grupo de palabras, y «quién sube y quién baja» de la semana.

## 19. Requisitos derivados del análisis real de Search Console (2026-11-25)

Revisado otra vez el código antes de planificarlos. Lo que ya existe y se reutiliza:

| Pieza existente                                             | Dónde                                                                                                     | Para qué sirve aquí                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Descarga con paginación y reescritura de los días recientes | `search-console.client.ts`, `search-console.service.ts`                                                   | Misma mecánica, con más cruces.                              |
| CTR = clics ÷ impresiones y posición ponderada              | `summarizeSearchConsole`, `summarizeRange` (`packages/shared/src/web/search-console.ts`)                  | Tal cual (§19.7).                                            |
| Posición anterior y cambio por consulta y por página        | `SeoQueryDto.previousPosition/change`, `SeoPageDto`                                                       | Base de «mejora o empeora» (§19.3).                          |
| Oportunidades en posición 4–20 con 20 impresiones o más     | `summarizeRange` (línea 469)                                                                              | Se parte en 4–10 y 11–20 y se amplía (§19.3).                |
| CTR esperado por posición                                   | `expectedCtr`                                                                                             | «Muchas impresiones y pocos clics» (§19.3).                  |
| Marca frente a no marca                                     | `isBrandQuery`, `brandTerms`                                                                              | Excluir marca de canibalización y oportunidades.             |
| Avisos de caída de página o consulta                        | `SeoAlertDto`, `checkDrop`                                                                                | Patrón de las alertas (§19.2).                               |
| Rutas que la plataforma ya marca como no indexables         | `apps/web/src/middleware.ts` (`NOINDEX_PREFIXES`), `apps/web/src/app/robots.ts` (`PRIVATE`), `sitemap.ts` | Reglas iniciales de indexación para trasteros.pro (§19.5).   |
| Lector de Excel y vista previa de importación               | `apps/api/src/modules/imports/` (`xlsxBase64ToCsv`, motor de importación)                                 | Importar los Excel de Google (§19.7).                        |
| Registro de acciones                                        | `audit_logs`, `super_admin_audit_logs`                                                                    | Anotar solos los cambios hechos desde la plataforma (§19.6). |

No existe nada de canibalización ni de gestión de indexación; son desarrollo nuevo.

### 19.1. Cruce de dimensiones

Los seis cruces que pides, todos por día, más los totales:

| Cruce (`grain`)                            | Dimensiones pedidas a la API   | Uso principal                          |
| ------------------------------------------ | ------------------------------ | -------------------------------------- |
| `query`                                    | fecha + consulta               | evolución de una palabra               |
| `page`                                     | fecha + página                 | evolución de una URL, antes y después  |
| `query_page`                               | fecha + consulta + página      | canibalización, URL posicionada, mapeo |
| `query_device`                             | fecha + consulta + dispositivo | móvil frente a escritorio por palabra  |
| `query_country`                            | fecha + consulta + país        | búsquedas desde fuera de España        |
| `page_device`                              | fecha + página + dispositivo   | páginas que fallan en móvil            |
| `site`, `device`, `country`, `search_type` | fecha (+ una dimensión)        | totales que cuadran con Google         |

- **Una sola tabla** (`seo_gsc_metrics`) con la columna `grain`, en lugar de siete tablas iguales. Clave única por propiedad, cruce, fecha y dimensiones, así que repetir una descarga no duplica.
- Son diez peticiones por propiedad y día: muy por debajo de la cuota de Google.
- **Regla que evita los cálculos mal hechos**: cada pantalla lee de un único cruce y nunca suma dos. Los totales, siempre del cruce `site`. Donde un cruce con consulta no llegue al total (consultas anónimas), se enseña la diferencia como «búsquedas que Google no detalla».
- Lo que **no** se guarda: consulta + página + país + dispositivo a la vez. Si algún día hace falta para una palabra concreta, la API permite pedirlo filtrando por esa consulta, sin cambiar el modelo.

### 19.2. Canibalización

- Lista de consultas con dos o más URL del mismo dominio en el periodo, con clics, impresiones, CTR y posición **de cada URL** y su parte del total.
- **Cambios de URL posicionada**: línea de tiempo por consulta con la URL principal de cada semana; se marca cuando cambia. Sale del cruce consulta + página por fecha.
- URL objetivo asignable a mano en cada palabra (§18.4); con ella el sistema sabe cuál de las URL «debería» ser.
- Alertas, con el patrón de las de caída: una por consulta y como mucho una por semana, solo si las dos URL superan un mínimo de impresiones y la consulta no es de marca.
- Cada caso se clasifica, sin darlo por malo:
  - «Probable conflicto»: las URL se alternan y la posición empeora cuando cambia.
  - «Convivencia»: las dos aparecen a la vez con buena posición (por ejemplo, la portada y una ficha).
  - «Cambio de URL»: Google ha pasado de una a otra de forma estable.
- Se puede marcar como «revisado, está bien» para que no vuelva a avisar.

### 19.3. Oportunidades

Seis listas, cada una con su umbral editable por proyecto:

| Lista                                            | Regla                                                                           | Reutiliza                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------- |
| Muchas impresiones y pocos clics                 | CTR real por debajo del esperado para su posición, con un mínimo de impresiones | `expectedCtr`                |
| Posiciones 4–10                                  | posición media 4–10 e impresiones suficientes                                   | regla actual 4–20, partida   |
| Posiciones 11–20                                 | posición media 11–20                                                            | ídem                         |
| Comerciales en 21–50                             | posición 21–50 **e** intención comercial o transaccional (§18.3)                | nuevo                        |
| Con impresiones reales y volumen cero en SISTRIX | impresiones en Search Console y volumen 0 o sin dato en SISTRIX                 | nuevo (§18.6)                |
| Mejoran o empeoran                               | cambio de posición frente al periodo anterior, ponderado por impresiones        | `previousPosition`, `change` |

- Las de marca van aparte.
- «Mejoran o empeoran» compara periodos iguales y completos, y exige un mínimo de impresiones en los dos para no avisar por ruido.
- Cada fila enlaza con su palabra, su URL posicionada y «crear tarea».

### 19.4. Métricas de SISTRIX

Todas estaban previstas en §6; lo que se concreta:

- Volumen, competencia y CPC: `keyword.seo.metrics` (5 créditos por palabra, mensual). Pendiente de confirmar en la prueba inicial si el volumen mensual es su campo «traffic».
- Posiciones orgánicas y **URL posicionadas de la competencia**: `keyword.seo` (posición, dominio y URL de cada resultado) y `keyword.domain.seo` (palabras de un dominio con su URL).
- Histórico de visibilidad: `domain.visibilityindex` con `history`.
- **Fecha de actualización por métrica**: cada dato de SISTRIX guarda cuándo se obtuvo y de qué semana es, y se enseña junto al valor («hace 3 semanas»). Un dato caducado se ve como tal, no se oculta.
- Límites y consumo: presupuesto, bloqueo, registro y caché (§6).
- **Sin proyectos de SISTRIX**: confirmado en su documentación. Solo los métodos `project.*` los necesitan y no se usan.

### 19.5. Gestión de indexación

Amplía §18.7 con las categorías que pides:

| Categoría                         | Cómo se detecta                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Login y registro                  | patrones de ruta; para trasteros.pro, la lista que la propia web ya marca como no indexable                                  |
| Internas y privadas               | panel, área de clientes, firma, pago: `PRIVATE` y `NOINDEX_PREFIXES` de la plataforma, más los patrones que añadas           |
| Con parámetros                    | URL con `?` (se agrupan por parámetro)                                                                                       |
| Centros de demostración y pruebas | webs de tenants de demostración o de prueba, y patrones que indiques                                                         |
| HTTP y HTTPS duplicadas           | misma ruta con los dos protocolos, o con y sin `www`                                                                         |
| Versiones de idioma               | `/l/en` y similares: se comprueba que tengan su pareja y no compitan por las mismas consultas                                |
| Canonicalización                  | misma página con y sin barra final, mayúsculas o parámetros; la inspección de URL confirma la canónica que ha elegido Google |

**Dos estados distintos, siempre visibles**:

- «Aparece en rendimiento»: la URL ha tenido impresiones. Es una señal fuerte de que está indexada, pero no una confirmación.
- «Indexación confirmada»: se ha consultado con la inspección de URL de Google, y se guarda la fecha, el veredicto, la canónica elegida y el último rastreo. Tiene cuota (2.000 al día por propiedad), así que se lanza a mano o sobre las URL marcadas, no sobre todo el sitio.

Cada hallazgo: categoría, estado (nuevo, conocido, resuelto, ignorado), primera y última vez visto, y «crear tarea».

### 19.6. Seguimiento de actuaciones

- Por URL: fecha, descripción, palabra clave objetivo y responsable (más el tipo de cambio, opcional).
- Comparación automática de **7, 28 y 90 días** antes y después: clics, impresiones, CTR y posición de la URL y de su palabra objetivo.
- **Sin periodos incompletos**:
  - Una ventana solo se calcula cuando han pasado todos sus días **y** Google ya da esos datos como definitivos (unos 3 días de margen). Hasta entonces se ve «disponible el día X».
  - El día del cambio no cuenta en ninguno de los dos lados.
  - Si falta histórico por delante (la página no existía), se dice y no se compara.
- Al lado, la evolución del resto del sitio en las mismas fechas, para no atribuir al cambio lo que es estacionalidad.
- Los cambios hechos desde la plataforma se anotan solos (§18.8).

### 19.7. Importación de históricos

Amplía §18.1:

- Se leen **todas las pestañas** del Excel original: Consultas, Páginas, Países, Dispositivos, Aspecto en las búsquedas, Fechas y Filtros.
- **Agregado y desglosado, separados**:
  - «Fechas» es desglose diario: entra como cruce `site` de los días que la API no tenga.
  - Las demás pestañas son agregados del periodo: se guardan como foto del periodo (`seo_gsc_import_rows`) y nunca se reparten por días ni se suman a los datos diarios.
- Si un Excel se solapa con datos de la API, mandan los de la API y el solape se enseña en la vista previa.
- CTR agregado = clics totales ÷ impresiones totales, y posición media ponderada por impresiones, con las funciones que ya existen. El CTR y la posición que trae cada fila del Excel se guardan como referencia, pero los agregados se recalculan.
- Reutiliza el lector de Excel y la vista previa del importador actual.

## 20. Dos ámbitos: la plataforma y los tenants (aclaración del 2026-11-25)

Las secciones anteriores planteaban un único módulo en el panel del super admin, con GUÁRDALO como un proyecto más. **No es lo que se quiere.** Queda así:

|                | SEO de la plataforma                     | SEO del tenant                                                              |
| -------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| Para qué web   | `trasteros.pro`                          | la web de cada negocio (GUÁRDALO: `guardalobox.es` y `trasterosmislata.es`) |
| Dónde se ve    | panel del super admin, grupo «SEO»       | panel del tenant, en Análisis → SEO                                         |
| Quién lo usa   | tú, como dueño de la plataforma          | cada tenant que lo contrate; tú en GUÁRDALO como un tenant más              |
| Cómo se activa | siempre                                  | **extra nuevo de pago**, fuera de todos los planes, contratable aparte      |
| Conversiones   | altas de prueba, contacto, suscripciones | contactos, reservas, firmas y pagos                                         |

### 20.1. Un solo motor, dos entradas

- El motor (descarga de Search Console, cruces, canibalización, oportunidades, indexación, actuaciones, importación, informes) es **el mismo código** para los dos ámbitos. Cambia quién es el dueño del proyecto y por qué pantalla se entra.
- Las tablas `seo_*` llevan `tenant_id`: con valor, el proyecto es de ese tenant y queda aislado por las políticas de fila que ya usa todo el producto; vacío, es de la plataforma y solo lo lee el super admin.
- En el tenant, el número de proyectos es uno (su web), con sus dominios secundarios. En la plataforma, los que hagan falta.

### 20.2. Qué pasa con lo que ya tienen los tenants

Hoy existe el extra **«SEO local»** (12 €/mes, función `local_seo`): páginas de zona, revisión de SEO, Posiciones en Google con Search Console e informe mensual. Para no tener dos sistemas de Search Console por tenant:

- La descarga de Search Console pasa a ser **una sola**, la del motor nuevo. Los datos que ya hay en `search_console_rows`, `search_console_days` y `search_console_devices` se copian a la tabla nueva con una migración, y las pantallas actuales de «Posiciones en Google» pasan a leer de ahí. Las tablas viejas se retiran después, en una PR aparte y con tu visto bueno.
- Las palabras seguidas (`seo_tracked_keywords`) pasan al gestor nuevo.
- Quien tiene «SEO local» conserva exactamente lo que tiene hoy. Lo nuevo (cruces, canibalización, oportunidades ampliadas, indexación, actuaciones, importación de históricos, competencia) es del extra nuevo.
- Decisión pendiente: si el extra nuevo **incluye** «SEO local» o se venden por separado (ver 20.5).

### 20.3. SISTRIX con tenants: el punto delicado

Ofrecer datos de SISTRIX a los tenants con tu cuenta tiene dos problemas:

1. **Licencia**: sus condiciones prohíben compartir datos con terceros sin autorización escrita. Enseñarlos a clientes de pago lo es.
2. **Créditos**: cada tenant gastaría del orden de 1.500–2.000 a la semana. Con diez tenants se agota un plan Professional.

Propuesta: **la clave de SISTRIX es de cada ámbito**, con el mismo patrón que ya existe para la clave propia de IA.

- La plataforma tiene la suya, para `trasteros.pro`.
- Un tenant puede poner **su propia clave** en su configuración. GUÁRDALO usaría la tuya, porque el negocio es tuyo: no hay cesión a terceros.
- Un tenant sin clave tiene el extra completo en todo lo que sale de Search Console, que es la mayor parte: cruces, canibalización, oportunidades, indexación, actuaciones, importación, conversiones e informes. Lo que necesita SISTRIX (volumen, competencia, posiciones de competidores, keyword gap, visibilidad) aparece como «conecta tu cuenta de SISTRIX».
- Si más adelante quieres dar esos datos a todos, las vías son pedir autorización a SISTRIX o usar un proveedor de pago por uso que permita la reventa. Se decide entonces.

### 20.4. Otras consecuencias

- **Permisos del tenant**: ver con `analytics:read`; conectar, configurar e importar con `settings:manage`. Alcance por local donde aplique.
- **Dominios**: un tenant solo puede conectar sus propios dominios (la comprobación ya existe para Search Console) y los secundarios que haya verificado en Google.
- **Costes de la plataforma por tenant**: Search Console es gratis y su cuota es por propiedad. Lo que sí cuesta es almacenamiento y, en la fase 5, la IA (ya tiene cuotas por tenant).
- **Rastreador** (fase 4): cada tenant, solo sus dominios, con topes de páginas por ejecución.
- **Datos personales y bajas**: las tablas nuevas entran en el anonimizado y en la exportación del tenant, y en la lista que comprueba que ninguna tabla con `tenant_id` se queda fuera.
- **Señal de adopción y oportunidad de venta** del extra en el panel admin, como el resto de extras.
- **Vista global**: tú puedes seguir comparando `trasteros.pro` con GUÁRDALO desde el panel admin (el super admin ve los proyectos de los tenants, en solo lectura), sin mezclar sus datos.

### 20.5. Decisiones que abre esta aclaración

1. Nombre y precio del extra nuevo, y si **incluye** «SEO local» (un solo extra más caro) o se suma a él.
2. ¿De acuerdo con que SISTRIX vaya con clave propia de cada ámbito, y que el tenant sin clave tenga solo la parte de Search Console?
3. ¿Migramos las tablas actuales de Search Console de los tenants al modelo nuevo (recomendado), en vez de mantener dos sistemas?
4. ¿Por dónde empezamos: por el tenant (GUÁRDALO, que ya tiene Search Console conectado) o por la plataforma? Recomiendo el tenant: la base ya existe y ves datos antes.

Las decisiones 1 y 8 de la §16 quedan sustituidas por estas.

### 20.6. Efecto en las fases

- Fase 1: el motor nace ya con los dos ámbitos y la migración de los datos de Search Console de los tenants. Sube a **4 PR**.
- Fase 2: las pantallas se hacen una vez y se montan en los dos paneles; se añade el extra, su puerta de acceso y la clave propia de SISTRIX. **4–5 PR**.
- Fase 3: igual, con las conversiones de cada ámbito. **3 PR**.
- Total de las tres primeras fases: **11–12 PR** en lugar de 10–11.

## 21. Decisiones tomadas y recomendación sobre los tenants (2026-11-25)

**Decidido por Jota**

- Cada tenant puede poner su propia clave de SISTRIX; sin clave, solo tiene lo que sale de Search Console.
- GUÁRDALO usa la misma clave que `trasteros.pro` (el negocio es del mismo dueño). Es un ajuste que pone el super admin en el tenant, como el modo de la clave de IA: «usa la clave de la plataforma».
- GUÁRDALO tendrá el SEO completo.

**Recomendación (pendiente de respuesta): construirlo para tenants, pero no venderlo todavía**

- El motor se hace igualmente con dueño por tenant, porque GUÁRDALO es un tenant. Dejarlo preparado para los demás no cuesta más.
- Lo que sí cuesta es **convertirlo en producto**: ponerle precio, explicarlo, dar soporte y simplificarlo. La herramienta que has descrito (cruces de dimensiones, canibalización, keyword gap) es para alguien que sabe de SEO. Un operador de trasteros medio no la usará tal cual, y para él ya existe «SEO local», que es sencillo.
- Propuesta: activarlo solo en GUÁRDALO como cortesía desde el panel admin (el mecanismo ya existe) y dejar el extra creado pero sin publicar en el catálogo. Lo usas unos meses en GUÁRDALO y en `trasteros.pro`, y con lo que veas que de verdad sirve se decide si se vende y con qué forma (probablemente una vista más simple, tipo «qué hacer esta semana»).

Si se acepta, salen de las primeras fases y quedan para cuando se decida vender:

- La pantalla del tenant para poner su propia clave de SISTRIX (GUÁRDALO usa la de la plataforma).
- El extra en el catálogo público, con su precio, su señal de adopción y su oportunidad de venta.
- La migración de los datos de Search Console de los demás tenants (§20.2): «SEO local» sigue como está y solo GUÁRDALO tendría las dos descargas durante un tiempo.

Con eso las tres primeras fases vuelven a **10–11 PR**.

## 22. Decisión: para todos los tenants desde el principio (2026-11-25)

- Jota decide construirlo ya para todos los tenants, como extra de pago aparte. La recomendación de la §21 («solo GUÁRDALO de momento») queda descartada; vuelve a valer la §20 completa: migración de los datos de Search Console de los tenants, pantalla de clave propia de SISTRIX y extra en el catálogo. Tres primeras fases: **11–12 PR**.
- Nombre propuesto: «SEO Avanzado (Sistrix)». Precio propuesto: 200 €/mes. **Pendiente de cerrar**: ver las dudas sobre el nombre y el precio en la conversación (marca de SISTRIX en el nombre, y qué recibe por ese precio un tenant sin clave).

## 23. Respuestas de Jota (2026-11-25)

1. Nombre: **«SEO Avanzado»**, 199 €/mes (de momento; editable en el panel admin).
2. «SEO Avanzado» **incluye** lo de «SEO local».
3. Migración de los datos de Search Console de los tenants al modelo nuevo: a mi elección → **se migra**, conservando las tablas antiguas como respaldo hasta una PR posterior que las retire con su visto bueno.
4. Créditos de SISTRIX: ver 23.1.
5. Autorizada la prueba inicial de unos 50 créditos.
6. Límites por tenant aceptados: 300 palabras seguidas, 10 competidores, 1 dominio principal y 3 secundarios.

### 23.1. Créditos de SISTRIX

- Los créditos de la API **vienen incluidos en la suscripción** y se renuevan **cada semana**, no al mes. No hay que pagar aparte mientras no se pase de la asignación semanal; si se pasa, la API deja de responder hasta la renovación (o se compran créditos extra, que no se hará).
- **Usar la web de SISTRIX no gasta créditos**; según su documentación, **descargar informes sí** (la asignación semanal es «para descargas de informes y datos de la API»). Exportar a mano desde la web no es más barato que la API.
- `credits` (consultar el saldo) no gasta.
- MCP: no gasta créditos, pero es para asistentes de IA, solo admite OAuth y su uso para alimentar un sistema automático no está previsto. No se usa.
- Con el control de presupuesto (bloqueo al llegar al límite fijado) el sistema **nunca** puede gastar más de lo que se fije, y lo fijado puede ser una parte pequeña de la asignación semanal, dejando el resto para el uso manual.

### 23.2. Importación manual de exportaciones de SISTRIX

- Search Console por API es **gratis** (no tiene créditos), así que su importación manual solo tiene sentido para lo anterior a 16 meses (§18.1 y §19.7).
- Se añade a la fase 2 la **importación de los CSV que exporta SISTRIX** (palabras de un dominio, palabras de una búsqueda, competidores), como alternativa o complemento a la API: útil si el presupuesto semanal se agota o para cargar datos que ya se tengan descargados.

## 24. PR 1 hecha (2026-11-26)

§24 PR 1 hecha: tablas `seo_projects`, `seo_project_domains`, `seo_gsc_metrics` (una para los diez cruces, con `grain`) y `seo_sync_runs`, con política de filas; migración de los datos de Search Console de «SEO local» (función `seo_migrate_search_console()`, las tablas antiguas se conservan); `SearchConsoleClient` ampliado (consulta con dimensiones, filtros, tipo de búsqueda y paginación, reintentos ante 429/5xx, propiedades y mapas del sitio; simulado en tests); cola `seo` con carga inicial de 16 meses reanudable por día, descarga diaria `seo.gsc-daily` y «Sincronizar ahora», cancelable; resumen desde el cruce `site` con comparación y búsquedas que Google no detalla (`packages/shared/src/seo`); extra `addon-seo-advanced` (199 €, incluye `local_seo`); panel admin → SEO → Proyectos (con los de los tenants en lectura) y Análisis → SEO Avanzado en el panel del tenant. Pendiente de esta fase: el panel con gráficos y comparativas, y la interfaz común de proveedores de §25 (hoy la descarga de Google va directa con `SeoGscSyncService`).

## 25. SISTRIX por MCP (decisión del 2026-11-25)

**Decidido por Jota**

- **Plataforma (`trasteros.pro`) y GUÁRDALO**: SISTRIX por **MCP** con la cuenta de Jota (OAuth, sin créditos), como proveedor principal. Se deja preparada también la **API clásica** con su clave, **desactivada por defecto**.
- Si el MCP agota su cuota diaria (error 7010), las consultas de ese proveedor se paran y se reanudan al día siguiente; el panel avisa y ofrece **«Continuar por API»**. Solo con esa autorización expresa se gastan créditos, con el presupuesto de §6 como tope.
- **Tenants**: SISTRIX **solo si ponen su propia clave de API**. Sin clave, solo Search Console. Su clave se guarda cifrada y nunca vuelve al navegador.

**Por qué los tenants no usan la cuenta de Jota**: las condiciones de SISTRIX prohíben ceder sus datos a terceros sin autorización escrita, y el MCP aplica la misma política de uso que la API.

**Arquitectura de proveedores** (sustituye al `SistrixProvider` único de §3):

- Interfaz común de proveedor SEO con capacidades declaradas (qué datos sabe dar cada uno).
- `GoogleSearchConsoleProvider` (PR 1 en curso), `SistrixMcpProvider` (cliente MCP propio con el SDK oficial `@modelcontextprotocol/sdk`, transporte HTTP, OAuth 2.0 con registro dinámico y PKCE, tokens cifrados con `CryptoService`, renovación automática y aviso de reautorización), `SistrixApiProvider` (clave de API, créditos y presupuesto) e importación manual (Excel de Search Console y CSV de SISTRIX).
- Un enrutador elige el proveedor por dato: MCP primero; si su cuota está agotada y hay autorización, API; si no, se espera.
- Cada dato guarda **de qué proveedor vino** (`gsc`, `sistrix_mcp`, `sistrix_api`, `manual_import`) y cuándo.
- Las herramientas del MCP **se descubren** con `tools/list` (nombres y parámetros no se dan por supuestos) y se guardan; un cambio de herramientas en el servidor se detecta y avisa.

**Pendiente**: resultados de la prueba de concepto (§26).

## 26. Dominios secundarios del tenant (decidido el 2026-11-26)

Un tenant puede añadir como dominio secundario una propiedad de Search Console que no sea suya «por la plataforma» (por ejemplo `trasterosmislata.es` en GUÁRDALO) si la cuenta de servicio tiene acceso a ella (alguien con permisos sobre la propiedad la ha añadido) y no la usa ningún otro proyecto ni es de la plataforma. Va en la PR siguiente.

## 27. PR 2 hecha (2026-11-26)

- **Dominio secundario de otra web (§26)**: el principal sigue siendo solo una web del negocio; un secundario que no lo es entra si la cuenta de servicio tiene acceso a su propiedad, no es de la plataforma (ni subdominio) y no lo usa ningún otro proyecto, de otro tenant o de la plataforma. Queda marcado (`verification = gsc_access`), no se puede pasar a principal y vuelve a comprobar sus condiciones en cada «Comprobar».
- **Importación de los Excel de Search Console (§18.1 y §19.7)**: `.xlsx` y `.zip` de CSV, en español e inglés, todas las pestañas. «Fechas» entra en el cruce `site` solo en los días que no tienen ni la API ni otra importación (marca `source` por fila; manda la API). El resto de pestañas, aparte (`seo_gsc_import_rows`), nunca repartidas por días. Filtros guardados y avisados (con filtro, no entra en los totales). Vista previa antes de confirmar, sin duplicados por huella del fichero, y borrar quita sus filas y sus días.
- **Panel con gráficos y comparativas (§6, §8 y §19.1)**: periodos de 7/28/90 días, 6/12 meses y a mano; periodo anterior y mismo periodo del año anterior; indicadores con variación; evolución diaria en gráficos de un solo eje (posición con el eje al revés); dispositivo, país (10 + resto) y tipo de búsqueda; búsquedas y páginas con variación, buscador, orden, páginas, CSV y cruce búsqueda ↔ página; selector de dominio sin mezclar y lo que llega por los secundarios; fecha de los últimos datos y aviso de retraso; en el admin, vista global de los 28 días de cada proyecto. Todo con agregaciones en SQL sobre un único cruce cada vez.
- **Decisiones**: la importación sube el fichero dos veces (vista previa y confirmación) en vez de guardarlo entre una y otra; la comparación «hay datos» exige datos desde el primer día del periodo comparado; las importaciones en el admin solo van en los proyectos de la plataforma (los de los tenants, en lectura).
- **Pendiente** (siguientes PR): SISTRIX (MCP y API), palabras clave, competencia, oportunidades, canibalización, indexación, actuaciones, conversiones e informes.

## 28. Prueba de concepto de SISTRIX por MCP (2026-11-25)

Hecha con un cliente propio (SDK oficial `@modelcontextprotocol/sdk` 1.32.2, transporte HTTP), sin ningún asistente de IA, contra `https://api.sistrix.com/mcp/` con la cuenta de Jota. 16 consultas, ninguna de pago.

**Conexión**

- Descubrimiento OAuth completo (`/.well-known/oauth-protected-resource/mcp` → servidor de autorización `https://api.sistrix.com/mcp`), registro dinámico, PKCE S256, `authorization_code` + `refresh_token`, ámbito `sistrix`.
- **Peculiaridad**: al canjear el código, SISTRIX rechaza la petición si lleva `redirect_uri` («did not match») y la acepta sin él. El SDK lo manda siempre → nuestro cliente debe quitarlo de esa petición (envoltorio de `fetch`).
- Token de acceso de 1 h; la renovación funciona sola y **rota el refresh token** (el anterior deja de valer) → guardar el nuevo de forma atómica y con un bloqueo para que dos procesos no renueven a la vez.
- Los tokens se guardan cifrados y la conexión sobrevive a reinicios (cada consulta de la prueba fue un proceso nuevo).

**Herramientas descubiertas (11)**: `domain` (visindex, visindex_overview, kwcount, kwcount_top10, urlcount, competitors, ideas, opportunities, ranking_distribution, traffic_estimation, hosts, paths), `keyword` (seo, metrics, traffic, competition, searchintent, serpfeatures, traffic_estimation, questions), `keyword_domain_seo`, `links` (list, linktexts, linktargets), `project`, `project_onpage` (Optimizer: no se usan), `ai_check`, `ai_topicresearch` (su vista `list` dice gastar 1 crédito por tema: excluida), `ai_tracker_overview`, `ai_tracker`, `ai_prompt_answers`.

**Cobertura de lo pedido**: visibilidad actual e histórica (semanal o diaria) ✔ · palabras posicionadas de un dominio con posición y URL ✔ · competidores orgánicos ✔ (solo nombres de dominio) · palabras de cada competidor ✔ · volumen (estimado, `traffic`) ✔ · competencia ✔ · CPC ✔ · intención (porcentajes saber/hacer/visitar/web) ✔ · resultados orgánicos de una palabra ✔ · oportunidades ✔ · backlinks ✔ · dominios enlazantes: parcial (recuento por URL en `linktargets`) · visibilidad en buscadores de IA ✔ (`ai_check`).

**Datos**: `guardalobox.es` y `trasteros.pro` tienen visibilidad 0 y SISTRIX no tiene palabras suyas (error 1000 «no result»): son demasiado pequeñas para su muestra. Para nuestros dominios, posiciones y tráfico salen de Search Console; SISTRIX aporta sobre todo competencia, métricas de palabras y resultados de búsqueda. Un competidor (trasterosalmirante.es) sí devuelve palabras con posición y URL.

**Formato**: unas herramientas devuelven `structuredContent` y otras solo texto con JSON; los errores llegan como texto con `isError: false` («SISTRIX API Error (1000): no result»); el valor de visibilidad viene a veces como texto y a veces como número; nombres de campo en alemán (`sichtbarkeitsindex`); el país por defecto es `de` (hay que pasar siempre `es`). → un normalizador por herramienta y vista.

**Rendimiento**: 1,7 s de media por consulta (máx. 4,6 s). Sin errores de cuota en 16 consultas; no hay contador de uso.

**Condiciones**: MCP incluido en todos los planes y sin créditos; misma política de uso razonable que la API; al agotar la cuota diaria, error 7010 hasta el día siguiente; su documentación dice que «para volúmenes grandes y regulares la vía prevista es la API clásica».

## 29. PR 3 hecha (2026-11-26)

SISTRIX por MCP (principal) y por API clásica (preparada y desactivada), con arquitectura de proveedores (`SeoDataProvider` con capacidades: `gsc` —envuelve la descarga de la PR 1 sin cambiarla—, `sistrix_mcp`, `sistrix_api`, `manual_import`) y un enrutador: MCP con cuota → API solo con «Continuar por API» autorizado, activada y con presupuesto → esperar con el motivo. Cliente MCP propio con el SDK oficial (OAuth con registro dinámico, PKCE, `state` firmado de un solo uso, canje sin `redirect_uri`, tokens cifrados, renovación con `pg_advisory_xact_lock` porque el refresh token rota, `invalid_grant` → volver a conectar con aviso), catálogo de herramientas con aviso de cambios, normalizador probado con las 16 respuestas reales (texto o `structuredContent`, 1000 vacío, 7010 cuota, números como texto, `sichtbarkeitsindex`) y servidor simulado. Cliente de la API clásica (`fetch`, 300 ms, créditos por respuesta, `credits` antes de cada tanda, presupuesto semanal con corte duro). Datos por «fondo» (el dueño de la conexión): competidores, palabras del proyecto (con `strategy_locked` para la importación futura), métricas de palabras (histórico), visibilidad y recuentos de dominios, palabras de cada dominio con su histórico, resultados de Google, oportunidades e ideas, páginas enlazadas y visibilidad en IA, con registro de peticiones y caché que deduplica entre proyectos. Cola `seo-sistrix` (concurrencia 1, pausa entre llamadas, reanudación) y crons de programación, reanudación a las 00:05 y diario. Pantallas: Panel admin → SEO → Integraciones; en la ficha del proyecto y en la página del tenant, Competidores, Palabras clave, Oportunidades, Enlaces y Visibilidad en IA; clave de API propia del tenant; «Usar la conexión de SISTRIX de la plataforma» en proyectos de tenant (solo superadmin).

Decisiones de la implementación: cola aparte `seo-sistrix` (dos procesadores en la misma cola `seo` se quitarían los trabajos); las frecuencias y límites son por fondo (`seo_sync_settings`), no por proyecto; los competidores descubiertos entran como sugerencia (inactivos, no cuentan para el límite); la API clásica no tiene equivalente para `ai_check` (ese dato espera al MCP). Pendiente: comprobar en la primera llamada real el formato exacto de la API clásica (los nombres de los métodos y la lectura de créditos siguen su documentación, sin haberla llamado) y del MCP con volumen.

## 30. PR 4 hecha (2026-11-26)

Motor de oportunidades propio, con reglas y no IA (§9, §18.6 y §19.3). La lógica es pura y está en `packages/shared/src/seo/opportunities.ts` (vitest); el API reúne los datos con agregaciones SQL (`SeoOpportunityEngineService`) y los guarda en `seo_opportunities`.

**Tipos**

| Tipo                           | Regla (umbral por defecto, editable por proyecto)                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cerca del top 3                | posición media 4–10 y ≥ 50 impresiones en 28 días                                                                                                                             |
| A un paso de la primera página | posición 11–20 y ≥ 50 impresiones                                                                                                                                             |
| Comercial lejos                | posición 21–50, ≥ 10 impresiones e intención de contratar o de ir a un sitio                                                                                                  |
| Mucho aparecer y poco clic     | posición ≤ 20, ≥ 100 impresiones y CTR por debajo de la mitad del esperado (`expectedCtr`)                                                                                    |
| Sube / Baja                    | periodo anterior comparable (`seoPeriodCovered`), ≥ 30 impresiones en los dos y ≥ 3 puestos de cambio (o ≥ 50 % de impresiones con la posición a favor)                       |
| Demanda real frente a SISTRIX  | impresiones reales (≥ 20) y volumen 0 o sin dato en SISTRIX; impresiones por encima del volumen; o volumen ≥ 500 y tus impresiones < 5 % del volumen (también si ni apareces) |
| Oportunidad de SISTRIX         | `seo_domain_opportunities` que no coinciden con una propia (si coinciden, se fusionan y se marcan los dos orígenes)                                                           |
| La competencia sale y tú no    | un competidor seguido en el top 20 y tu web no sale ni en Search Console (90 días) ni en SISTRIX                                                                              |

- Intención (§18.3): la manual de tus palabras, luego la dominante de SISTRIX y, si no, reglas sobre el texto («precio», «alquilar», «barato» → contratar; «qué es», «cómo» → informarse; «cerca», «horario» → ir a un sitio). Comercial = contratar o ir a un sitio (en un negocio local, «trasteros valencia» es de visita).
- Marca (`brandTerms`, `isBrandQuery`): fuera, salvo que caiga.
- «Sin dato» en SISTRIX solo cuenta en tus palabras y si el proyecto ya tiene métricas de SISTRIX (si no, sería todo).

**Puntuación (0–100)**

Factores (0–1) y pesos por defecto, editables en `seo_projects.weights`:

- Demanda 25 %: impresiones reales en escala logarítmica (5.000 = 1) o, sin ellas, lo que da SISTRIX: el volumen (10.000 = 1) o las visitas que estima ganar (1.000 = 1), el mayor de los dos.
- Cerca del premio 20 %: 4–10 → 1 a 0,82; 11–20 → 0,75 a 0,48; 21–50 → 0,4 a 0,11; top 3 → 0,3; más allá o sin posición → 0,1.
- Clics perdidos 20 %: (CTR esperado − CTR real) ÷ CTR esperado.
- Intención comercial 15 %: contratar 1; ir a un sitio 0,8; buscar una web 0,3; informarse 0,2.
- Prioridad en tus palabras 10 %: alta 1, media 0,5, baja 0,2.
- Tendencia 10 %: 0,7 · mín(1, |puestos| ÷ 10) + 0,3 · mín(1, |% impresiones| ÷ 100), solo con periodos comparables.
- Dificultad 10 % (resta): competencia de SISTRIX ÷ 100.

```
base       = Σ peso·valor / Σ peso        (un factor que no se sabe vale 0,3)
bruto      = max(0, base − peso_dificultad · dificultad)
confianza  = 0,9 Google y SISTRIX · 0,75 solo Google · 0,45 solo SISTRIX · 0,2 nada
             (−0,15 con menos de 30 impresiones; +0,1 con periodo anterior comparable)
puntuación = round(100 · bruto · (0,4 + 0,6 · confianza))
```

Un factor que no se sabe cuenta con un valor neutro-bajo (0,3, `SEO_UNKNOWN_FACTOR_VALUE`) en vez de desaparecer, y además baja la confianza, que pesa el 60 % del ajuste final. Así una oportunidad con pocos datos no sube por encima de una respaldada por Google: con posición e intención parecidas, la de datos reales siempre puntúa más (hay una prueba con el caso real «alquiler trasteros», Google, posición 9,3 y 700 impresiones → 48, frente a «alquiler trastero mensual», solo SISTRIX, posición 11 y 66 visitas estimadas → 38; con la regla anterior, de repartir el peso de lo desconocido, salían 54 y 70). El desglose guarda los puntos de cada factor, también los desconocidos (suman la puntuación).

**Ciclo de vida**: clave estable (sha1 de tipo + dominio + búsqueda); estados nueva, vista, en curso, hecha y descartada (con motivo); asignación (equipo del tenant o super admins) y notas. Recalcular actualiza cifras, motivo y puntuación sin tocar estado, notas ni asignación; lo que deja de cumplirse queda «inactivo» (sale de pendientes). Una descartada vuelve como nueva («ha vuelto») si su puntuación sube 20 puntos (`reappearPoints`) sobre la que tenía al descartarla. Se recalcula tras cada descarga de Search Console, tras las tandas de SISTRIX de oportunidades, palabras de dominios y métricas (job `opportunities` en la cola `seo`, a los 60 s y uno por proyecto) y con «Recalcular ahora».

**Pantallas**: tarjeta «Oportunidades» en la ficha del proyecto (admin) y en SEO Avanzado del tenant, con resumen por tipo y estado y las 5 mejores, filtros (tipo, estado, puntuación, búsqueda, dominio), orden, CSV, acciones rápidas, ficha lateral (por qué, sus datos con origen y fecha, evolución de 90 días, páginas, resultados de Google, gestión) y ajustes de pesos y umbrales con «Restaurar por defecto». Las oportunidades de SISTRIX salen en esta lista; en la parte de SISTRIX la pestaña pasa a «Ideas de palabras».

**Decisiones**: los pesos de §9 se guardan con los nombres que ya tenía `seo_projects.weights` (`impressions`, `position`, `ctrGap`, `business`, `trend`) más `priority` y `difficulty`; una búsqueda puede dar varias oportunidades (son acciones distintas); la página que sale no forma parte de la clave (cambia con el tiempo); las rutas nuevas van en `…/opportunity-engine` para no romper `…/opportunities` de la PR 3.

**Pendiente** (PR 5): canibalización, páginas que no deberían estar indexadas, URL objetivo frente a la que enseña Google, cubo diario de palabras seguidas y alta de palabras desde Search Console o CSV.

## 31. PR 5 hecha — fase 2 completa (2026-11-26)

Diagnóstico (§18.2–§18.5, §18.7, §19.2 y §19.5). Lo puro en `packages/shared/src/seo/diagnostics.ts` (vitest); el API suma con SQL (`SeoDiagnosticsEngineService`) y guarda en `seo_cannibalizations` y `seo_index_findings`.

**Palabras seguidas (§18.2–§18.4)**

- Alta desde Search Console (búsquedas reales del periodo con impresiones mínimas, posición máxima, sin marca y sin las ya seguidas; selección múltiple con grupo, prioridad e intención), desde CSV o Excel (el lector del importador general; columnas palabra, grupo, intención, URL objetivo, prioridad y notas; vista previa; **nunca pisa**: las fijadas no se tocan y en las demás solo se rellena lo vacío, campo a campo con la condición de que siga vacío; la prioridad solo en las nuevas, porque siempre tiene valor y no se sabe si fue una decisión) y desde las oportunidades («Seguir esta palabra» en su ficha) y las ideas de SISTRIX (ya estaba). Límites de 300 (tenant) y 2.000 (plataforma).
- Evolución de cada palabra desde `seo_gsc_metrics` sin tabla nueva: posición, clics, impresiones y CTR por día (cruce `query`), la página ganadora de cada día y sus cambios (`query_page`), por dispositivo y por país, y la posición de SISTRIX como serie aparte marcada como estimación.
- Intención con la función de la PR 4 (manual > SISTRIX > reglas) y vista agrupada por intención y por grupo con clics, impresiones, CTR y posición ponderada.
- URL objetivo frente a la que enseña Google: `ok` (se lleva ≥ 60 % de las impresiones), `other_page` (otra y la tuya < 20 %), `split`, `none` y `no_target` con la URL propuesta (la de más clics), que se acepta con un clic. URL normalizadas (protocolo, `www`, barra final, mayúsculas y parámetros de seguimiento).
- Una sola vista: la pestaña «Palabras clave» de SISTRIX pasa a esta (sus métricas salen en ella con su origen).

**Canibalización (§18.5 y §19.2)**: cruce consulta + página de 28 días (o los que se configuren): dos o más páginas propias (variantes juntas) con al menos el 10 % y 10 impresiones, o la página ganadora que cambia 3 veces o más. Sin marca. Tipos de §19.2: conflicto (alternancia), cambio de página (estable 7 días), convivencia (las dos en la primera página) y reparto. Gravedad: alta si se alternan y la segunda se lleva ≥ 25 %; baja en el caso esperado (URL objetivo + portada por debajo del 25 %) y en la convivencia. Motivo y acción (consolidar, diferenciar, enlazar, canónica o redirigir, marcar URL objetivo) en palabras.

**Indexación (§18.7 y §19.5)**: reglas por proyecto, por defecto las de la propia web (`WEB_NOINDEX_PREFIXES` y `ROBOTS_PRIVATE_PATHS`, movidas a shared y usadas por el middleware, `robots.txt` y aquí) más lo técnico, borradores y parámetros; hallazgos de las páginas con impresiones (cruce `page`, todo lo guardado) que casan con una regla, variantes duplicadas y lo que sale por un dominio que debería redirigir. Siempre «Aparece en el rendimiento de Search Console», nunca «indexación confirmada» (la inspección de URL va en la fase 4, y la pantalla lo dice).

**Decisiones**

- Canibalización e indexación en tablas propias y no como tipos de `seo_opportunities`: su forma es otra (varias páginas con su reparto y la ganadora de cada día; gravedad en vez de puntuación; categoría y regla), tienen sus propios umbrales y no deben mezclarse con la lista por puntuación. El ciclo de vida sí es el de las oportunidades; una arreglada vuelve como nueva si Google la sigue enseñando después de darla por arreglada.
- Mapas del sitio: solo lo que da la API de Search Console (`listSitemaps`: URL enviadas, avisos y errores). El contenido de cada mapa no se descarga: sería pedir desde nuestro servidor una dirección que pone el cliente; la lista de lo indexado llega con la inspección de URL y el rastreador.
- Las palabras seguidas se ven por dominio (el principal por defecto): cada pantalla lee de un cruce y nunca suma dominios.

**Criterios del MVP (§14) que quedan cumplidos con la fase 2**: proyectos con Search Console e histórico; panel con comparativas; SISTRIX con control de créditos; palabras clave con intención, grupo y URL objetivo; competencia; oportunidades con motivo y puntuación; canibalización e indexación como «a revisar» con su estado. De los añadidos: 15 (los totales salen siempre del cruce `site`), 16 y 17 (presupuesto de SISTRIX y panel que sigue con lo guardado, PR 3) y 18 (una posición que no hay sale «—», nunca 0, también en las palabras seguidas). Quedan para las fases 3 y 4: actuaciones con antes y después, conversiones, informes y alertas, importación de los Excel maestros, inspección de URL, rastreador y PageSpeed.
