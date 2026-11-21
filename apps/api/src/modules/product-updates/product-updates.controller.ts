import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  BadRequestException,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ProductUpdateCategoryEnum,
  RequestPlatformLogoUploadSchema,
  SetProductUpdateReactionSchema,
  UpsertProductUpdateSchema,
  type AdminProductUpdateDto,
  type ProductUpdateDto,
  type ProductUpdateReaction,
  type ProductUpdatesDigestResultDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { parsePageRequest } from '../../common/pagination';
import { AdminGuard } from '../admin/admin.guard';
import {
  type AuthenticatedSuperAdmin,
  CurrentSuperAdmin,
} from '../admin/current-super-admin.decorator';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { ProductUpdatesDigestService } from './product-updates-digest.service';
import { ProductUpdatesService, type ProductUpdatesPageDto } from './product-updates.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

class UpsertProductUpdateDto extends createZodDto(UpsertProductUpdateSchema) {}
class ImageUploadDto extends createZodDto(RequestPlatformLogoUploadSchema) {}
class SetReactionDto extends createZodDto(SetProductUpdateReactionSchema) {}

/** Novedades vistas por cualquier usuario del tenant (sin permiso especial). */
@Controller('product-updates')
export class ProductUpdatesController {
  constructor(private readonly service: ProductUpdatesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ProductUpdateDto[]> {
    return this.service.listForUser(user.tenantId, user.sub);
  }

  /**
   * Por páginas (`?cursor=&limit=`), con la fecha hasta la que ya estaban
   * leídas. Filtros: `category` (new|improvement|fix), `search` (título y
   * texto) y `onlyMyPlan=1` (sin las de funciones que el negocio no tiene).
   */
  @Get('page')
  page(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('onlyMyPlan') onlyMyPlan?: string,
  ): Promise<ProductUpdatesPageDto> {
    const parsed = category ? ProductUpdateCategoryEnum.safeParse(category) : null;
    if (parsed && !parsed.success) {
      throw new BadRequestException({ code: 'invalid_category', message: 'Tipo no válido' });
    }
    const text = search?.trim().slice(0, 100);
    return this.service.pageForUser(user.tenantId, user.sub, parsePageRequest(cursor, limit), {
      ...(parsed?.success ? { category: parsed.data } : {}),
      ...(text ? { search: text } : {}),
      onlyMyPlan: onlyMyPlan === '1' || onlyMyPlan === 'true',
    });
  }

  /** La novedad destacada reciente y sin leer que se enseña al entrar (o null). */
  @Get('highlighted')
  async highlighted(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ update: ProductUpdateDto | null }> {
    return { update: await this.service.highlightedForUser(user.tenantId, user.sub) };
  }

  @Get('unread-count')
  unread(@CurrentUser() user: AuthenticatedUser): Promise<{ count: number }> {
    return this.service.unreadCount(user.tenantId, user.sub);
  }

  /** «¿Te ha sido útil?»: 👍 (`up`), 👎 (`down`) o quitarla (`null`). */
  @Put(':id/reaction')
  setReaction(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetReactionDto,
  ): Promise<{ value: ProductUpdateReaction | null }> {
    return this.service.setReaction(user.tenantId, user.sub, id, body.value);
  }

  @Post('seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  async seen(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    // El soporte de TrasterOS que entra en nombre del tenant no gasta la marca
    // de leído de la persona suplantada.
    if (user.impersonation) return;
    await this.service.markSeen(user.tenantId, user.sub);
  }
}

/** Gestión de las novedades (super admin; escribir solo el rol superadmin). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/product-updates')
export class AdminProductUpdatesController {
  constructor(
    private readonly service: ProductUpdatesService,
    private readonly digest: ProductUpdatesDigestService,
  ) {}

  @Get()
  list(): Promise<AdminProductUpdateDto[]> {
    return this.service.adminList();
  }

  /** Subida de la captura de una novedad (PNG, JPG o WebP, bucket público). */
  @Post('image-upload-url')
  @RequireSuperadmin()
  imageUpload(@Body() body: ImageUploadDto) {
    return this.service.requestImageUpload(body.mimeType);
  }

  /**
   * Envía ya el resumen mensual del mes anterior (a quien aún no lo tenga):
   * por si el envío del día 2 no salió.
   */
  @Post('digest/send')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  sendDigest(): Promise<ProductUpdatesDigestResultDto> {
    return this.digest.sendMonthly();
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
