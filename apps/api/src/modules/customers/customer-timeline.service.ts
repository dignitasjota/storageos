import { Injectable } from '@nestjs/common';

import { type FacilityScope, invoiceFacilityWhere } from '../../common/facility-scope';
import { formatEur } from '../../common/format';
import { PrismaService } from '../database/prisma.service';

import type { Prisma } from '@storageos/database';
import type { CustomerTimelineItemDto } from '@storageos/shared';

const CONTRACT_EVENTS: Record<string, string> = {
  created: 'Contrato creado',
  signed: 'Contrato firmado',
  price_changed: 'Cuota cambiada',
  unit_changed: 'Cambio de trastero',
  ending_requested: 'Baja solicitada',
  ended: 'Contrato finalizado',
  cancelled: 'Contrato cancelado',
  resumed: 'Baja anulada',
};
const NOTE_LABELS: Record<string, string> = {
  note: 'Nota',
  call: 'Llamada',
  visit: 'Visita',
  meeting: 'Reunión',
  whatsapp: 'WhatsApp',
  email: 'Email',
  other: 'Contacto',
};
const PER_SOURCE = 40;
const TOTAL = 120;

const short = (text: string | null | undefined) =>
  text ? (text.length > 140 ? `${text.slice(0, 140)}…` : text) : null;

/** Todo lo que ha pasado con un inquilino, en una sola línea de tiempo. */
@Injectable()
export class CustomerTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async timeline(
    tenantId: string,
    customerId: string,
    opts: { facilityScope: FacilityScope; permissions: readonly string[] },
  ): Promise<CustomerTimelineItemDto[]> {
    const can = (p: string) => opts.permissions.includes(p);
    const money = can('invoices:read') && can('payments:read');
    const scope = opts.facilityScope;
    const inScope: Prisma.InvoiceWhereInput = scope
      ? { AND: [invoiceFacilityWhere(scope) as Prisma.InvoiceWhereInput] }
      : {};
    const take = PER_SOURCE;
    return this.prisma.withTenant(async (tx) => {
      const [events, invoices, payments, comms, messages, notes, accesses, documents] =
        await Promise.all([
          can('contracts:read')
            ? tx.contractEvent.findMany({
                where: {
                  eventType: { in: Object.keys(CONTRACT_EVENTS) as never[] },
                  contract: {
                    customerId,
                    deletedAt: null,
                    ...(scope ? { unit: { facilityId: { in: scope } } } : {}),
                  },
                },
                orderBy: { occurredAt: 'desc' },
                take,
                select: {
                  id: true,
                  eventType: true,
                  occurredAt: true,
                  contractId: true,
                  contract: { select: { contractNumber: true } },
                },
              })
            : [],
          money
            ? tx.invoice.findMany({
                where: {
                  customerId,
                  deletedAt: null,
                  kind: 'invoice',
                  status: { notIn: ['draft', 'cancelled'] },
                  ...inScope,
                },
                orderBy: { issueDate: 'desc' },
                take,
                select: {
                  id: true,
                  invoiceNumber: true,
                  total: true,
                  issueDate: true,
                  createdAt: true,
                },
              })
            : [],
          money
            ? tx.payment.findMany({
                where: {
                  customerId,
                  paidAt: { not: null },
                  methodType: { notIn: ['credit_note', 'withholding'] },
                  ...(scope ? { invoice: inScope } : {}),
                },
                orderBy: { paidAt: 'desc' },
                take,
                select: {
                  id: true,
                  amount: true,
                  paidAt: true,
                  returnedAt: true,
                  invoiceId: true,
                  invoice: { select: { invoiceNumber: true } },
                },
              })
            : [],
          can('communications:read')
            ? tx.communication.findMany({
                where: { customerId, sentAt: { not: null } },
                orderBy: { sentAt: 'desc' },
                take,
                select: { id: true, channel: true, subject: true, sentAt: true },
              })
            : [],
          tx.customerMessage.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' },
            take,
            select: { id: true, senderType: true, body: true, createdAt: true },
          }),
          tx.customerInteraction.findMany({
            where: { customerId },
            orderBy: { occurredAt: 'desc' },
            take,
            select: { id: true, type: true, content: true, occurredAt: true },
          }),
          can('access:read')
            ? tx.accessLog.findMany({
                where: {
                  customerId,
                  ...(scope ? { device: { facilityId: { in: scope } } } : {}),
                },
                orderBy: { occurredAt: 'desc' },
                take: 20,
                select: {
                  id: true,
                  result: true,
                  occurredAt: true,
                  device: { select: { name: true } },
                },
              })
            : [],
          tx.customerDocument.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' },
            take,
            select: { id: true, fileName: true, createdAt: true },
          }),
        ]);

      const items: CustomerTimelineItemDto[] = [
        ...events.map((e) => ({
          id: `event-${e.id}`,
          kind: 'contract' as const,
          title: CONTRACT_EVENTS[e.eventType] ?? 'Contrato',
          detail: e.contract.contractNumber,
          at: e.occurredAt.toISOString(),
          href: `/contracts/${e.contractId}`,
        })),
        ...invoices.map((i) => ({
          id: `invoice-${i.id}`,
          kind: 'invoice' as const,
          title: `Factura ${i.invoiceNumber}`,
          detail: formatEur(Number(i.total)),
          at: (i.issueDate ?? i.createdAt).toISOString(),
          dateOnly: true,
          href: `/invoices/${i.id}`,
        })),
        ...payments.flatMap((p) => {
          const href = p.invoiceId ? `/invoices/${p.invoiceId}` : null;
          const paid = {
            id: `payment-${p.id}`,
            kind: 'payment' as const,
            title: 'Cobro',
            detail: [formatEur(Number(p.amount)), p.invoice?.invoiceNumber]
              .filter(Boolean)
              .join(' · '),
            at: p.paidAt!.toISOString(),
            href,
          };
          if (!p.returnedAt) return [paid];
          return [
            paid,
            {
              ...paid,
              id: `return-${p.id}`,
              title: 'Cobro devuelto',
              at: p.returnedAt.toISOString(),
            },
          ];
        }),
        ...comms.map((c) => ({
          id: `comm-${c.id}`,
          kind: 'communication' as const,
          title: c.channel === 'whatsapp' ? 'WhatsApp enviado' : 'Correo enviado',
          detail: short(c.subject),
          at: c.sentAt!.toISOString(),
          href: null,
        })),
        ...messages.map((m) => ({
          id: `message-${m.id}`,
          kind: 'message' as const,
          title: m.senderType === 'customer' ? 'Mensaje del inquilino' : 'Mensaje del equipo',
          detail: short(m.body),
          at: m.createdAt.toISOString(),
          href: null,
        })),
        ...notes.map((n) => ({
          id: `note-${n.id}`,
          kind: 'note' as const,
          title: NOTE_LABELS[n.type] ?? 'Nota',
          detail: short(n.content),
          at: n.occurredAt.toISOString(),
          href: null,
        })),
        ...accesses.map((a) => ({
          id: `access-${a.id}`,
          kind: 'access' as const,
          title: a.result === 'allowed' ? 'Entrada al local' : 'Acceso denegado',
          detail: a.device?.name ?? null,
          at: a.occurredAt.toISOString(),
          href: null,
        })),
        ...documents.map((d) => ({
          id: `document-${d.id}`,
          kind: 'document' as const,
          title: 'Documento subido',
          detail: d.fileName,
          at: d.createdAt.toISOString(),
          href: null,
        })),
      ];
      return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, TOTAL);
    }, tenantId);
  }
}
