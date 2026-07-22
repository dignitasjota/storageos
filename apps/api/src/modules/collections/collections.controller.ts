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
  Query,
} from '@nestjs/common';
import {
  CancelCaseSchema,
  CaseNoteSchema,
  CompleteDisposalSchema,
  OpenCaseSchema,
  OverlockCaseSchema,
  RegisterCaseFileSchema,
  RequestCaseFileUploadSchema,
  SendNoticeSchema,
  StartDisposalSchema,
  UpdateCollectionsSettingsSchema,
  type CollectionsSettingsResponse,
  type DelinquencyCaseDetailDto,
  type DelinquencyCaseDto,
  type DelinquencyCaseStatus,
  type DelinquencyRequirementPdfDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CollectionsRequirementPdfService } from './collections-requirement-pdf.service';
import { CollectionsService } from './collections.service';

class OpenCaseDto extends createZodDto(OpenCaseSchema) {}
class OverlockCaseDto extends createZodDto(OverlockCaseSchema) {}
class SendNoticeDto extends createZodDto(SendNoticeSchema) {}
class StartDisposalDto extends createZodDto(StartDisposalSchema) {}
class CompleteDisposalDto extends createZodDto(CompleteDisposalSchema) {}
class CancelCaseDto extends createZodDto(CancelCaseSchema) {}
class CaseNoteDto extends createZodDto(CaseNoteSchema) {}
class UpdateCollectionsSettingsDto extends createZodDto(UpdateCollectionsSettingsSchema) {}
class RequestCaseFileUploadDto extends createZodDto(RequestCaseFileUploadSchema) {}
class RegisterCaseFileDto extends createZodDto(RegisterCaseFileSchema) {}

/**
 * Expedientes de impago (overlock → requerimiento → disposición). Gated por la
 * feature `collections`. Config (`settings:read/manage`); operativa
 * (`collections:read` todos / `collections:manage` owner+manager).
 */
@RequireFeature('collections')
@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly service: CollectionsService,
    private readonly requirementPdf: CollectionsRequirementPdfService,
  ) {}

  @RequirePermission('settings:read')
  @Get('settings')
  getSettings(@CurrentUser() user: AuthenticatedUser): Promise<CollectionsSettingsResponse> {
    return this.service.getSettings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Put('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateCollectionsSettingsDto,
  ): Promise<CollectionsSettingsResponse> {
    return this.service.updateSettings(user.tenantId, user.sub, body);
  }

  @RequirePermission('collections:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: DelinquencyCaseStatus,
  ): Promise<DelinquencyCaseDto[]> {
    return this.service.list(user.tenantId, {
      ...(status ? { status } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('collections:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DelinquencyCaseDetailDto> {
    return this.service.getDetail(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('collections:manage')
  @Post()
  open(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: OpenCaseDto,
  ): Promise<DelinquencyCaseDto> {
    return this.service.openManual(user.tenantId, user.sub, body, user.facilityScope ?? null);
  }

  @RequirePermission('collections:manage')
  @Post(':id/overlock')
  @HttpCode(HttpStatus.OK)
  overlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: OverlockCaseDto,
  ): Promise<DelinquencyCaseDto> {
    return this.service.overlock(user.tenantId, user.sub, id, body, user.facilityScope ?? null);
  }

  @RequirePermission('collections:manage')
  @Post(':id/notice')
  @HttpCode(HttpStatus.OK)
  notice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SendNoticeDto,
  ): Promise<DelinquencyCaseDto> {
    return this.service.sendNotice(user.tenantId, user.sub, id, body, user.facilityScope ?? null);
  }

  @RequirePermission('collections:manage')
  @Post(':id/resolution-pending')
  @HttpCode(HttpStatus.OK)
  resolutionPending(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DelinquencyCaseDto> {
    return this.service.markResolutionPending(
      user.tenantId,
      user.sub,
      id,
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('collections:manage')
  @Post(':id/disposal')
  @HttpCode(HttpStatus.OK)
  disposal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: StartDisposalDto,
  ): Promise<DelinquencyCaseDto> {
    return this.service.startDisposal(
      user.tenantId,
      user.sub,
      id,
      body,
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('collections:manage')
  @Post(':id/complete-disposal')
  @HttpCode(HttpStatus.OK)
  completeDisposal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CompleteDisposalDto,
  ): Promise<DelinquencyCaseDto> {
    return this.service.completeDisposal(
      user.tenantId,
      user.sub,
      id,
      body,
      user.facilityScope ?? null,
    );
  }

  @RequirePermission('collections:manage')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CancelCaseDto,
  ): Promise<DelinquencyCaseDto> {
    return this.service.cancel(user.tenantId, user.sub, id, body, user.facilityScope ?? null);
  }

  /** Genera el PDF del requerimiento fehaciente (carta a enviar por burofax). */
  @RequirePermission('collections:manage')
  @Post(':id/requirement-pdf')
  @HttpCode(HttpStatus.OK)
  requirementPdfGen(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DelinquencyRequirementPdfDto> {
    return this.requirementPdf.generate({
      tenantId: user.tenantId,
      userId: user.sub,
      caseId: id,
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('collections:manage')
  @Post(':id/note')
  @HttpCode(HttpStatus.NO_CONTENT)
  async note(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CaseNoteDto,
  ): Promise<void> {
    await this.service.addNote(user.tenantId, user.sub, id, body.note, user.facilityScope ?? null);
  }

  @RequirePermission('collections:manage')
  @Post(':id/files/upload-url')
  @HttpCode(HttpStatus.OK)
  uploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RequestCaseFileUploadDto,
  ): Promise<{ uploadUrl: string; objectKey: string }> {
    return this.service.requestFileUpload(user.tenantId, id, body, user.facilityScope ?? null);
  }

  @RequirePermission('collections:manage')
  @Post(':id/files')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerFile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RegisterCaseFileDto,
  ): Promise<void> {
    await this.service.registerFile(user.tenantId, user.sub, id, body, user.facilityScope ?? null);
  }
}
