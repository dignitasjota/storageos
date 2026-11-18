/**
 * Reparto de un cobro de la suscripción entre el plan y cada extra, sin IVA y
 * sin lo devuelto. Es la base del % de comisión: el plan cuenta siempre y cada
 * extra solo si su comisión está aprobada.
 *
 * - Con el desglose de su factura (líneas), se usa tal cual.
 * - Un cobro «Add-on: X» es todo de ese extra.
 * - La remesa SEPA y Redsys cobran el plan y los extras que no van por Stripe
 *   en un solo cargo: se reparte según el precio de cada uno.
 * - Un cobro de Stripe sin desglose, igual con los extras que van por Stripe.
 * - El resto (pago a mano del plan) es todo del plan.
 */

export interface SplitAddon {
  addonId: string;
  name: string;
  /** Precio de lista al mes (precio × cantidad). */
  monthly: number;
  billingMode: string;
}

export interface SplitPaymentInput {
  gross: number;
  refunded: number;
  taxRate: number;
  provider: string;
  description: string | null;
  lines: { kind: string; description: string; total: number }[];
  planMonthly: number;
  addons: SplitAddon[];
}

export interface SplitPaymentResult {
  planNet: number;
  addons: { addonId: string; net: number }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const ADDON_PREFIX = 'Add-on:';

function matchAddon(addons: SplitAddon[], text: string): SplitAddon | undefined {
  const name = (text.startsWith(ADDON_PREFIX) ? text.slice(ADDON_PREFIX.length) : text)
    .trim()
    .toLowerCase();
  return addons.find((a) => a.name.trim().toLowerCase() === name);
}

export function splitPaymentForCommission(p: SplitPaymentInput): SplitPaymentResult {
  if (!(p.gross > 0)) return { planNet: 0, addons: [] };
  const kept = Math.max(0, p.gross - Math.max(0, p.refunded)) / p.gross;
  const net = (grossPart: number) => (grossPart / (1 + p.taxRate / 100)) * kept;
  const addonNet = new Map<string, number>();
  const add = (id: string, value: number) => addonNet.set(id, (addonNet.get(id) ?? 0) + value);
  let planNet = 0;

  const hasAddonLines = p.lines.some((l) => l.kind === 'addon');
  if (p.lines.length > 1 || hasAddonLines) {
    for (const line of p.lines) {
      if (line.kind === 'addon') {
        const addon = matchAddon(p.addons, line.description);
        // Un extra que no se reconoce no suma (no se puede aprobar su comisión).
        if (addon) add(addon.addonId, net(line.total));
      } else {
        planNet += net(line.total);
      }
    }
  } else if ((p.description ?? '').startsWith(ADDON_PREFIX)) {
    const addon = matchAddon(p.addons, p.description ?? '');
    if (addon) add(addon.addonId, net(p.gross));
  } else {
    const shared =
      p.provider === 'sepa' || p.provider === 'redsys'
        ? p.addons.filter((a) => a.billingMode !== 'stripe')
        : p.provider === 'stripe'
          ? p.addons.filter((a) => a.billingMode === 'stripe')
          : [];
    const addonsTotal = shared.reduce((s, a) => s + Math.max(0, a.monthly), 0);
    const total = Math.max(0, p.planMonthly) + addonsTotal;
    if (shared.length === 0 || total <= 0) {
      planNet = net(p.gross);
    } else {
      planNet = net(p.gross) * (Math.max(0, p.planMonthly) / total);
      for (const a of shared) add(a.addonId, net(p.gross) * (Math.max(0, a.monthly) / total));
    }
  }

  return {
    planNet: round2(planNet),
    addons: [...addonNet.entries()].map(([addonId, value]) => ({ addonId, net: round2(value) })),
  };
}

/** Base de la comisión: el plan y los extras aprobados. */
export function commissionBase(split: SplitPaymentResult, approvedAddonIds: Set<string>): number {
  return round2(
    split.planNet +
      split.addons.filter((a) => approvedAddonIds.has(a.addonId)).reduce((s, a) => s + a.net, 0),
  );
}

/** Reparto guardado de un cobro, escalado a lo que queda tras las devoluciones. */
export function scaleSplit(split: SplitPaymentResult, kept: number): SplitPaymentResult {
  const k = Math.max(0, Math.min(1, kept));
  return {
    planNet: round2(split.planNet * k),
    addons: split.addons.map((a) => ({ addonId: a.addonId, net: round2(a.net * k) })),
  };
}

/** Lee un reparto guardado (JSON) o null si no tiene la forma esperada. */
export function parseSplit(value: unknown): SplitPaymentResult | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { planNet?: unknown; addons?: unknown };
  if (typeof v.planNet !== 'number' || !Array.isArray(v.addons)) return null;
  const addons = v.addons.filter(
    (a): a is { addonId: string; net: number } =>
      !!a &&
      typeof (a as { addonId?: unknown }).addonId === 'string' &&
      typeof (a as { net?: unknown }).net === 'number',
  );
  return { planNet: v.planNet, addons };
}
