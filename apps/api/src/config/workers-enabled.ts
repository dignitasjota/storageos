/**
 * Flag global que controla si el proceso actual debe registrar los workers
 * BullMQ (`@Processor`) y los crons (`@Cron`) declarados por los modulos.
 *
 * Sub-bloque 14A.1: a partir de la separacion `apps/worker`, el API en
 * produccion deja de ejecutar los workers/crons (para evitar que un cron
 * se dispare DOS veces — una vez en API y otra en worker — provocando
 * duplicados de facturas, emails, etc.). El control se hace via env var
 * `ENABLE_WORKERS_IN_API`:
 *
 *  - `true` (default): el API ejecuta Processors y Crons in-process. Util
 *    para dev/test donde no levantamos `apps/worker` aparte.
 *  - `false`: el API queda HTTP-only. `apps/worker` debe estar corriendo
 *    para procesar los jobs encolados; si no, los jobs se acumulan en
 *    Redis hasta que un worker se conecte.
 *
 * IMPORTANTE: leemos `process.env` DIRECTAMENTE en este modulo (sin
 * `ConfigService`) porque la constante se consume dentro de los
 * `@Module({ providers: [...] })` decorators, que se evaluan ANTES de
 * que NestJS instancie el contenedor DI. `ConfigService` aun no existe
 * en ese momento.
 *
 * `apps/worker/src/main.ts` fija `process.env.ENABLE_WORKERS_IN_API='true'`
 * antes de cualquier import para garantizar que, cuando carga los Modules
 * del API, esta constante se evalua a `true` independientemente del
 * `.env.prod` (que tiene `ENABLE_WORKERS_IN_API=false` para el proceso
 * API).
 */
export const WORKERS_ENABLED_IN_API: boolean = process.env.ENABLE_WORKERS_IN_API !== 'false';
