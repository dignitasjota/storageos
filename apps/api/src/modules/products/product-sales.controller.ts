import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  CreateProductSaleSchema,
  type ProductSaleDto,
  ProductSaleStatusEnum,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ProductSalesService } from './product-sales.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateProductSaleDto extends createZodDto(CreateProductSaleSchema) {}

const CancelProductSaleSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
class CancelProductSaleDto extends createZodDto(CancelProductSaleSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('product-sales')
export class ProductSalesController {
  constructor(private readonly sales: ProductSalesService) {}

  @RequirePermission('products:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
  ): Promise<ProductSaleDto[]> {
    const parsedStatus = status ? ProductSaleStatusEnum.parse(status) : undefined;
    return this.sales.list(user.tenantId, {
      ...(facilityId ? { facilityId } : {}),
      ...(customerId ? { customerId } : {}),
      ...(parsedStatus ? { status: parsedStatus } : {}),
    });
  }

  @RequirePermission('products:read')
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ProductSaleDto> {
    return this.sales.detail(user.tenantId, id);
  }

  @RequirePermission('products:write')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateProductSaleDto,
    @Req() req: Request,
  ): Promise<ProductSaleDto> {
    return this.sales.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('products:write')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CancelProductSaleDto,
    @Req() req: Request,
  ): Promise<ProductSaleDto> {
    return this.sales.cancel({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      ...(input.reason ? { reason: input.reason } : {}),
      meta: extractMeta(req),
    });
  }
}
