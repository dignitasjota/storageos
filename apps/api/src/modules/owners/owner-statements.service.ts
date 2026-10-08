import { BadRequestException, Injectable } from '@nestjs/common';
import {
  NON_CASH_PAYMENT_METHODS,
  OWNER_FEE_VAT_PCT,
  type OwnerStatementDto,
  type OwnerStatementExpenseLine,
  type OwnerStatementPaymentLine,
} from '@storageos/shared';

import { formatEur } from '../../common/format';
import { addAmounts, subtractAmounts } from '../../common/money';
import { escapeHtml, tenantEmailShell } from '../../common/tenant-email-layout';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';

import { OwnersService } from './owners.service';

import type { OwnerStatement, Prisma } from '@storageos/database';

const round2 = (n: number) => Math.round(n * 100) / 100;
const day = (d: Date) => d.toISOString().slice(0, 10);
const sum = (xs: number[]) => xs.reduce((acc, x) => addAmounts(acc, x), 0);

/** Meses naturales que toca el periodo (para la cuota fija mensual). */
export function monthsInPeriod(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return Math.max(1, ty * 12 + tm - (fy * 12 + fm) + 1);
}

/** Honorarios del administrador: % de lo cobrado (neto) o cuota fija al mes. */
export function ownerFee(
  feeType: string,
  feeValue: number,
  collectedNet: number,
  months: number,
): { base: number; vat: number } {
  const base =
    feeType === 'fixed'
      ? round2(feeValue * months)
      : round2((Math.max(0, collectedNet) * feeValue) / 100);
  return { base, vat: round2((base * OWNER_FEE_VAT_PCT) / 100) };
}

type Detail = {
  payments: OwnerStatementPaymentLine[];
  expenseLines: OwnerStatementExpenseLine[];
  feeType: 'percentage' | 'fixed';
  feeValue: number;
};

/**
 * Liquidación al propietario (plan Administrador): lo cobrado de los
 * contratos de sus locales en el periodo, menos lo devuelto, los honorarios
 * del administrador (con IVA) y los gastos de sus locales.
 */
