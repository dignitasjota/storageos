import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CUSTOMER_EMAIL_KINDS,
  CustomerEmailPreviewQuerySchema,
  SendCustomerEmailTestSchema,
  UpdateCustomerEmailSettingsSchema,
  UpdateEmailReplyToSchema,
  UpdateStaffEmailSettingsSchema,
  type CustomerEmailKind,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { CustomerEmailPreviewService } from './customer-email-preview.service';
import { CustomerEmailsService } from './customer-emails.service';
import { StaffEmailsService } from './staff-emails.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type {
  CustomerEmailPreviewDto,
  CustomerEmailSettingsDto,
  CustomerEmailTestResultDto,
  EmailReplyToDto,
  MyEmailNoticesDto,
  StaffEmailSettingsDto,
} from '@storageos/shared';

class UpdateCustomerEmailSettingsDto extends createZodDto(UpdateCustomerEmailSettingsSchema) {}
class SendCustomerEmailTestDto extends createZodDto(SendCustomerEmailTestSchema) {}
class UpdateEmailReplyToDto extends createZodDto(UpdateEmailReplyToSchema) {}

/** Comprueba que `kind` es un correo automático al inquilino. */
function parseKind(kind: string): CustomerEmailKind {
  if (!(CUSTOMER_EMAIL_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException({
      code: 'unknown_email_kind',
      message: 'Ese correo automático no existe',
    });
  }
  return kind as CustomerEmailKind;
}

/** Qué correos automáticos reciben los inquilinos del tenant. */
@Controller('settings/tenant/customer-emails')
export class CustomerEmailsController {
  constructor(
    private readonly service: CustomerEmailsService,
    private readonly previews: CustomerEmailPreviewService,
  ) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<CustomerEmailSettingsDto> {
    return this.service.getSettings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateCustomerEmailSettingsDto,
  ): Promise<CustomerEmailSettingsDto> {
    return this.service.updateSettings(user.tenantId, user.sub, body);
  }

  /** El correo tal como lo recibe el inquilino, con datos de ejemplo. */
  @RequirePermission('settings:read')
  @Get(':kind/preview')
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: string,
    @Query() query: Record<string, unknown>,
  ): Promise<CustomerEmailPreviewDto> {
    const parsed = CustomerEmailPreviewQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid_locale', message: 'Idioma no válido' });
    }
    return this.previews.preview(user.tenantId, parseKind(kind), parsed.data.locale);
  }

  /** Envía el correo de ejemplo a quien lo pide («[Prueba]» en el asunto). */
  @RequirePermission('settings:manage')
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post(':kind/test')
  @HttpCode(200)
  sendTest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: string,
    @Body() body: SendCustomerEmailTestDto,
  ): Promise<CustomerEmailTestResultDto> {
    return this.previews.sendTest(user.tenantId, user.sub, parseKind(kind), body.locale);
  }
}

/** A qué dirección llegan las respuestas de los inquilinos a los correos del negocio. */
@Controller('settings/tenant/email-reply-to')
export class EmailReplyToController {
  constructor(private readonly previews: CustomerEmailPreviewService) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<EmailReplyToDto> {
    return this.previews.getReplyTo(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateEmailReplyToDto,
  ): Promise<EmailReplyToDto> {
    return this.previews.updateReplyTo(user.tenantId, user.sub, body);
  }
}

class UpdateStaffEmailSettingsDto extends createZodDto(UpdateStaffEmailSettingsSchema) {}

/** Qué avisos por email recibe el equipo (propietarios y gestores). */
@Controller('settings/tenant/staff-emails')
export class StaffEmailsController {
  constructor(private readonly service: StaffEmailsService) {}

  @RequirePermission('settings:read')
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<StaffEmailSettingsDto> {
    return this.service.getSettings(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateStaffEmailSettingsDto,
  ): Promise<StaffEmailSettingsDto> {
    return this.service.updateSettings(user.tenantId, user.sub, body);
  }
}

/** Avisos por correo que recibe el usuario (su perfil; sin permiso especial). */
@Controller('me/email-notices')
export class MyEmailNoticesController {
  constructor(private readonly staff: StaffEmailsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<MyEmailNoticesDto> {
    return this.staff.getMyNotices(user.tenantId, user.sub);
  }

  @Patch()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: UpdateStaffEmailSettingsDto,
  ): Promise<MyEmailNoticesDto> {
    return this.staff.updateMyNotices(user.tenantId, user.sub, body);
  }
}
