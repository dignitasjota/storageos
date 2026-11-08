/**
 * Control de flujo de los envíos a la AEAT (art. 16.2 de la Orden
 * HAC/1177/2024 y apdo. 6.4.4.1 de la descripción del servicio web): tras cada
 * envío hay que esperar los segundos que diga la AEAT («TiempoEsperaEnvio», 60
 * al principio) o a tener acumulados 1.000 registros, lo que ocurra antes. En
 * un envío solo van registros de un mismo obligado tributario, así que cada
 * emisor (el negocio o cada propietario) lleva su propia espera.
 */

/** Registros que caben en un envío (diseño de registro del anexo, apdo. 2.2). */
export const MAX_RECORDS_PER_SUBMISSION = 1000;

/** Espera inicial entre envíos, mientras la AEAT no diga otra (art. 16.2). */
export const DEFAULT_WAIT_SECONDS = 60;

/** Un envío fallido se reintenta con espera creciente, como mucho cada hora (art. 16.4). */
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/** Lo que un envío reserva al emisor: si el proceso se cae, otro lo retoma pasado este tiempo. */
export const SEND_LEASE_MS = 5 * 60 * 1000;

/** `self` (el propio negocio) o el id del propietario. */
export function emitterKey(ownerId: string | null): string {
  return ownerId ?? 'self';
}

/** Espera tras `failures` envíos fallidos seguidos: 1, 2, 4… minutos, como mucho una hora. */
export function retryDelayMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(60_000 * 2 ** Math.min(n - 1, 20), MAX_RETRY_DELAY_MS);
}

/** `TiempoEsperaEnvio` de una respuesta (de 0 a 9999 segundos); sin un valor válido, 60. */
export function parseWaitSeconds(value: string | null | undefined): number {
  const v = value?.trim() ?? '';
  return /^\d{1,4}$/.test(v) ? Number(v) : DEFAULT_WAIT_SECONDS;
}

/**
 * Desde cuándo puede salir el siguiente envío del emisor: tras un fallo, el
 * reintento; y la espera de la AEAT, salvo con 1.000 registros acumulados.
 * Null = ya.
 */
export function sendableAt(
  state: { nextSendAt: Date | null; retryAt: Date | null },
  pendingCount: number,
): Date | null {
  const times: Date[] = [];
  if (state.retryAt) times.push(state.retryAt);
  if (state.nextSendAt && pendingCount < MAX_RECORDS_PER_SUBMISSION) times.push(state.nextSendAt);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

/**
 * Id del trabajo de la cola: uno por emisor y hora de salida, así que las
 * facturas que se emiten mientras se espera van todas en el mismo envío.
 */
export function sendJobId(tenantId: string, ownerId: string | null, runAt: Date): string {
  return `vf-${tenantId}-${emitterKey(ownerId)}-${runAt.getTime()}`;
}
