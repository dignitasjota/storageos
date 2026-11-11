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
  Req,
} from '@nestjs/common';
import {
  ApprovePickupSchema,
  CancelCaseSchema,
  CaseChargeSchema,
  CaseNoteSchema,
  CustodyActSchema,
  CompleteDisposalSchema,
  DELINQUENCY_CASE_STATUSES,
  MIN_NOTICE_DAYS,
  MoveGoodsSchema,
  NoticeReceivedSchema,
  OpenCaseSchema,
  OverlockCaseSchema,
  RegisterCaseFileSchema,
  RejectPickupSchema,
  RemoveOverlockSchema,
  RequestCaseFileUploadSchema,
  RequirementPdfSchema,
  ResolveContractSchema,
  SendNoticeSchema,
  StartDisposalSchema,
  SurplusReturnedSchema,
  UpdateCollectionsSettingsSchema,
  type CollectionsSettingsResponse,
  type CollectionsSummaryDto,
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

import { CollectionsDocumentsService } from './collections-documents.service';
import { CollectionsExtrasService } from './collections-extras.service';
import { CollectionsRequirementPdfService } from './collections-requirement-pdf.service';
import { CollectionsService } from './collections.service';

import type { Request } from 'express';

class OpenCaseDto extends createZodDto(OpenCaseSchema) {}
class OverlockCaseDto extends createZodDto(OverlockCaseSchema) {}
class SendNoticeDto extends createZodDto(SendNoticeSchema) {}
class StartDisposalDto extends createZodDto(StartDisposalSchema) {}
class CompleteDisposalDto extends createZodDto(CompleteDisposalSchema) {}
class CancelCaseDto extends createZodDto(CancelCaseSchema) {}
class NoticeReceivedDto extends createZodDto(NoticeReceivedSchema) {}
class ResolveContractDto extends createZodDto(ResolveContractSchema) {}
class MoveGoodsDto extends createZodDto(MoveGoodsSchema) {}
class RemoveOverlockDto extends createZodDto(RemoveOverlockSchema) {}
class SurplusReturnedDto extends createZodDto(SurplusReturnedSchema) {}
class CaseChargeDto extends createZodDto(CaseChargeSchema) {}
class CustodyActDto extends createZodDto(CustodyActSchema) {}
class ApprovePickupDto extends createZodDto(ApprovePickupSchema) {}
class RejectPickupDto extends createZodDto(RejectPickupSchema) {}

function metaOf(req: Request): { ipAddress?: string; userAgent?: string } {
  return {
    ...(req.ip ? { ipAddress: req.ip } : {}),
    ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function facilityParam(facilityId: string | undefined): string | undefined {
  if (!facilityId) return undefined;
  if (!UUID_RE.test(facilityId)) {
    throw new BadRequestException({ code: 'invalid_facility_id', message: 'Local no válido' });
  }
  return facilityId;
}

function statusParam(status: string | undefined): DelinquencyCaseStatus | undefined {
  if (!status) return undefined;
  if (!(DELINQUENCY_CASE_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException({ code: 'invalid_status', message: 'Estado no válido' });
  }
  return status as DelinquencyCaseStatus;
}
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
    private readonly extras: CollectionsExtrasService,
    private readonly documents: CollectionsDocumentsService,
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
    @Query('status') status?: string,
    @Query('facilityId') facilityId?: string,
  ): Promise<DelinquencyCaseDto[]> {
    const facility = facilityParam(facilityId);
    const state = statusParam(status);
    return this.service.list(user.tenantId, {
      ...(facility ? { facilityId: facility } : {}),
      ...(state ? { status: state } : {}),
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Vista rápida de expedientes abiertos (Resumen del panel). Antes de `:id`. */
  @RequirePermission('collections:read')
  @Get('summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('facilityId') facilityId?: string,
  ): Promise<CollectionsSummaryDto> {
    return this.service.getSummary(
      user.tenantId,
      user.facilityScope ?? null,
      facilityParam(facilityId),
    );
  }

  /** Expediente abierto de un contrato (para el badge de overlock). Antes de `:id`. */
  @RequirePermission('collections:read')
  @Get('by-contract/:contractId')
  byContract(
    @CurrentUser() user: AuthenticatedUser,
    @Param('contractId', new ParseUUIDPipe()) contractId: string,
  ): Promise<{ case: DelinquencyCaseDto | null }> {
    return this.service
      .findActiveByContract(user.tenantId, contractId, user.facilityScope ?? null)
      .then((c) => ({ case: c }));
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

  /** El inquilino recibió el requerimiento: el plazo cuenta desde ese día. */
  @RequirePermission('collections:manage')
  @Post(':id/notice-received')
  @HttpCode(HttpStatus.OK)
  noticeReceived(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: NoticeReceivedDto,
  ): Promise<DelinquencyCaseDto> {
    return this.service.noticeReceived(
      user.tenantId,
      user.sub,
      id,
      body,
      user.facilityScope ?? null,
    );
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

  /** Pasado el plazo: el contrato queda resuelto (condición 12). */
  @RequirePermission('collections:manage')
  @Post(':id/resolve-contract')
  @HttpCode(HttpStatus.OK)
  resolveContract(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveContractDto,
    @Req() req: Request,
  ): Promise<DelinquencyCaseDto> {
    return this.service.resolveContract(
      user.tenantId,
      user.sub,
      id,
      body,
      user.facilityScope ?? null,
      {
        ...(req.ip ? { ipAddress: req.ip } : {}),
        ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
      },
    );
  }

  /** Traslado de los bienes con inventario a un lugar de custodia. */
  @RequirePermission('collections:manage')
  @Post(':id/move-goods')
  @HttpCode(HttpStatus.OK)
  moveGoods(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: MoveGoodsDto,
  ): Promise<DelinquencyCaseDto> {
    return this.service.moveGoods(user.tenantId, user.sub, id, body, user.facilityScope ?? null);
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
    @Body() body: unknown,
  ): Promise<DelinquencyRequirementPdfDto> {
    // El cuerpo es opcional: sin él, el plazo registrado o el de los ajustes.
    const parsed = RequirementPdfSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'invalid_notice_days',
        message: `El plazo va de ${MIN_NOTICE_DAYS} a 180 días`,
      });
    }
    return this.requirementPdf.generate({
      tenantId: user.tenantId,
      userId: user.sub,
      caseId: id,
      facilityScope: user.facilityScope ?? null,
      ...(parsed.data.noticeDays ? { noticeDays: parsed.data.noticeDays } : {}),
    });
  }

  /** Se quita el candado (pagó, plan de pagos, retiró los bienes…). */
  @RequirePermission('collections:manage')
  @Post(':id/remove-overlock')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeOverlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RemoveOverlockDto,
  ): Promise<void> {
    await this.extras.removeOverlock(user.tenantId, user.sub, id, body, user.facilityScope ?? null);
  }

  /** Lo que sobró de la liquidación ya se le devolvió. */
  @RequirePermission('collections:manage')
  @Post(':id/surplus-returned')
  @HttpCode(HttpStatus.NO_CONTENT)
  async surplusReturned(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SurplusReturnedDto,
  ): Promise<void> {
    await this.extras.markSurplusReturned(
      user.tenantId,
      user.sub,
      id,
      body,
      user.facilityScope ?? null,
    );
  }

  /** Gastos del traslado o la custodia, facturados al inquilino. */
  @RequirePermission('collections:manage')
  @Post(':id/charges')
  @HttpCode(HttpStatus.OK)
  charge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CaseChargeDto,
    @Req() req: Request,
  ): Promise<{ invoiceId: string; invoiceNumber: string }> {
    return this.extras.addCharge(
      user.tenantId,
      user.sub,
      id,
      body,
      user.facilityScope ?? null,
      metaOf(req),
    );
  }

  /** Concede la cita para retirar los bienes (día y franja). */
  @RequirePermission('collections:manage')
  @Post(':id/pickups/:pickupId/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approvePickup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('pickupId', new ParseUUIDPipe()) pickupId: string,
    @Body() body: ApprovePickupDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.extras.approvePickup({
      tenantId: user.tenantId,
      userId: user.sub,
      caseId: id,
      pickupId,
      input: body,
      facilityScope: user.facilityScope ?? null,
      meta: metaOf(req),
    });
  }

  @RequirePermission('collections:manage')
  @Post(':id/pickups/:pickupId/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async rejectPickup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('pickupId', new ParseUUIDPipe()) pickupId: string,
    @Body() body: RejectPickupDto,
  ): Promise<void> {
    await this.extras.rejectPickup({
      tenantId: user.tenantId,
      userId: user.sub,
      caseId: id,
      pickupId,
      input: body,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** El inquilino retiró sus bienes en la cita. */
  @RequirePermission('collections:manage')
  @Post(':id/pickups/:pickupId/done')
  @HttpCode(HttpStatus.NO_CONTENT)
  async pickupDone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('pickupId', new ParseUUIDPipe()) pickupId: string,
  ): Promise<void> {
    await this.extras.completePickup({
      tenantId: user.tenantId,
      userId: user.sub,
      caseId: id,
      pickupId,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Acta del traslado y la custodia (PDF), con el inventario. */
  @RequirePermission('collections:manage')
  @Post(':id/custody-act-pdf')
  @HttpCode(HttpStatus.OK)
  custodyActPdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CustodyActDto,
  ): Promise<{ url: string }> {
    return this.documents.custodyAct({
      tenantId: user.tenantId,
      userId: user.sub,
      caseId: id,
      input: body,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Dossier del expediente (PDF) con todo lo que acredita el impago. */
  @RequirePermission('collections:manage')
  @Post(':id/dossier-pdf')
  @HttpCode(HttpStatus.OK)
  dossierPdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ url: string }> {
    return this.documents.dossier({
      tenantId: user.tenantId,
      userId: user.sub,
      caseId: id,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Borrador de la petición de juicio monitorio (PDF). */
  @RequirePermission('collections:manage')
  @Post(':id/monitorio-pdf')
  @HttpCode(HttpStatus.OK)
  monitorioPdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ url: string }> {
    return this.documents.monitorio({
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
