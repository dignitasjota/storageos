import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  CreateProductSchema,
  type ProductDto,
  ProductTypeEnum,
  UpdateProductSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ProductsService } from './products.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateProductDto extends createZodDto(CreateProductSchema) {}
class UpdateProductDto extends createZodDto(UpdateProductSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @RequirePermission('products:read')
  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('isActive') isActive?: string,
    @Query('type') type?: string,
  ): Promise<ProductDto[]> {
    const parsedType = type ? ProductTypeEnum.parse(type) : undefined;
    return this.products.list(user.tenantId, {
      ...(isActive === 'true' ? { isActive: true } : {}),
      ...(isActive === 'false' ? { isActive: false } : {}),
      ...(parsedType ? { type: parsedType } : {}),
    });
  }

  @RequirePermission('products:read')
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ProductDto> {
    return this.products.detail(user.tenantId, id);
  }

  @RequirePermission('products:manage')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateProductDto,
    @Req() req: Request,
  ): Promise<ProductDto> {
    return this.products.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('products:manage')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateProductDto,
    @Req() req: Request,
  ): Promise<ProductDto> {
    return this.products.update({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('products:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.products.remove({
      tenantId: user.tenantId,
      userId: user.sub,
      id,
      meta: extractMeta(req),
    });
  }
}