@Injectable()
export class OwnerStatementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owners: OwnersService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  async compute(
    tenantId: string,
    ownerId: string,
    from: string,
    to: string,
  ): Promise<OwnerStatementDto> {
    const owner = await this.owners.findOrThrow(tenantId, ownerId);
    const start = new Date(`${from}T00:00:00.000Z`);
    const endExclusive = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000);
    const ownerInvoice = { ownerId, kind: 'invoice' as const, deletedAt: null };
    const notCash = { notIn: [...NON_CASH_PAYMENT_METHODS] };

    const [paid, refunds, expenses, withheld, pendingRows] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          tx.payment.findMany({
            where: {
              status: { in: ['succeeded', 'partially_refunded', 'refunded'] },
              methodType: notCash,
              paidAt: { gte: start, lt: endExclusive },
              invoice: ownerInvoice,
            },
            orderBy: { paidAt: 'asc' },
            select: {
              id: true,
              amount: true,
              paidAt: true,
              refundedAmount: true,
              refundedAt: true,
              invoice: {
                select: {
                  invoiceNumber: true,
                  customer: {
                    select: {
                      customerType: true,
                      companyName: true,
                      firstName: true,
                      lastName: true,
                    },
                  },
                  contract: { select: { unit: { select: { code: true } } } },
                },
              },
            },
          }),
          tx.payment.findMany({
            where: {
              methodType: notCash,
              refundedAt: { gte: start, lt: endExclusive },
              refundedAmount: { gt: 0 },
              invoice: ownerInvoice,
            },
            select: { id: true, refundedAmount: true },
          }),
          tx.expense.findMany({
            where: {
              facility: { ownerId },
              expenseDate: { gte: start, lt: endExclusive },
            },
            orderBy: { expenseDate: 'asc' },
            select: {
              expenseDate: true,
              description: true,
              amount: true,
              facility: { select: { name: true } },
            },
          }),
          tx.invoice.aggregate({
            where: {
              ...ownerInvoice,
              status: { notIn: ['draft', 'cancelled'] },
              issueDate: { gte: start, lt: endExclusive },
            },
            _sum: { withholdingAmount: true },
          }),
          tx.invoice.findMany({
            where: { ...ownerInvoice, status: { in: ['issued', 'overdue'] } },
            select: { total: true, amountPaid: true },
          }),
        ]),
      tenantId,
    );

    const refundedById = new Map(refunds.map((r) => [r.id, Number(r.refundedAmount)]));
    const payments: OwnerStatementPaymentLine[] = paid.map((p) => {
      const c = p.invoice?.customer;
      return {
        date: day(p.paidAt ?? start),
        invoiceNumber: p.invoice?.invoiceNumber ?? null,
        customerName: c
          ? c.customerType === 'business'
            ? (c.companyName ?? 'Empresa')
            : [c.firstName, c.lastName].filter(Boolean).join(' ')
          : 'Cliente',
        unitCode: p.invoice?.contract?.unit.code ?? null,
        amount: Number(p.amount),
        refunded: refundedById.get(p.id) ?? 0,
      };
    });
    const collected = sum(paid.map((p) => Number(p.amount)));
    const refunded = sum(refunds.map((r) => Number(r.refundedAmount)));
    const collectedNet = subtractAmounts(collected, refunded);
    const feeType = owner.feeType === 'fixed' ? 'fixed' : 'percentage';
    const fee = ownerFee(feeType, Number(owner.feeValue), collectedNet, monthsInPeriod(from, to));
    const expenseLines: OwnerStatementExpenseLine[] = expenses.map((e) => ({
      date: day(e.expenseDate),
      description: e.description,
      facilityName: e.facility?.name ?? null,
      amount: Number(e.amount),
    }));
    const expensesTotal = sum(expenseLines.map((e) => e.amount));
    const pending = sum(
      pendingRows.map((r) => subtractAmounts(Number(r.total), Number(r.amountPaid))),
    );

    return {
      id: null,
      ownerId,
      ownerName: owner.legalName,
      ownerTaxId: owner.taxId,
      ownerIbanLast4: owner.ibanLast4,
      periodStart: from,
      periodEnd: to,
      collected,
      refunded,
      feeType,
      feeValue: Number(owner.feeValue),
      feeBase: fee.base,
      feeVat: fee.vat,
      expenses: expensesTotal,
      withholding: Number(withheld._sum.withholdingAmount ?? 0),
      net: round2(collectedNet - fee.base - fee.vat - expensesTotal),
      pending,
      payments,
      expenseLines,
      sentAt: null,
      sentTo: null,
    };
  }

  /** Guarda la foto de la liquidación (y la envía al propietario por email). */
  async save(args: {
    tenantId: string;
    userId: string;
    ownerId: string;
    from: string;
    to: string;
    send: boolean;
  }): Promise<OwnerStatementDto> {
    const dto = await this.compute(args.tenantId, args.ownerId, args.from, args.to);
    const owner = await this.owners.findOrThrow(args.tenantId, args.ownerId);
    if (args.send && !owner.email) {
      throw new BadRequestException({
        code: 'owner_without_email',
        message: 'Pon el email del propietario para enviarle la liquidación',
      });
    }
    const detail: Detail = {
      payments: dto.payments,
      expenseLines: dto.expenseLines,
      feeType: dto.feeType,
      feeValue: dto.feeValue,
    };
    const values = {
      collected: dto.collected,
      refunded: dto.refunded,
      feeBase: dto.feeBase,
      feeVat: dto.feeVat,
      expenses: dto.expenses,
      withholding: dto.withholding,
      net: dto.net,
      pending: dto.pending,
      detail: detail as unknown as Prisma.InputJsonValue,
    };
    let row = await this.prisma.withTenant(
      (tx) =>
        tx.ownerStatement.upsert({
          where: {
            ownerId_periodStart_periodEnd: {
              ownerId: args.ownerId,
              periodStart: new Date(`${args.from}T00:00:00.000Z`),
              periodEnd: new Date(`${args.to}T00:00:00.000Z`),
            },
          },
          create: {
            tenantId: args.tenantId,
            ownerId: args.ownerId,
            periodStart: new Date(`${args.from}T00:00:00.000Z`),
            periodEnd: new Date(`${args.to}T00:00:00.000Z`),
            createdByUserId: args.userId,
            ...values,
          },
          update: values,
        }),
      args.tenantId,
    );

    if (args.send && owner.email) {
      const tenant = await this.prisma.withTenant(
        (tx) =>
          tx.tenant.findUniqueOrThrow({
            where: { id: args.tenantId },
            select: { name: true, portalLogoUrl: true, portalBrandColor: true },
          }),
        args.tenantId,
      );
      const { subject, html, text } = renderStatementEmail(dto, tenant.name);
      await this.email.sendRendered({
        to: owner.email,
        tenantId: args.tenantId,
        subject,
        html: tenantEmailShell(
          { name: tenant.name, logoUrl: tenant.portalLogoUrl, brandColor: tenant.portalBrandColor },
          html,
        ),
        text,
        tags: { type: 'owner_statement' },
      });
      row = await this.prisma.withTenant(
        (tx) =>
          tx.ownerStatement.update({
            where: { id: row.id },
            data: { sentAt: new Date(), sentTo: owner.email },
          }),
        args.tenantId,
      );
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: args.send ? 'owner.statement_sent' : 'owner.statement_saved',
      entityType: 'Owner',
      entityId: args.ownerId,
      changes: { from: args.from, to: args.to, net: dto.net },
    });
    return this.toDto(row, owner);
  }

  async list(tenantId: string, ownerId: string): Promise<OwnerStatementDto[]> {
    const owner = await this.owners.findOrThrow(tenantId, ownerId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.ownerStatement.findMany({
          where: { ownerId },
          orderBy: { periodStart: 'desc' },
          take: 36,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r, owner));
  }

  private toDto(
    r: OwnerStatement,
    owner: { legalName: string; taxId: string; ibanLast4: string | null },
  ): OwnerStatementDto {
    const d = r.detail as unknown as Detail;
    return {
      id: r.id,
      ownerId: r.ownerId,
      ownerName: owner.legalName,
      ownerTaxId: owner.taxId,
      ownerIbanLast4: owner.ibanLast4,
      periodStart: day(r.periodStart),
      periodEnd: day(r.periodEnd),
      collected: Number(r.collected),
      refunded: Number(r.refunded),
      feeType: d.feeType,
      feeValue: d.feeValue,
      feeBase: Number(r.feeBase),
      feeVat: Number(r.feeVat),
      expenses: Number(r.expenses),
      withholding: Number(r.withholding),
      net: Number(r.net),
      pending: Number(r.pending),
      payments: d.payments,
      expenseLines: d.expenseLines,
      sentAt: r.sentAt?.toISOString() ?? null,
      sentTo: r.sentTo,
    };
  }
}

