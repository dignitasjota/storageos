import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { assertFacilityAllowed, resolveFacilityFilter } from '../../common/facility-scope';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type DomainEventPayload } from '../automations/domain-events';
import { InvoiceSeriesService } from '../billing/invoice-series.service';
import { InvoicesService } from '../billing/invoices.service';
import { PrismaService } from '../database/prisma.service';

import { ProductStockService } from './product-stock.service';

/** Importe máximo (con IVA) de una factura simplificada sin datos del cliente. */
const F2_LIMIT = 400;

import type { RequestMeta } from '../auth/auth.service';
import type {
  Prisma,
  Product,
  ProductSale,
  ProductSaleItem,
  ProductSaleStatus,
} from '@storageos/database';
import type {
  CreateInvoiceItemInput,
  CreateProductSaleInput,
  ProductSaleDto,
  ProductSaleItemDto,
  ProductSaleStatusValue,
} from '@storageos/shared';

interface ListFilters {
  facilityScope?: string[] | null;
  facilityId?: string;
  customerId?: string;
  status?: ProductSaleStatusValue;
}

type SaleWithRelations = ProductSale & {
  facility: { name: string };
  customer: {
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    customerType: 'individual' | 'business';
  } | null;
  invoice: { invoiceNumber: string } | null;
  soldBy: { fullName: string } | null;
  items: (ProductSaleItem & { product: { name: string } })[];
};

