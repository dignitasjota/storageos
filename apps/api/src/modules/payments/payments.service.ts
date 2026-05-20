import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { PAYMENT_GATEWAY, PaymentGateway } from './payment-gateway.interface';
import { PaymentMethodsService } from './payment-methods.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Payment, PaymentStatus, Prisma } from '@storageos/database';
import type { ChargeInvoiceInput, PaymentDto, PaymentStatusValue } from '@storageos/shared';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly paymentMethods: PaymentMethodsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async list(
    tenantId: string,
    filters: { invoiceId?: string; customerId?: string },
  ): Promise<PaymentDto[]> {
    const where: Prisma.PaymentWhereInput = {};
    if (filters.invoiceId) where.invoiceId = filters.invoiceId;
    if (filters.customerId) where.customerId = filters.customerId;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          include: {
            invoice: { select: { invoiceNumber: true } },
            customer: {
              select: {
                firstName: true,
                lastName: true,
                companyName: true,
                customerType: true,
              },
            },
          },
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async chargeInvoice(args: {
    tenantId: string;
    userId: string;
    invoiceId: string;
    input: ChargeInvoiceInput;
    meta: RequestMeta;
  }): Promise<PaymentDto> {
    const invoice = await this.prisma.withTenant(
      (tx) =>
        tx.invoice.findFirst({
          where: { id: args.invoiceId, deletedAt: null },
          include: { customer: { select: { id: true } } },
        }),
      args.tenantId,
    );
    if (!invoice) {
      throw new NotFoundException({ code: 'invoice_not_found', message: 'Factura no encontrada' });
    }
    if (invoice.status !== 'issued' && invoice.status !== 'overdue') {
      throw new BadRequestException({
        code: 'invoice_not_payable',
        message: 'La factura no es cobrable en este estado',
      });
    }
    // F2 sin destinatario no tiene customer ni metodo de pago: el cobro
    // automatico via gateway no es posible. El cobro en metalico se
    // registra via `mark-paid`.
    if (!invoice.customerId) {
      throw new BadRequestException({
        code: 'invoice_without_customer',
        message: 'La factura no tiene cliente; no se puede cobrar via gateway',
      });
    }
    const invoiceCustomerId: string = invoice.customerId;
    const pending = Number(invoice.total) - Number(invoice.amountPaid);
    const amount = args.input.amount ?? pending;
    if (amount <= 0 || amount > pending + 0.001) {
      throw new BadRequestException({
        code: 'invalid_amount',
        message: 'Importe invalido',
      });
    }

    // Resolver payment method.
    const pmId =
      args.input.paymentMethodId ??
      (
        await this.prisma.withTenant(
          (tx) =>
            tx.paymentMethod.findFirst({
              where: { customerId: invoiceCustomerId, isDefault: true, deletedAt: null },
            }),
          args.tenantId,
        )
      )?.id;
    if (!pmId) {
      throw new BadRequestException({
        code: 'no_payment_method',
        message: 'No hay metodo de pago disponible para el inquilino',
      });
    }

    // Cargo via gateway, decryption del token dentro del withTenant para no
    // exfiltrar.
    const { paymentRow, chargeResult } = await this.prisma.withTenant(async (tx) => {
      const pm = await tx.paymentMethod.findUniqueOrThrow({ where: { id: pmId } });
      const tokenPlain = await this.paymentMethods.decryptToken(tx, pm.id);
      const result = await this.gateway.charge({
        gatewayCustomerId: pm.gatewayCustomerId ?? '',
        paymentMethodToken: tokenPlain,
        amountCents: Math.round(amount * 100),
        currency: invoice.currency,
        description: `Factura ${invoice.invoiceNumber}`,
        metadata: { invoiceId: invoice.id, tenantId: args.tenantId },
        offSession: true,
      });
      const status: PaymentStatus =
        result.status === 'succeeded'
          ? 'succeeded'
          : result.status === 'processing'
            ? 'processing'
            : result.status === 'requires_action'
              ? 'pending'
              : 'failed';
      const created = await tx.payment.create({
        data: {
          tenantId: args.tenantId,
          invoiceId: invoice.id,
          customerId: invoiceCustomerId,
          paymentMethodId: pm.id,
          amount,
          currency: invoice.currency,
          status,
          methodType: pm.type,
          gateway: pm.gateway,
          gatewayPaymentId: result.gatewayPaymentId,
          ...(result.status === 'succeeded' ? { paidAt: new Date() } : {}),
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
        },
        include: {
          invoice: { select: { invoiceNumber: true } },
          customer: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              customerType: true,
            },
          },
        },
      });
      // Sincronizar invoice si succeeded (la final llega del webhook tambien).
      if (status === 'succeeded') {
        const newPaid = Number(invoice.amountPaid) + amount;
        const fully = newPaid >= Number(invoice.total) - 0.001;
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            amountPaid: newPaid,
            ...(fully ? { status: 'paid', paidAt: new Date() } : {}),
          },
        });
      }
      return { paymentRow: created, chargeResult: result };
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: chargeResult.status === 'succeeded' ? 'payment.succeeded' : 'payment.attempted',
      entityType: 'Payment',
      entityId: paymentRow.id,
      changes: {
        invoiceId: invoice.id,
        amount,
        result: chargeResult.status,
        ...(chargeResult.failureReason ? { failureReason: chargeResult.failureReason } : {}),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(paymentRow);
  }

  /**
   * Sincroniza un payment con el estado real del gateway (llamado desde
   * el webhook handler).
   */
  async syncFromWebhook(args: {
    tenantId: string;
    gatewayPaymentId: string;
    newStatus: PaymentStatusValue;
    paidAt?: Date;
    failureReason?: string;
  }): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.payment.findFirst({
          where: { gatewayPaymentId: args.gatewayPaymentId },
        }),
      args.tenantId,
    );
    if (!existing) {
      this.logger.warn(
        `Webhook recibido para payment desconocido ${args.gatewayPaymentId} (tenant ${args.tenantId})`,
      );
      return;
    }
    await this.prisma.withTenant(async (tx) => {
      await tx.payment.update({
        where: { id: existing.id },
        data: {
          status: args.newStatus as PaymentStatus,
          ...(args.paidAt ? { paidAt: args.paidAt } : {}),
          ...(args.failureReason ? { failureReason: args.failureReason } : {}),
        },
      });
      if (args.newStatus === 'succeeded' && existing.invoiceId) {
        const invoice = await tx.invoice.findUniqueOrThrow({
          where: { id: existing.invoiceId },
        });
        const newPaid = Number(invoice.amountPaid) + Number(existing.amount);
        const fully = newPaid >= Number(invoice.total) - 0.001;
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            amountPaid: newPaid,
            ...(fully ? { status: 'paid', paidAt: args.paidAt ?? new Date() } : {}),
          },
        });
      }
    }, args.tenantId);
  }

  private toDto(
    row: Payment & {
      invoice?: { invoiceNumber: string } | null;
      customer?: {
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        customerType: 'individual' | 'business';
      };
    },
  ): PaymentDto {
    const customerName = row.customer
      ? row.customer.customerType === 'business'
        ? (row.customer.companyName ?? 'Empresa')
        : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ').trim() ||
          'Sin nombre'
      : 'Inquilino';
    return {
      id: row.id,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoice?.invoiceNumber ?? null,
      customerId: row.customerId,
      customerName,
      paymentMethodId: row.paymentMethodId,
      amount: Number(row.amount),
      currency: row.currency,
      status: row.status as PaymentStatusValue,
      methodType: row.methodType,
      gateway: row.gateway,
      gatewayPaymentId: row.gatewayPaymentId,
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      refundedAt: row.refundedAt ? row.refundedAt.toISOString() : null,
      refundedAmount: Number(row.refundedAmount),
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
