import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  LegalSlugEnum,
  UpdateLegalDocumentSchema,
  UpdatePlatformBannerSchema,
  UpdatePlatformFounderOfferSchema,
  RequestPlatformLogoUploadSchema,
  SetPlatformLogoSchema,
  UpdatePlatformFooterSchema,
  UpdatePlatformSeoSchema,
  type LegalDocumentDto,
  type LegalSlug,
  type PlatformBannerDto,
  type PlatformFounderOfferDto,
  type PlatformLogoUploadDto,
  type PlatformWebsiteDto,
  type SuperAdminNotificationDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { AdminAudit } from '../admin/admin-audit.decorator';
import { AdminGuard } from '../admin/admin.guard';
import { RequireSuperadmin } from '../admin/require-superadmin.decorator';

import { PlatformService } from './platform.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class UpdateBannerDto extends createZodDto(UpdatePlatformBannerSchema) {}
class UpdateLegalDto extends createZodDto(UpdateLegalDocumentSchema) {}
class UpdateFounderOfferDto extends createZodDto(UpdatePlatformFounderOfferSchema) {}
class RequestLogoUploadDto extends createZodDto(RequestPlatformLogoUploadSchema) {}
class SetLogoDto extends createZodDto(SetPlatformLogoSchema) {}
class UpdateFooterDto extends createZodDto(UpdatePlatformFooterSchema) {}
class UpdateSeoDto extends createZodDto(UpdatePlatformSeoSchema) {}

function parseSlug(slug: string): LegalSlug {
  const parsed = LegalSlugEnum.safeParse(slug);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'invalid_legal_slug', message: 'Documento no válido' });
  }
  return parsed.data;
}

/** Banner global visible por los tenants (endpoint público autenticado por tenant). */
@Controller('platform-banner')
export class PlatformBannerPublicController {
  constructor(private readonly service: PlatformService) {}

  @Get()
  get(): Promise<PlatformBannerDto | null> {
    return this.service.getPublicBanner();
  }
}

/** Documentos legales (términos, privacidad) — totalmente públicos (landing). */
@Public()
@Controller('platform-legal')
export class PlatformLegalPublicController {
  constructor(private readonly service: PlatformService) {}

  @Get(':slug')
  get(@Param('slug') slug: string): Promise<LegalDocumentDto> {
    return this.service.getLegal(parseSlug(slug));
  }
}

/** Oferta fundador de la web de TrasterOS (pública: la lee la landing). */
@Public()
@Controller('platform-founder-offer')
export class PlatformFounderOfferPublicController {
  constructor(private readonly service: PlatformService) {}

  @Get()
  async get(): Promise<{ offer: PlatformFounderOfferDto | null }> {
    return { offer: await this.service.getPublicFounderOffer() };
  }
}

/** Ajustes de la web de TrasterOS (logo). Públicos: los lee la landing. */
@Public()
@Controller('platform-website')
export class PlatformWebsitePublicController {
  constructor(private readonly service: PlatformService) {}

  @Get()
  get(): Promise<PlatformWebsiteDto> {
    return this.service.getWebsite();
  }
}

/** Gestión del banner + feed de notificaciones. Solo super admin. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/platform')
export class PlatformAdminController {
  constructor(private readonly service: PlatformService) {}

  @Get('banner')
  getBanner(): Promise<PlatformBannerDto> {
    return this.service.getBanner();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.banner_updated')
  @Put('banner')
  updateBanner(@Body() body: UpdateBannerDto): Promise<PlatformBannerDto> {
    return this.service.updateBanner(body);
  }

  @Get('founder-offer')
  getFounderOffer(): Promise<PlatformFounderOfferDto> {
    return this.service.getFounderOffer();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.founder_offer_updated')
  @Put('founder-offer')
  updateFounderOffer(@Body() body: UpdateFounderOfferDto): Promise<PlatformFounderOfferDto> {
    return this.service.updateFounderOffer(body);
  }

  @Get('website')
  getWebsite(): Promise<PlatformWebsiteDto> {
    return this.service.getWebsite();
  }

  @RequireSuperadmin()
  @Post('website/logo-upload-url')
  @HttpCode(HttpStatus.OK)
  requestLogoUpload(@Body() body: RequestLogoUploadDto): Promise<PlatformLogoUploadDto> {
    return this.service.requestLogoUpload(body.mimeType);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.website_seo_updated')
  @Put('website/seo')
  updateSeo(@Body() body: UpdateSeoDto): Promise<PlatformWebsiteDto> {
    return this.service.updateSeo(body);
  }

  @RequireSuperadmin()
  @Post('website/og-image-upload-url')
  @HttpCode(HttpStatus.OK)
  requestOgImageUpload(@Body() body: RequestLogoUploadDto): Promise<PlatformLogoUploadDto> {
    return this.service.requestOgImageUpload(body.mimeType);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.website_og_image_updated')
  @Put('website/og-image')
  setOgImage(@Body() body: SetLogoDto): Promise<PlatformWebsiteDto> {
    return this.service.setOgImage(body.key);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.website_footer_updated')
  @Put('website/footer')
  updateFooter(@Body() body: UpdateFooterDto): Promise<PlatformWebsiteDto> {
    return this.service.updateFooter(body);
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.website_logo_updated')
  @Put('website/logo')
  setLogo(@Body() body: SetLogoDto): Promise<PlatformWebsiteDto> {
    return this.service.setLogo(body.key);
  }

  @Get('notifications')
  listNotifications(): Promise<SuperAdminNotificationDto[]> {
    return this.service.listNotifications();
  }

  @Get('notifications/page')
  pageNotifications(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('unread') unread?: string,
  ): Promise<{ items: SuperAdminNotificationDto[]; nextCursor: string | null }> {
    if (cursor && !UUID_RE.test(cursor)) {
      throw new BadRequestException({ code: 'invalid_cursor', message: 'Cursor no válido' });
    }
    return this.service.pageNotifications({
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit: Number(limit) || 30 } : {}),
      unread: unread === 'true',
    });
  }

  @Post('notifications/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.markRead(id);
  }

  @Get('notifications/unread-count')
  unreadCount(): Promise<{ count: number }> {
    return this.service.unreadCount();
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(): Promise<void> {
    await this.service.markAllRead();
  }

  @Get('legal/:slug')
  getLegal(@Param('slug') slug: string): Promise<LegalDocumentDto> {
    return this.service.getLegal(parseSlug(slug));
  }

  @RequireSuperadmin()
  @AdminAudit('admin.platform.legal_updated')
  @Put('legal/:slug')
  updateLegal(
    @Param('slug') slug: string,
    @Body() body: UpdateLegalDto,
  ): Promise<LegalDocumentDto> {
    return this.service.updateLegal(parseSlug(slug), body);
  }
}
