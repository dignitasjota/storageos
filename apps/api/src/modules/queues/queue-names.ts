/**
 * Nombres de las colas BullMQ, en fichero propio SIN imports para que
 * cualquier provider registrado dentro de `QueuesModule` (p.ej.
 * `WorkersHeartbeatCron`) pueda importarlos sin crear un ciclo
 * queues.module → provider → queues.module (el ciclo deja la constante
 * `undefined` en el decorador `@InjectQueue` y Nest resuelve la cola
 * "default" inexistente). `queues.module.ts` los re-exporta, asi que el
 * resto del codigo puede seguir importando de alli.
 */
export const QUEUE_BILLING = 'billing';
export const QUEUE_DUNNING = 'dunning';
export const QUEUE_PAYMENTS = 'payments';
export const QUEUE_VERIFACTU = 'verifactu';
export const QUEUE_EMAIL = 'email';
export const QUEUE_COMMUNICATIONS = 'communications';
export const QUEUE_AUTOMATIONS = 'automations';
export const QUEUE_REPORTS = 'reports';
export const QUEUE_WEBHOOKS = 'webhooks';
/** Descargas de SEO Avanzado (Search Console). */
export const QUEUE_SEO = 'seo';

/** Una descarga de Search Console de un dominio (`seo_sync_runs`). */
export const JOB_SEO_GSC_SYNC = 'gsc-sync';
/** Recalcular las oportunidades de un proyecto de SEO Avanzado (cola `seo`). */
export const JOB_SEO_OPPORTUNITIES = 'opportunities';
/** Atender la cola de inspecciones de URL de un proyecto (cola `seo`, con pausa entre llamadas). */
export const JOB_SEO_INSPECTIONS = 'url-inspections';
/** Atender las mediciones de PageSpeed pendientes de un proyecto (cola `seo`). */
export const JOB_SEO_PAGESPEED = 'pagespeed';
/** Descargar el tráfico orgánico de GA4 de un proyecto (cola `seo`, PR 12). */
export const JOB_SEO_GA4 = 'ga4-sync';
/**
 * SEO Avanzado: tandas de SISTRIX (MCP o API). Cola aparte de `seo` porque va
 * con concurrencia 1 y pausa entre llamadas (dos procesadores en la misma cola
 * se quitarían los trabajos el uno al otro).
 */
export const QUEUE_SEO_SISTRIX = 'seo-sistrix';
/** Una tanda de SISTRIX de un proyecto y tipo de dato (`seo_sync_runs`). */
export const JOB_SEO_SISTRIX_SYNC = 'sistrix-sync';
/**
 * SEO Avanzado, PR 10: rastreos de las webs de los proyectos. Cola aparte de
 * `seo` porque un rastreo dura minutos (con pausa entre peticiones) y no debe
 * retrasar las descargas de Search Console. Concurrencia 2: dos proyectos a la
 * vez como mucho, cada uno con una sola petición en marcha.
 */
export const QUEUE_SEO_CRAWL = 'seo-crawl';
/** Un rastreo (`seo_crawls`). */
export const JOB_SEO_CRAWL = 'crawl';

/** Job de envío de un email ad-hoc (broadcasts del super admin). */
export const JOB_EMAIL_SEND = 'email.send';

/** Exportación de los datos de un tenant pedida por el super admin (cola `reports`). */
export const JOB_TENANT_DATA_EXPORT = 'tenant-data-export';
