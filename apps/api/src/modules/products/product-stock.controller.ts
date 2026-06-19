import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { AdjustStockSchema, type ProductStockDto, SetStockSchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ProductStockService } from './product-stock.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class AdjustStockDto extends createZodDto(AdjustStockSchema) {}
class SetStockDto extends createZodDto(SetStockSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('products/:productId/stock')
export class ProductStockController {
  constructor(private readonly stock: ProductStockService) {}

  @RequirePermission('products:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ): Promise<ProductStockDto[]> {
    return this.stock.listByProduct(user.tenantId, productId);
  }

  @RequirePermission('products:write')
  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  async adjust(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() input: AdjustStockDto,
    @Req() req: Request,
  ): Promise<ProductStockDto> {
    return this.stock.adjust({
      tenantId: user.tenantId,
      userId: user.sub,
      productId,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('products:write')
  @Put()
  async set(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() input: SetStockDto,
    @Req() req: Request,
  ): Promise<ProductStockDto> {
    return this.stock.set({
      tenantId: user.tenantId,
      userId: user.sub,
      productId,
      input,
      meta: extractMeta(req),
    });
  }
}
