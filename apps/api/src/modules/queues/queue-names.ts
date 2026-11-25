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

/** Job de envío de un email ad-hoc (broadcasts del super admin). */
export const JOB_EMAIL_SEND = 'email.send';

/** Exportación de los datos de un tenant pedida por el super admin (cola `reports`). */
export const JOB_TENANT_DATA_EXPORT = 'tenant-data-export';
