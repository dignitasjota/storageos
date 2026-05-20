import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma, Product, ProductType } from '@storageos/database';
import type {
  CreateProductInput,
  ProductDto,
  ProductTypeValue,
  UpdateProductInput,
} from '@storageos/shared';

interface ListFilters {
  isActive?: boolean;
  type?: ProductTypeValue;
}

type ProductWithStock = Product & {
  stocks: { quantity: number }[];
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, filters: ListFilters): Promise<ProductDto[]> {
    const where: Prisma.ProductWhereInput = { deletedAt: null };
    if (filters.isActive !== undefined) where.isActive = filters.isActive;
    if (filters.type) where.type = filters.type as ProductType;
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.product.findMany({
          where,
          include: { stocks: { select: { quantity: true } } },
          orderBy: [{ name: 'asc' }],
          take: 500,
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<ProductDto> {
    return this.toDto(await this.findOrThrow(tenantId, id));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateProductInput;
    meta: RequestMeta;
  }): Promise<ProductDto> {
    const created = await this.prisma.withTenant(async (tx) => {
      try {
        return await tx.product.create({
          data: {
            tenantId: args.tenantId,
            sku: args.input.sku.trim(),
            name: args.input.name.trim(),
            description: args.input.description?.trim() || null,
            type: args.input.type,
            price: args.input.price,
            taxRate: args.input.taxRate,
            isActive: args.input.isActive,
          },
          include: { stocks: { select: { quantity: true } } },
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'product_sku_taken',
            message: 'Ya existe un producto con ese SKU',
          });
        }
        throw err;
      }
    }, args.tenantId);

    await this.writeAudit('product.created', args, created.id);
    return this.toDto(created);
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateProductInput;
    meta: RequestMeta;
  }): Promise<ProductDto> {
    await this.findOrThrow(args.tenantId, args.id);
    const data: Prisma.ProductUncheckedUpdateInput = {};
    if (args.input.sku !== undefined) data.sku = args.input.sku.trim();
    if (args.input.name !== undefined) data.name = args.input.name.trim();
    if (args.input.description !== undefined)
      data.description = args.input.description?.trim() || null;
    if (args.input.type !== undefined) data.type = args.input.type;
    if (args.input.price !== undefined) data.price = args.input.price;
    if (args.input.taxRate !== undefined) data.taxRate = args.input.taxRate;
    if (args.input.isActive !== undefined) data.isActive = args.input.isActive;

    const updated = await this.prisma.withTenant(async (tx) => {
      try {
        return await tx.product.update({
          where: { id: args.id },
          data,
          include: { stocks: { select: { quantity: true } } },
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new ConflictException({
            code: 'product_sku_taken',
            message: 'Ya existe un producto con ese SKU',
          });
        }
        throw err;
      }
    }, args.tenantId);

    await this.writeAudit('product.updated', args, args.id);
    return this.toDto(updated);
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<void> {
    await this.findOrThrow(args.tenantId, args.id);
    await this.prisma.withTenant(
      (tx) =>
        tx.product.update({
          where: { id: args.id },
          data: { deletedAt: new Date(), isActive: false },
        }),
      args.tenantId,
    );
    await this.writeAudit('product.deleted', args, args.id);
  }

  /**
   * Helper interno: carga el producto en el contexto de una transaccion
   * existente. Usado por ProductSalesService.
   */
  async findActiveInTx(tx: Prisma.TransactionClient, productId: string): Promise<Product> {
    const product = await tx.product.findFirst({
      where: { id: productId, deletedAt: null },
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
    return product;
  }

  private async findOrThrow(tenantId: string, id: string): Promise<ProductWithStock> {
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.product.findFirst({
          where: { id, deletedAt: null },
          include: { stocks: { select: { quantity: true } } },
        }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'product_not_found',
        message: 'Producto no encontrado',
      });
    }
    return row;
  }

  private async writeAudit(
    action: string,
    args: { tenantId: string; userId: string; meta: RequestMeta },
    entityId: string,
  ): Promise<void> {
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action,
      entityType: 'Product',
      entityId,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  private toDto(p: ProductWithStock): ProductDto {
    const totalStock = p.stocks.reduce((acc, s) => acc + s.quantity, 0);
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      type: p.type as ProductTypeValue,
      price: Number(p.price),
      taxRate: Number(p.taxRate),
      isActive: p.isActive,
      totalStock,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}
