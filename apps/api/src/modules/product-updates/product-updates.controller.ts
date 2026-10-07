import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  UpsertProductUpdateSchema,
  type AdminProductUpdateDto,
  type ProductUpdateDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AdminGuard } from '../admin/admin.guard';
import {
  type AuthenticatedSuperAdmin,
  CurrentSuperAdmin,
} from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { ProductUpdatesService } from './product-updates.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

class UpsertProductUpdateDto extends createZodDto(UpsertProductUpdateSchema) {}

/** Novedades vistas por cualquier usuario del tenant (sin permiso especial). */
@Controller('product-updates')
export class ProductUpdatesController {
  constructor(private readonly service: ProductUpdatesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ProductUpdateDto[]> {
    return this.service.listForUser(user.tenantId, user.sub);
  }

  @Get('unread-count')
  unread(@CurrentUser() user: AuthenticatedUser): Promise<{ count: number }> {
    return this.service.unreadCount(user.tenantId, user.sub);
  }

  @Post('seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  async seen(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.service.markSeen(user.tenantId, user.sub);
  }
}

/** Gestión de las novedades (super admin; escribir solo el rol superadmin). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/product-updates')
export class AdminProductUpdatesController {
  constructor(private readonly service: ProductUpdatesService) {}

  @Get()
  list(): Promise<AdminProductUpdateDto[]> {
    return this.service.adminList();
  }

  @Post()
  @RequireSuperadmin()
  create(
    @Body() body: UpsertProductUpdateDto,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<AdminProductUpdateDto> {
    return this.service.create(body, admin.sub);
  }

  @Put(':id')
  @RequireSuperadmin()
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpsertProductUpdateDto,
  ): Promise<AdminProductUpdateDto> {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.remove(id);
  }
}
