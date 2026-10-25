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
  Put,
  Req,
} from '@nestjs/common';
import {
  CreateFacilityDocumentSchema,
  CreateFacilitySchema,
  type FacilityDocumentDto,
  type FacilityDocumentUploadDto,
  type FacilitySummaryDto,
  RequestFacilityDocumentUploadSchema,
  UpdateFacilityDocumentSchema,
  type FacilityDto,
  type FacilityImageUploadResponseDto,
  RequestFacilityImageUploadSchema,
  SetFacilityImagesSchema,
  UpdateFacilitySchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { assertFacilityAllowed } from '../../common/facility-scope';

import { FacilitiesService } from './facilities.service';
import { FacilityDocumentsService } from './facility-documents.service';
import { FacilityInsightsService } from './facility-insights.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class CreateFacilityDto extends createZodDto(CreateFacilitySchema) {}
class UpdateFacilityDto extends createZodDto(UpdateFacilitySchema) {}
class RequestFacilityImageUploadDto extends createZodDto(RequestFacilityImageUploadSchema) {}
class SetFacilityImagesDto extends createZodDto(SetFacilityImagesSchema) {}
class RequestFacilityDocumentUploadDto extends createZodDto(RequestFacilityDocumentUploadSchema) {}
class CreateFacilityDocumentDto extends createZodDto(CreateFacilityDocumentSchema) {}
class UpdateFacilityDocumentDto extends createZodDto(UpdateFacilityDocumentSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('facilities')
export class FacilitiesController {
  constructor(
    private readonly facilities: FacilitiesService,
    private readonly insights: FacilityInsightsService,
    private readonly documents: FacilityDocumentsService,
  ) {}

  @RequirePermission('facilities:read')
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<FacilityDto[]> {
    return this.facilities.list(user.tenantId, user.facilityScope);
  }

  /** Cuotas, m², facturado del mes y trasteros parados de cada local. */
  @RequirePermission('facilities:read')
  @Get('summary')
  async summary(@CurrentUser() user: AuthenticatedUser): Promise<FacilitySummaryDto[]> {
    return this.insights.summary(user.tenantId, user.facilityScope ?? null);
  }

  // --- Documentos del local -------------------------------------------------

  @RequirePermission('facilities:read')
  @Get(':id/documents')
  async listDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<FacilityDocumentDto[]> {
    assertFacilityAllowed(user.facilityScope, id);
    return this.documents.list(user.tenantId, id);
  }

  @RequirePermission('facilities:manage')
  @Post(':id/documents/upload-url')
  @HttpCode(HttpStatus.OK)
  async documentUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RequestFacilityDocumentUploadDto,
  ): Promise<FacilityDocumentUploadDto> {
    assertFacilityAllowed(user.facilityScope, id);
    return this.documents.requestUpload({ tenantId: user.tenantId, facilityId: id, ...input });
  }

  @RequirePermission('facilities:manage')
  @Post(':id/documents')
  async addDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: CreateFacilityDocumentDto,
  ): Promise<FacilityDocumentDto> {
    assertFacilityAllowed(user.facilityScope, id);
    return this.documents.create({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
      input,
    });
  }

  @RequirePermission('facilities:manage')
  @Patch(':id/documents/:documentId')
  async updateDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body() input: UpdateFacilityDocumentDto,
  ): Promise<FacilityDocumentDto> {
    assertFacilityAllowed(user.facilityScope, id);
    return this.documents.update({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
      documentId,
      input,
    });
  }

  @RequirePermission('facilities:manage')
  @Delete(':id/documents/:documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<void> {
    assertFacilityAllowed(user.facilityScope, id);
    await this.documents.remove({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
      documentId,
    });
  }

  @RequirePermission('facilities:read')
  @Get(':id/documents/:documentId/download')
  async downloadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<{ url: string }> {
    assertFacilityAllowed(user.facilityScope, id);
    return this.documents.downloadUrl(user.tenantId, id, documentId);
  }

  @RequirePermission('facilities:read')
  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<FacilityDto> {
    assertFacilityAllowed(user.facilityScope, id);
    return this.facilities.detail(user.tenantId, id);
  }

  @RequirePermission('facilities:manage')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateFacilityDto,
    @Req() req: Request,
  ): Promise<FacilityDto> {
    return this.facilities.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('facilities:manage')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: UpdateFacilityDto,
    @Req() req: Request,
  ): Promise<FacilityDto> {
    assertFacilityAllowed(user.facilityScope, id);
    return this.facilities.update({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
      input,
      meta: extractMeta(req),
    });
  }

  /** Contratos vivos del local sin propietario (creados antes de asignárselo). */
  @RequirePermission('facilities:read')
  @Get(':id/contracts-without-owner')
  async contractsWithoutOwner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ count: number }> {
    assertFacilityAllowed(user.facilityScope, id);
    return { count: await this.facilities.countContractsWithoutOwner(user.tenantId, id) };
  }

  /** Pone el propietario del local a esos contratos (sus facturas futuras las emite él). */
  @RequirePermission('facilities:manage')
  @Post(':id/apply-owner-to-contracts')
  @HttpCode(HttpStatus.OK)
  async applyOwnerToContracts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<{ updated: number }> {
    assertFacilityAllowed(user.facilityScope, id);
    return this.facilities.applyOwnerToContracts({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('facilities:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    assertFacilityAllowed(user.facilityScope, id);
    await this.facilities.softDelete({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
      meta: extractMeta(req),
    });
  }

  @RequirePermission('facilities:manage')
  @Post(':id/images/upload-url')
  @HttpCode(HttpStatus.OK)
  async requestImageUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: RequestFacilityImageUploadDto,
  ): Promise<FacilityImageUploadResponseDto> {
    assertFacilityAllowed(user.facilityScope, id);
    const { uploadUrl, key, expiresIn } = await this.facilities.requestImageUploadUrl({
      tenantId: user.tenantId,
      facilityId: id,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
    return { uploadUrl, key, expiresIn, requiredHeaders: { 'Content-Type': input.mimeType } };
  }

  /** Fija la lista completa de imágenes (añadir/quitar/reordenar) por sus keys. */
  @RequirePermission('facilities:manage')
  @Put(':id/images')
  async setImages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SetFacilityImagesDto,
    @Req() req: Request,
  ): Promise<FacilityDto> {
    assertFacilityAllowed(user.facilityScope, id);
    return this.facilities.setImages({
      tenantId: user.tenantId,
      userId: user.sub,
      facilityId: id,
      images: input.images,
      meta: extractMeta(req),
    });
  }
}
