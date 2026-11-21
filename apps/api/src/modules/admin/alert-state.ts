import type { PrismaAdminService } from '../database/prisma-admin.service';

/**
 * Reserva un aviso: devuelve `true` si no se ha enviado en los últimos
 * `minutes`. Vive en la base de datos para no repetirlo entre réplicas ni al
 * reiniciar.
 */
export async function claimAlert(
  admin: PrismaAdminService,
  kind: string,
  identifier: string,
  minutes: number,
): Promise<boolean> {
  const rows = await admin.$queryRaw<Array<{ kind: string }>>`
    INSERT INTO security_alert_states (kind, identifier, last_sent_at)
    VALUES (${kind}, ${identifier}, now())
    ON CONFLICT (kind, identifier) DO UPDATE SET last_sent_at = now()
    WHERE security_alert_states.last_sent_at < now() - make_interval(mins => ${minutes}::int)
    RETURNING kind`;
  return rows.length > 0;
}

/** ¿Se avisó de esto en los últimos `minutes`? Solo mira, no reserva. */
export async function alertSentWithin(
  admin: PrismaAdminService,
  kind: string,
  identifier: string,
  minutes: number,
): Promise<boolean> {
  const rows = await admin.$queryRaw<Array<{ kind: string }>>`
    SELECT kind FROM security_alert_states
    WHERE kind = ${kind} AND identifier = ${identifier}
      AND last_sent_at >= now() - make_interval(mins => ${minutes}::int)`;
  return rows.length > 0;
}

/** Anota que se avisó de esto ahora (sin condiciones). */
export async function markAlertSent(
  admin: PrismaAdminService,
  kind: string,
  identifier: string,
): Promise<void> {
  await admin.$executeRaw`
    INSERT INTO security_alert_states (kind, identifier, last_sent_at)
    VALUES (${kind}, ${identifier}, now())
    ON CONFLICT (kind, identifier) DO UPDATE SET last_sent_at = now()`;
}
