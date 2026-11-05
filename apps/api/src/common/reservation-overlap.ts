/** ¿El error es la restricción de solape entre reservas de un mismo trastero? */
export function isReservationOverlap(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: string;
    message?: string;
    meta?: { constraint?: string; cause?: string };
  };
  const constraintName = typeof e.meta?.constraint === 'string' ? e.meta.constraint : '';
  const cause = typeof e.meta?.cause === 'string' ? e.meta.cause : '';
  const message = typeof e.message === 'string' ? e.message : '';
  // Postgres lanza SQLSTATE 23P01 (exclusion_violation). Prisma puede
  // mapearlo a varios codigos segun la version. Cubrimos los conocidos.
  if (e.code === 'P2010') return true;
  if (constraintName.includes('overlap') || constraintName.includes('no_overlap')) return true;
  if (cause.includes('23P01') || message.includes('23P01')) return true;
  if (message.includes('reservations_no_overlap_exclude')) return true;
  return false;
}