@Injectable()
export class ProductSalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invoices: InvoicesService,
    private readonly invoiceSeries: InvoiceSeriesService,
    private readonly stock: ProductStockService,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<ProductSaleDto[]> {
    const where: Prisma.ProductSaleWhereInput = {};
    const facFilter = resolveFacilityFilter(filters.facilityScope, filters.facilityId);
    if (facFilter === null) return [];
    if (facFilter) where.facilityId = { in: facFilter };
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.status) where.status = filters.status as ProductSaleStatus;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.productSale.findMany({
          where,
          include: this.includeRelations(),
          orderBy: [{ soldAt: 'desc' }],
          take: 500,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(
    tenantId: string,
    id: string,
    facilityScope?: string[] | null,
  ): Promise<ProductSaleDto> {
    const sale = await this.findOrThrow(tenantId, id);
    assertFacilityAllowed(facilityScope, sale.facilityId);
    return this.toDto(sale);
  }

  /**
   * Registra una venta de productos en mostrador.
   *
   * Flujo:
   *  1. En transaccion: valida productos activos, decrementa stock atomic
   *     (UPDATE WHERE quantity >= line.quantity), crea sale + sale_items
   *     con snapshot de precio e impuestos.
   *  2. Fuera de la transaccion (si hay customer): crea la invoice via
   *     InvoicesService.create, la emite con issue() y enlaza la sale.
   *     Sin customer la sale queda en `pending` sin factura.
   */
  async create(args: {
    tenantId: string;
    /** null en flujos públicos (compra del inquilino desde el portal). */
    userId: string | null;
    input: CreateProductSaleInput;
    meta: RequestMeta;
  }): Promise<ProductSaleDto> {
    const paymentMethod = args.input.paymentMethod ?? 'cash';
    if (paymentMethod === 'pending' && !args.input.customerId) {
      throw new BadRequestException({
        code: 'customer_required',
        message: 'Para cobrarla más tarde, la venta tiene que ser a un inquilino',
      });
    }
    // Toda venta lleva factura (F1 con inquilino, simplificada F2 sin él): la
    // serie se resuelve antes de tocar nada para fallar rápido.
    const resolvedSeriesId = await this.resolveInvoiceSeriesId(
      args.tenantId,
      args.input.invoiceSeriesId,
    );

    // Paso 1: crear sale + decrementar stock + items, todo atomico.
    const saleId = await this.prisma.withTenant(async (tx) => {
      const facility = await tx.facility.findFirst({
        where: { id: args.input.facilityId, deletedAt: null },
        select: { id: true },
      });
      if (!facility) {
        throw new NotFoundException({ code: 'facility_not_found', message: 'Local no encontrado' });
      }
      // Cargar productos y validar.
      const products = new Map<string, Product>();
      for (const item of args.input.items) {
        const product = await tx.product.findFirst({
          where: { id: item.productId, deletedAt: null },
        });
        if (!product) {
          throw new NotFoundException({
            code: 'product_not_found',
            message: 'Producto no encontrado',
          });
        }
        if (!product.isActive) {
          throw new ConflictException({
            code: 'product_inactive',
            message: `El producto ${product.name} no esta activo`,
          });
        }
        products.set(product.id, product);
      }

      // Calcular totales por linea + total y construir items.
      let total = 0;
      const itemsData: Prisma.ProductSaleItemUncheckedCreateWithoutSaleInput[] = [];
      for (const item of args.input.items) {
        // Non-null por el for previo.
        const product = products.get(item.productId)!;
        const unitPrice = Number(product.price);
        const taxRate = Number(product.taxRate);
        const lineSubtotal = round2(unitPrice * item.quantity);
        const lineTotal = round2(lineSubtotal * (1 + taxRate / 100));
        total = round2(total + lineTotal);
        itemsData.push({
          tenantId: args.tenantId,
          productId: product.id,
          unitPrice,
          quantity: item.quantity,
          taxRate,
          lineSubtotal,
          lineTotal,
        });
      }

      // Sin inquilino la factura es simplificada: hasta 400 € con IVA.
      if (!args.input.customerId && total > F2_LIMIT) {
        throw new BadRequestException({
          code: 'customer_required',
          message: `Una venta de más de ${F2_LIMIT} € necesita los datos del inquilino para la factura`,
        });
      }

      // Decrementar stock atomic por linea.
      for (const item of args.input.items) {
        const product = products.get(item.productId)!;
        await this.stock.decrementInTx(tx, {
          productId: product.id,
          facilityId: args.input.facilityId,
          quantity: item.quantity,
          productName: product.name,
        });
      }

      const sale = await tx.productSale.create({
        data: {
          tenantId: args.tenantId,
          facilityId: args.input.facilityId,
          ...(args.input.customerId ? { customerId: args.input.customerId } : {}),
          status: 'pending',
          total,
          notes: args.input.notes?.trim() || null,
          soldByUserId: args.userId,
          items: { create: itemsData },
        },
      });
      return sale.id;
    }, args.tenantId);

    // Paso 2: factura inline si hay customer (fuera de la transaccion para
    // evitar acoplar la transaccion principal con la generacion de hashes
    // Verifactu, que ya tiene su propia $transaction interna en issue()).
    {
      const sale = await this.findOrThrow(args.tenantId, saleId);
      const items: CreateInvoiceItemInput[] = sale.items.map((it) => ({
        description: it.product.name,
        quantity: Number(it.quantity),
        unitPrice: Number(it.unitPrice),
        taxRate: Number(it.taxRate),
      }));
      const invoiceNotes = args.input.notes?.trim();
      const draft = await this.invoices.create({
        tenantId: args.tenantId,
        userId: args.userId,
        input: {
          invoiceType: args.input.customerId ? 'F1' : 'F2',
          ...(args.input.customerId ? { customerId: args.input.customerId } : {}),
          seriesId: resolvedSeriesId,
          items,
          ...(invoiceNotes ? { notes: invoiceNotes } : {}),
          verifactuMode: 'verifactu',
        },
        meta: args.meta,
      });
      await this.invoices.issue({
        tenantId: args.tenantId,
        userId: args.userId,
        invoiceId: draft.id,
        meta: args.meta,
      });
      await this.prisma.withTenant(
        (tx) => tx.productSale.update({ where: { id: saleId }, data: { invoiceId: draft.id } }),
        args.tenantId,
      );
      // Cobrada en el mostrador: el cobro queda en la factura (y en la caja del
      // día). Si no, la factura queda pendiente y la venta se da por pagada
      // cuando se cobre (`onInvoicePaid`).
      if (paymentMethod !== 'pending') {
        await this.invoices.markPaidManually({
          tenantId: args.tenantId,
          userId: args.userId,
          invoiceId: draft.id,
          input: {
            amount: Number(sale.total),
            methodType: paymentMethod,
            notes: 'Venta en el mostrador',
          },
          meta: args.meta,
        });
        await this.prisma.withTenant(
          (tx) => tx.productSale.update({ where: { id: saleId }, data: { status: 'paid' } }),
          args.tenantId,
        );
      }
    }

    const created = await this.findOrThrow(args.tenantId, saleId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'product_sale.created',
      entityType: 'ProductSale',
      entityId: saleId,
      changes: {
        total: Number(created.total),
        facilityId: args.input.facilityId,
        customerId: args.input.customerId ?? null,
        invoiceId: created.invoiceId,
      },
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(created);
  }

  /** La venta cobrada después (portal, a la factura) pasa a pagada al cobrarse. */
  @OnEvent(DOMAIN_EVENTS.invoice_paid)
  async onInvoicePaid(payload: DomainEventPayload): Promise<void> {
    try {
      await this.prisma.withTenant(
        (tx) =>
          tx.productSale.updateMany({
            where: { invoiceId: payload.entityId, status: 'pending' },
            data: { status: 'paid' },
          }),
        payload.tenantId,
      );
    } catch {
      // Best-effort: no rompe el resto de listeners del cobro.
    }
  }

  /**
   * Cancela una venta. Restaura stock y, si tiene factura, cancela tambien
   * la factura. Solo permitido si la venta esta en `pending` o `paid`.
   */
  async cancel(args: {
    tenantId: string;
    /** `null` cuando la reversión la lanza un flujo público (cobro del portal). */
    userId: string | null;
    id: string;
    reason?: string | undefined;
    meta: RequestMeta;
    facilityScope?: string[] | null;
  }): Promise<ProductSaleDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id);
    assertFacilityAllowed(args.facilityScope, existing.facilityId);
    if (existing.status !== 'pending' && existing.status !== 'paid') {
      throw new BadRequestException({
        code: 'product_sale_not_cancellable',
        message: 'La venta no se puede cancelar en su estado actual',
      });
    }

    await this.prisma.withTenant(async (tx) => {
      // Restaurar stock por cada item.
      for (const item of existing.items) {
        await this.stock.restoreInTx(tx, {
          tenantId: args.tenantId,
          productId: item.productId,
          facilityId: existing.facilityId,
          quantity: item.quantity,
        });
      }
      await tx.productSale.update({
        where: { id: args.id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    }, args.tenantId);

    // Factura (fuera de la transaccion principal): si ya se cobró, se devuelve
    // el dinero (abono con su rectificativa); si no, se anula.
    if (existing.invoiceId) {
      try {
        const inv = await this.prisma.withTenant(
          (tx) =>
            tx.invoice.findUnique({
              where: { id: existing.invoiceId! },
              select: { amountPaid: true, amountRefunded: true },
            }),
          args.tenantId,
        );
        const refundable = round2(Number(inv?.amountPaid ?? 0) - Number(inv?.amountRefunded ?? 0));
        if (refundable > 0) {
          await this.invoices.refund({
            tenantId: args.tenantId,
            userId: args.userId,
            invoiceId: existing.invoiceId,
            input: { amount: refundable, reason: args.reason ?? 'Venta cancelada' },
            meta: args.meta,
          });
        } else {
          await this.invoices.cancel({
            tenantId: args.tenantId,
            userId: args.userId,
            invoiceId: existing.invoiceId,
            input: { reason: args.reason ?? 'Venta cancelada' },
            meta: args.meta,
          });
        }
      } catch (err) {
        // Si la factura no puede cancelarse (ya refunded p.ej.) lo
        // registramos pero no revertimos la cancelacion de la venta.
        const code =
          typeof err === 'object' && err !== null && 'response' in err
            ? ((err as { response?: { code?: string } }).response?.code ?? null)
            : null;
        await this.audit.write({
          tenantId: args.tenantId,
          userId: args.userId,
          action: 'product_sale.invoice_cancel_failed',
          entityType: 'ProductSale',
          entityId: args.id,
          changes: { invoiceId: existing.invoiceId, code },
        });
      }
    }

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'product_sale.cancelled',
      entityType: 'ProductSale',
      entityId: args.id,
      changes: { reason: args.reason ?? null },
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });

    return this.toDto(await this.findOrThrow(args.tenantId, args.id));
  }

  private async resolveInvoiceSeriesId(
    tenantId: string,
    explicitId: string | undefined,
  ): Promise<string> {
    if (explicitId) return explicitId;
    const def = await this.invoiceSeries.getDefault(tenantId);
    if (!def) {
      throw new BadRequestException({
        code: 'default_series_required',
        message:
          'No hay serie por defecto configurada. Indica `invoiceSeriesId` o configura una serie default.',
      });
    }
    return def.id;
  }

  private async findOrThrow(tenantId: string, id: string): Promise<SaleWithRelations> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.productSale.findFirst({
          where: { id },
          include: this.includeRelations(),
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'product_sale_not_found',
        message: 'Venta no encontrada',
      });
    }
    return row;
  }

  private includeRelations() {
    return {
      facility: { select: { name: true } },
      customer: {
        select: {
          firstName: true,
          lastName: true,
          companyName: true,
          customerType: true,
        },
      },
      invoice: { select: { invoiceNumber: true } },
      soldBy: { select: { fullName: true } },
      items: {
        include: { product: { select: { name: true } } },
        orderBy: { createdAt: 'asc' as const },
      },
    } as const;
  }

  private toDto(row: SaleWithRelations): ProductSaleDto {
    const customerName = row.customer
      ? row.customer.customerType === 'business'
        ? (row.customer.companyName ?? 'Empresa')
        : [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ').trim() ||
          'Sin nombre'
      : null;
    return {
      id: row.id,
      facilityId: row.facilityId,
      facilityName: row.facility.name,
      customerId: row.customerId,
      customerName,
      invoiceId: row.invoiceId,
      invoiceNumber: row.invoice?.invoiceNumber ?? null,
      status: row.status as ProductSaleStatusValue,
      total: Number(row.total),
      notes: row.notes,
      soldByUserId: row.soldByUserId,
      soldByName: row.soldBy?.fullName ?? null,
      soldAt: row.soldAt.toISOString(),
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      items: row.items.map((it) => this.itemToDto(it)),
    };
  }

  private itemToDto(it: ProductSaleItem & { product: { name: string } }): ProductSaleItemDto {
    return {
      id: it.id,
      productId: it.productId,
      productName: it.product.name,
      unitPrice: Number(it.unitPrice),
      quantity: it.quantity,
      taxRate: Number(it.taxRate),
      lineSubtotal: Number(it.lineSubtotal),
      lineTotal: Number(it.lineTotal),
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
