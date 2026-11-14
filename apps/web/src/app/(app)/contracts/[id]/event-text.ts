import type { ContractEventDto } from '@storageos/shared';

import { formatDate, formatEur } from '@/lib/format';

const EVENT_LABELS: Record<string, string> = {
  created: 'Creado',
  signed: 'Firmado',
  price_changed: 'Precio modificado',
  unit_changed: 'Cambio de trastero',
  paused: 'Pausado',
  resumed: 'Reanudado',
  ending_requested: 'Baja solicitada',
  ended: 'Finalizado',
  cancelled: 'Cancelado',
  note_added: 'Nota',
};

const CONDITION_LABELS: Record<string, string> = {
  endDate: 'fecha de fin',
  autoRenew: 'renovación automática',
  cancellationNoticeDays: 'preaviso',
  notes: 'notas',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const day = (v: unknown): string => (str(v) ? formatDate(str(v).slice(0, 10)) : '');

/** Título y detalle de una entrada del historial del contrato. */
export function contractEventText(e: ContractEventDto): { title: string; detail: string | null } {
  const p = e.payload;
  const title = EVENT_LABELS[e.eventType] ?? e.eventType;
  switch (e.eventType) {
    case 'signed':
      return { title, detail: p.migrated ? 'Migrado de otro sistema' : null };
    case 'price_changed':
      return {
        title,
        detail: [`${formatEur(num(p.from))} → ${formatEur(num(p.to))}`, str(p.reason)]
          .filter(Boolean)
          .join(' · '),
      };
    case 'unit_changed':
      return {
        title,
        detail: [
          str(p.toUnitCode) && `Al trastero ${str(p.toUnitCode)}`,
          p.newPrice != null && `cuota ${formatEur(num(p.newPrice))}`,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'ending_requested': {
      const date = day(p.endDate ?? p.requestedEndDate);
      if (p.reason === 'term_reached') {
        return { title: 'Fin del plazo', detail: `Sin renovación automática: acaba el ${date}` };
      }
      if (p.reason === 'move_out_date_changed') {
        return {
          title: 'Fecha de baja cambiada',
          detail: `Desde el área de clientes: del ${day(p.previousEndDate)} al ${date}`,
        };
      }
      return {
        title,
        detail: `Último día: ${date}${p.channel === 'portal' ? ' · desde el área de clientes' : ''}`,
      };
    }
    case 'resumed':
      return {
        title: p.reason === 'retention_offer_accepted' ? 'Baja anulada' : 'Baja anulada',
        detail:
          p.reason === 'retention_offer_accepted'
            ? 'El inquilino aceptó la oferta de retención'
            : p.channel === 'portal'
              ? 'Desde el área de clientes'
              : null,
      };
    case 'cancelled':
      return { title, detail: str(p.reason) ? `Motivo: ${str(p.reason)}` : null };
    case 'note_added':
      return noteText(p);
    default:
      return { title, detail: null };
  }
}

function noteText(p: Record<string, unknown>): { title: string; detail: string | null } {
  switch (p.event ?? p.kind) {
    case 'annex_created':
      return { title: `Anexo ${num(p.number)} enviado a firmar`, detail: str(p.title) || null };
    case 'renewal_offer_sent':
      return { title: `Oferta de renovación enviada (anexo ${num(p.number)})`, detail: null };
    case 'annex_signed':
      return {
        title: `Anexo ${num(p.number)} firmado`,
        detail: [str(p.title), str(p.signerName) ? `por ${str(p.signerName)}` : '']
          .filter(Boolean)
          .join(' · '),
      };
    case 'annex_cancelled':
      return { title: `Anexo ${num(p.number)} cancelado`, detail: str(p.title) || null };
    case 'auto_renewed':
      return {
        title: 'Prórroga automática',
        detail: `${num(p.months)} meses, hasta el ${day(p.newEndDate)}`,
      };
    case 'renewed':
      return { title: 'Renovado', detail: `${num(p.months)} meses, hasta el ${day(p.newEndDate)}` };
    case 'deposit_settled':
      return {
        title: 'Fianza liquidada',
        detail: [
          `Devuelto ${formatEur(num(p.returned))}`,
          `retenido ${formatEur(num(p.retained))}`,
          str(p.retentionReason),
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'price_scheduled':
      return {
        title: 'Cambio de cuota programado',
        detail: `${formatEur(num(p.to))} desde el ${day(p.date)}${str(p.reason) ? ` · ${str(p.reason)}` : ''}`,
      };
    case 'move_scheduled':
      return {
        title: 'Traslado programado',
        detail: `Al trastero ${str(p.toUnitCode)} el ${day(p.date)}`,
      };
    case 'conditions_updated':
      return {
        title: 'Condiciones cambiadas',
        detail:
          Object.keys((p.changes as Record<string, unknown>) ?? {})
            .map((k) => CONDITION_LABELS[k] ?? k)
            .join(', ') || null,
      };
    case 'pre_opening_date_changed':
      return {
        title: 'Fecha de apertura cambiada',
        detail: str(p.openingDate) ? day(p.openingDate) : 'Por confirmar',
      };
    case 'pre_opening_started':
      return { title: 'Empieza el alquiler', detail: `Apertura del local: ${day(p.openingDay)}` };
    case 'pre_opening_reassigned':
      return {
        title: 'Trastero reasignado',
        detail: `Del ${str(p.fromUnit)} al ${str(p.toUnit)} antes de la apertura`,
      };
    case 'pre_opening_cancelled':
      return {
        title: 'Reserva cancelada',
        detail: p.by === 'customer' ? 'Por el inquilino' : 'Por el equipo',
      };
    case 'withdrawn':
      return {
        title: 'Desistimiento',
        detail: [
          `${p.by === 'customer' ? 'Desde el área de clientes' : 'Registrado por el equipo'}, comunicado el ${day(p.communicatedOn)}`,
          `devuelto ${formatEur(num(p.rentRefund) + num(p.depositRefund))}`,
          num(p.rentKept) > 0 ? `retenido ${formatEur(num(p.rentKept))} por días de uso` : null,
          str(p.note),
        ]
          .filter(Boolean)
          .join(' · '),
      };
    default:
      return { title: 'Nota', detail: str(p.note) || null };
  }
}
