import type { TodaySnoozeKind } from '@storageos/shared';

/**
 * «Huella» de un aviso de «Hoy»: cómo estaba cuando se apartó. Si al volver a
 * calcular la bandeja ha empeorado (el cliente vuelve a escribir, sube la
 * deuda, caen más dispositivos…), el aviso sale aunque siga apartado. Los tipos
 * sin huella no cambian: siguen ocultos hasta que vence el apartado.
 */
export type TodayFingerprint = Record<string, string | number | boolean>;

const PRIORITY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

type Item = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const time = (v: unknown): number => {
  const t = Date.parse(str(v));
  return Number.isNaN(t) ? 0 : t;
};

/** Huella del aviso tal como sale ahora en la bandeja (null = el tipo no tiene). */
export function todayFingerprintOf(kind: TodaySnoozeKind, item: object): TodayFingerprint | null {
  const i = item as Item;
  switch (kind) {
    case 'ticket':
      return {
        lastTenantMessageAt: str(i.lastTenantMessageAt),
        priority: PRIORITY_RANK[str(i.priority)] ?? 0,
      };
    case 'past_due':
      return { owedAmount: num(i.owedAmount), owedPeriods: num(i.owedPeriods) };
    case 'webhook':
      return { failedCount: num(i.failedCount), lastFailedAt: str(i.lastFailedAt) };
    case 'device':
    case 'aeat':
    case 'holded':
    case 'rgpd':
    case 'invoice_data':
      return { count: num(i.count) };
    case 'addon_charge':
      return { nextChargeAt: str(i.nextChargeAt) };
    case 'certificate':
      return { expired: num(i.daysLeft) <= 0 };
    case 'renewal':
      return { overdue: num(i.daysLeft) < 0 };
    default:
      return null;
  }
}

const MORE: Partial<Record<TodaySnoozeKind, string>> = {
  device: 'Hay más dispositivos sin conexión',
  aeat: 'Hay más facturas con problemas en Veri*Factu',
  holded: 'Hay más envíos a Holded para revisar',
  rgpd: 'Hay más solicitudes RGPD fuera de plazo',
  invoice_data: 'Hay más facturas sin NIF o domicilio',
};

/**
 * Motivo por el que un aviso apartado vuelve a salir, o null si sigue igual (o
 * mejor). Sin huella guardada (apartados antiguos o tipos sin huella) no vuelve.
 */
export function todayReappearReason(
  kind: TodaySnoozeKind,
  saved: unknown,
  current: TodayFingerprint | null,
): string | null {
  if (!saved || typeof saved !== 'object' || !current) return null;
  const old = saved as Item;
  switch (kind) {
    case 'ticket':
      if (time(current.lastTenantMessageAt) > time(old.lastTenantMessageAt)) {
        return 'El cliente ha vuelto a escribir';
      }
      return num(current.priority) > num(old.priority) ? 'Ha subido de prioridad' : null;
    case 'past_due':
      return num(current.owedAmount) > num(old.owedAmount) + 0.005 ||
        num(current.owedPeriods) > num(old.owedPeriods)
        ? 'La deuda ha subido'
        : null;
    case 'webhook':
      return time(current.lastFailedAt) > time(old.lastFailedAt) ||
        num(current.failedCount) > num(old.failedCount)
        ? 'Hay entregas fallidas nuevas'
        : null;
    case 'device':
    case 'aeat':
    case 'holded':
    case 'rgpd':
    case 'invoice_data':
      return num(current.count) > num(old.count) ? (MORE[kind] ?? null) : null;
    case 'addon_charge':
      return time(current.nextChargeAt) > time(old.nextChargeAt) ? 'Toca otro cobro' : null;
    case 'certificate':
      return current.expired === true && old.expired !== true ? 'El certificado ha caducado' : null;
    case 'renewal':
      return current.overdue === true && old.overdue !== true
        ? 'La renovación ya ha vencido'
        : null;
    default:
      return null;
  }
}