/** Correo de la liquidación (HTML ya escapado + texto plano). */
export function renderStatementEmail(
  s: OwnerStatementDto,
  tenantName: string,
): { subject: string; html: string; text: string } {
  const eur = (n: number) => formatEur(n);
  const period = `${s.periodStart.split('-').reverse().join('/')} – ${s.periodEnd.split('-').reverse().join('/')}`;
  const feeLabel =
    s.feeType === 'fixed'
      ? `Honorarios de administración (cuota fija)`
      : `Honorarios de administración (${s.feeValue} % de lo cobrado)`;
  const rows: Array<[string, number, boolean?]> = [
    ['Cobrado', s.collected],
    ...(s.refunded > 0 ? ([['Devuelto', -s.refunded]] as Array<[string, number]>) : []),
    [feeLabel, -s.feeBase],
    [`IVA de los honorarios (${OWNER_FEE_VAT_PCT} %)`, -s.feeVat],
    ...(s.expenses > 0
      ? ([['Gastos de tus locales', -s.expenses]] as Array<[string, number]>)
      : []),
    ['A transferir', s.net, true],
  ];
  const table = rows
    .map(
      ([label, amount, strong]) =>
        `<tr><td style="padding:4px 12px 4px 0">${strong ? '<strong>' : ''}${escapeHtml(label)}${strong ? '</strong>' : ''}</td><td style="padding:4px 0;text-align:right">${strong ? '<strong>' : ''}${escapeHtml(eur(amount))}${strong ? '</strong>' : ''}</td></tr>`,
    )
    .join('');
  const paymentRows = s.payments
    .map(
      (p) =>
        `<tr><td style="padding:2px 8px 2px 0">${escapeHtml(p.date.split('-').reverse().join('/'))}</td><td style="padding:2px 8px 2px 0">${escapeHtml(p.invoiceNumber ?? '')}</td><td style="padding:2px 8px 2px 0">${escapeHtml(p.customerName)}${p.unitCode ? ` · ${escapeHtml(p.unitCode)}` : ''}</td><td style="padding:2px 0;text-align:right">${escapeHtml(eur(p.amount))}</td></tr>`,
    )
    .join('');
  const expenseRows = s.expenseLines
    .map(
      (e) =>
        `<tr><td style="padding:2px 8px 2px 0">${escapeHtml(e.date.split('-').reverse().join('/'))}</td><td style="padding:2px 8px 2px 0">${escapeHtml(e.description)}</td><td style="padding:2px 8px 2px 0">${escapeHtml(e.facilityName ?? '')}</td><td style="padding:2px 0;text-align:right">${escapeHtml(eur(e.amount))}</td></tr>`,
    )
    .join('');
  const html = [
    `<p>Hola, ${escapeHtml(s.ownerName)}:</p>`,
    `<p>Te enviamos la liquidación de tus inmuebles del periodo ${escapeHtml(period)}.</p>`,
    `<table style="border-collapse:collapse;font-size:14px">${table}</table>`,
    s.ownerIbanLast4
      ? `<p>Te lo transferimos a tu cuenta terminada en ${escapeHtml(s.ownerIbanLast4)}.</p>`
      : '',
    s.withholding > 0
      ? `<p>Los inquilinos han retenido ${escapeHtml(eur(s.withholding))} de IRPF en las facturas del periodo; te llegarán sus certificados de retenciones.</p>`
      : '',
    s.pending > 0 ? `<p>Pendiente de cobro a día de hoy: ${escapeHtml(eur(s.pending))}.</p>` : '',
    paymentRows
      ? `<h3 style="font-size:15px">Cobros</h3><table style="border-collapse:collapse;font-size:13px">${paymentRows}</table>`
      : '',
    expenseRows
      ? `<h3 style="font-size:15px">Gastos</h3><table style="border-collapse:collapse;font-size:13px">${expenseRows}</table>`
      : '',
    `<p>${escapeHtml(tenantName)}</p>`,
  ].join('');
  const text = [
    `Hola, ${s.ownerName}:`,
    '',
    `Liquidación del periodo ${period}.`,
    '',
    ...rows.map(([label, amount]) => `${label}: ${eur(amount)}`),
    ...(s.ownerIbanLast4
      ? ['', `Te lo transferimos a tu cuenta terminada en ${s.ownerIbanLast4}.`]
      : []),
    ...(s.withholding > 0 ? [`IRPF retenido por los inquilinos: ${eur(s.withholding)}.`] : []),
    ...(s.pending > 0 ? [`Pendiente de cobro hoy: ${eur(s.pending)}.`] : []),
    '',
    tenantName,
  ].join('\n');
  return { subject: `Liquidación ${period} — ${tenantName}`, html, text };
}
