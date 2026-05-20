import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, ProductStock } from '@storageos/database';
import type { AdjustStockInput, ProductStockDto, SetStockInput } from '@storageos/shared';

type StockWithRelations = ProductStock & {
  facility: { name: string };
};

@Injectable()
export class ProductStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listByProduct(tenantId: string, productId: string): Promise<ProductStockDto[]> {
    await this.assertProductExists(tenantId, productId);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.productStock.findMany({
          where: { productId },
          include: { facility: { select: { name: true } } },
          orderBy: [{ facility: { name: 'asc' } }],
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Suma `delta` (positivo o negativo) al stock en la facility. Crea la
   * fila si no existe (solo si quedara con quantity >= 0).
   */
  async adjust(args: {
    tenantId: string;
    userId: string;
    productId: string;
    input: AdjustStockInput;
    meta: RequestMeta;
  }): Promise<ProductStockDto> {
    await this.assertProductExists(args.tenantId, args.productId);
    const updated = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.productStock.findUnique({
        where: {
          productId_facilityId: {
            productId: args.productId,
            facilityId: args.input.facilityId,
          },
        },
      });
      const currentQty = existing?.quantity ?? 0;
      const newQty = currentQty + args.input.delta;
      if (newQty < 0) {
        throw new ConflictException({
          code: 'insufficient_stock',
          message: 'No hay suficiente stock para aplicar el ajuste',
        });
      }
      if (existing) {
        return tx.productStock.update({
          where: { id: existing.id },
          data: { quantity: newQty },
          include: { facility: { select: { name: true } } },
        });
      }
      return tx.productStock.create({
        data: {
          tenantId: args.tenantId,
          productId: args.productId,
          facilityId: args.input.facilityId,
          quantity: newQty,
        },
        include: { facility: { select: { name: true } } },
      });
    }, args.tenantId);

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'product_stock.adjusted',
      entityType: 'Product',
      entityId: args.productId,
      changes: {
        facilityId: args.input.facilityId,
        delta: args.input.delta,
        newQuantity: updated.quantity,
        notes: args.input.notes ?? null,
      },
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(updated);
  }

  /** Fija la cantidad absoluta (upsert). */
  async set(args: {
    tenantId: string;
    userId: string;
    productId: string;
    input: SetStockInput;
    meta: RequestMeta;
  }): Promise<ProductStockDto> {
    await this.assertProductExists(args.tenantId, args.productId);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.productStock.upsert({
          where: {
            productId_facilityId: {
              productId: args.productId,
              facilityId: args.input.facilityId,
            },
          },
          create: {
            tenantId: args.tenantId,
            productId: args.productId,
            facilityId: args.input.facilityId,
            quantity: args.input.quantity,
          },
          update: { quantity: args.input.quantity },
          include: { facility: { select: { name: true } } },
        }),
      args.tenantId,
    );

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'product_stock.set',
      entityType: 'Product',
      entityId: args.productId,
      changes: {
        facilityId: args.input.facilityId,
        quantity: args.input.quantity,
        notes: args.input.notes ?? null,
      },
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(updated);
  }

  /**
   * Helper interno (transaccional): decrementa stock de forma atomica;
   * lanza `insufficient_stock` si la fila no existe o quantity es menor.
   * Usado por ProductSalesService durante la venta.
   */
  async decrementInTx(
    tx: Prisma.TransactionClient,
    args: { productId: string; facilityId: string; quantity: number; productName: string },
  ): Promise<void> {
    const result = await tx.productStock.updateMany({
      where: {
        productId: args.productId,
        facilityId: args.facilityId,
        quantity: { gte: args.quantity },
      },
      data: { quantity: { decrement: args.quantity } },
    });
    if (result.count !== 1) {
      throw new ConflictException({
        code: 'insufficient_stock',
        message: `No hay suficiente stock del producto ${args.productName}`,
      });
    }
  }

  /**
   * Helper interno (transaccional): incrementa stock (o crea fila si no
   * existe). Usado en cancelacion de ventas para restaurar inventario.
   */
  async restoreInTx(
    tx: Prisma.TransactionClient,
    args: { tenantId: string; productId: string; facilityId: string; quantity: number },
  ): Promise<void> {
    await tx.productStock.upsert({
      where: {
        productId_facilityId: {
          productId: args.productId,
          facilityId: args.facilityId,
        },
      },
      create: {
        tenantId: args.tenantId,
        productId: args.productId,
        facilityId: args.facilityId,
        quantity: args.quantity,
      },
      update: { quantity: { increment: args.quantity } },
    });
  }

  private async assertProductExists(tenantId: string, productId: string): Promise<void> {
    const product = await this.prisma.withTenant(
      (tx) =>
        tx.product.findFirst({
          where: { id: productId, deletedAt: null },
          select: { id: true },
        }),
      tenantId,
    );
    if (!product) {
      throw new NotFoundException({
        code: 'product_not_found',
        message: 'Producto no encontrado',
      });
    }
  }

  private toDto(row: StockWithRelations): ProductStockDto {
    return {
      id: row.id,
      productId: row.productId,
      facilityId: row.facilityId,
      facilityName: row.facility.name,
      quantity: row.quantity,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
