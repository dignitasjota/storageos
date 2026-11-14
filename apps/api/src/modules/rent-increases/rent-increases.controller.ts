import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  CreateRentIncreaseSchema,
  PreviewRentIncreaseNoticeSchema,
  PreviewRentIncreaseSchema,
  RentIncreasePolicySchema,
  UpdateRentIncreaseNoticeTemplateSchema,
  type RentIncreaseDto,
  type RentIncreaseNoticePreviewDto,
  type RentIncreaseNoticeTemplateDto,
  type RentIncreasePolicyDto,
  type RentIncreasePreviewDto,
  type RentIncreaseResultsDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { RentIncreasesService } from './rent-increases.service';

class CreateRentIncreaseDto extends createZodDto(CreateRentIncreaseSchema) {}
class PreviewRentIncreaseDto extends createZodDto(PreviewRentIncreaseSchema) {}
class RentIncreasePolicyDto2 extends createZodDto(RentIncreasePolicySchema) {}
class NoticeTemplateBody extends createZodDto(UpdateRentIncreaseNoticeTemplateSchema) {}
class NoticePreviewBody extends createZodDto(PreviewRentIncreaseNoticeSchema) {}

@Controller('rent-increases')
@RequireFeature('rent_increases')
export class RentIncreasesController {
  constructor(private readonly service: RentIncreasesService) {}

  @RequirePermission('contracts:read')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<RentIncreaseDto[]> {
    return this.service.list(user.tenantId, user.facilityScope ?? null);
  }

  /** Política de subidas (tope % anual + meses mínimos entre subidas). Antes de `:id`. */
  @RequirePermission('contracts:read')
  @Get('policy')
  getPolicy(@CurrentUser() user: AuthenticatedUser): Promise<RentIncreasePolicyDto> {
    return this.service.getPolicy(user.tenantId);
  }

  @RequirePermission('contracts:manage')
  @Patch('policy')
  updatePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RentIncreasePolicyDto2,
  ): Promise<RentIncreasePolicyDto> {
    return this.service.updatePolicy({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Texto del aviso que recibe el inquilino. Antes de `:id`. */
  @RequirePermission('contracts:read')
  @Get('notice-template')
  getNoticeTemplate(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RentIncreaseNoticeTemplateDto> {
    return this.service.getNoticeTemplate(user.tenantId);
  }

  @RequirePermission('contracts:manage')
  @Put('notice-template')
  updateNoticeTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: NoticeTemplateBody,
  ): Promise<RentIncreaseNoticeTemplateDto> {
    return this.service.updateNoticeTemplate({
      tenantId: user.tenantId,
      userId: user.sub,
      template: body.template,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Cómo le llegará el aviso (a un contrato concreto o con datos de ejemplo). */
  @RequirePermission('contracts:manage')
  @Post('notice-preview')
  @HttpCode(HttpStatus.OK)
  previewNotice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: NoticePreviewBody,
  ): Promise<RentIncreaseNoticePreviewDto> {
    return this.service.previewNotice(user.tenantId, body);
  }

  @RequirePermission('contracts:read')
  @Get(':id')
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RentIncreaseDto> {
    return this.service.detail(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Previsualiza los contratos afectados y el delta de MRR (sin persistir). */
  @RequirePermission('contracts:manage')
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PreviewRentIncreaseDto,
  ): Promise<RentIncreasePreviewDto> {
    return this.service.preview(user.tenantId, body, user.facilityScope ?? null);
  }

  @RequirePermission('contracts:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateRentIncreaseDto,
  ): Promise<RentIncreaseDto> {
    return this.service.create({
      tenantId: user.tenantId,
      userId: user.sub,
      input: body,
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('contracts:manage')
  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RentIncreaseDto> {
    return this.service.apply(user.tenantId, id, user.facilityScope ?? null, user.sub);
  }

  /** Lo que ha dado: ingreso de verdad y bajas desde el aviso. */
  @RequirePermission('contracts:read')
  @Get(':id/results')
  results(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RentIncreaseResultsDto> {
    return this.service.results(user.tenantId, id, user.facilityScope ?? null);
  }

  /** Quita un contrato de una subida sin aplicar (se le avisa si ya tenía el aviso). */
  @RequirePermission('contracts:manage')
  @Post(':id/items/:itemId/remove')
  @HttpCode(HttpStatus.OK)
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ): Promise<RentIncreaseDto> {
    return this.service.removeItem({
      tenantId: user.tenantId,
      rentIncreaseId: id,
      itemId,
      userId: user.sub,
      facilityScope: user.facilityScope ?? null,
    });
  }

  /** Vuelve a enviar el aviso a un contrato pendiente. */
  @RequirePermission('contracts:manage')
  @Post(':id/items/:itemId/resend')
  @HttpCode(HttpStatus.OK)
  resendNotice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
  ): Promise<RentIncreaseDto> {
    return this.service.resendNotice({
      tenantId: user.tenantId,
      rentIncreaseId: id,
      itemId,
      facilityScope: user.facilityScope ?? null,
    });
  }

  @RequirePermission('contracts:manage')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RentIncreaseDto> {
    return this.service.cancel(user.tenantId, id, user.facilityScope ?? null, user.sub);
  }
}
