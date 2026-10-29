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
} from '@nestjs/common';
import {
  ApplyReminderTemplateSchema,
  CompleteBusinessReminderSchema,
  CreateBusinessReminderSchema,
  RequestReminderReceiptUploadSchema,
  SnoozeBusinessReminderSchema,
  UpdateBusinessReminderSchema,
  UpdateBusinessReminderSettingsSchema,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../common/decorators/require-feature.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { BusinessRemindersService } from './business-reminders.service';

import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import type {
  BusinessReminderCompletionDto,
  BusinessReminderDto,
  BusinessReminderSettingsDto,
  BusinessRemindersListDto,
  ReminderReceiptUploadDto,
  ReminderTemplateDto,
} from '@storageos/shared';

class CreateDto extends createZodDto(CreateBusinessReminderSchema) {}
class UpdateDto extends createZodDto(UpdateBusinessReminderSchema) {}
class CompleteDto extends createZodDto(CompleteBusinessReminderSchema) {}
class SnoozeDto extends createZodDto(SnoozeBusinessReminderSchema) {}
class ReceiptUploadDto extends createZodDto(RequestReminderReceiptUploadSchema) {}
class ApplyTemplateDto extends createZodDto(ApplyReminderTemplateSchema) {}
class SettingsDto extends createZodDto(UpdateBusinessReminderSettingsSchema) {}

/** Vencimientos del negocio (función `business_reminders`, planes de pago). */
@RequireFeature('business_reminders')
@Controller('business-reminders')
export class BusinessRemindersController {
  constructor(private readonly reminders: BusinessRemindersService) {}

  @RequirePermission('reminders:read')
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('includeDone') includeDone?: string,
  ): Promise<BusinessRemindersListDto> {
    return this.reminders.list(user.tenantId, {
      facilityScope: user.facilityScope ?? null,
      includeDone: includeDone === '1' || includeDone === 'true',
    });
  }

  @RequirePermission('reminders:read')
  @Get('templates')
  templates(@CurrentUser() user: AuthenticatedUser): Promise<ReminderTemplateDto[]> {
    return this.reminders.templates(user.tenantId);
  }

  @RequirePermission('reminders:manage')
  @Post('templates/:key/apply')
  applyTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Body() input: ApplyTemplateDto,
  ): Promise<BusinessReminderDto[]> {
    return this.reminders.applyTemplate(user.tenantId, user.sub, user.facilityScope ?? null, key, {
      ...(input.dueDate ? { dueDate: input.dueDate } : {}),
      facilityId: input.facilityId ?? null,
    });
  }

  @RequirePermission('reminders:read')
  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<BusinessReminderSettingsDto> {
    return this.reminders.getSettings(user.tenantId);
  }

  @RequirePermission('reminders:manage')
  @Patch('settings')
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: SettingsDto,
  ): Promise<BusinessReminderSettingsDto> {
    return this.reminders.updateSettings(user.tenantId, input);
  }

  @RequirePermission('reminders:manage')
  @Post('settings/calendar')
  regenerateCalendar(@CurrentUser() user: AuthenticatedUser): Promise<BusinessReminderSettingsDto> {
    return this.reminders.regenerateIcs(user.tenantId);
  }

  @RequirePermission('reminders:manage')
  @Delete('settings/calendar')
  revokeCalendar(@CurrentUser() user: AuthenticatedUser): Promise<BusinessReminderSettingsDto> {
    return this.reminders.revokeIcs(user.tenantId);
  }

  @RequirePermission('reminders:manage')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateDto,
  ): Promise<BusinessReminderDto> {
    return this.reminders.create(user.tenantId, user.sub, user.facilityScope ?? null, input);
  }

  @RequirePermission('reminders:read')
  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BusinessReminderDto> {
    return this.reminders.get(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('reminders:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateDto,
  ): Promise<BusinessReminderDto> {
    return this.reminders.update(user.tenantId, id, user.facilityScope ?? null, input);
  }

  @RequirePermission('reminders:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.reminders.remove(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('reminders:manage')
  @Post(':id/snooze')
  @HttpCode(HttpStatus.OK)
  snooze(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: SnoozeDto,
  ): Promise<BusinessReminderDto> {
    return this.reminders.snooze(user.tenantId, id, user.facilityScope ?? null, input.days);
  }

  @RequirePermission('reminders:manage')
  @Post(':id/receipt-upload-url')
  receiptUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ReceiptUploadDto,
  ): Promise<ReminderReceiptUploadDto> {
    return this.reminders.receiptUploadUrl(
      user.tenantId,
      id,
      user.facilityScope ?? null,
      input.mimeType,
    );
  }

  @RequirePermission('reminders:manage')
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CompleteDto,
  ): Promise<BusinessReminderDto> {
    return this.reminders.complete(user.tenantId, user.sub, id, user.facilityScope ?? null, input);
  }

  @RequirePermission('reminders:read')
  @Get(':id/completions')
  completions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BusinessReminderCompletionDto[]> {
    return this.reminders.completions(user.tenantId, id, user.facilityScope ?? null);
  }

  @RequirePermission('reminders:read')
  @Get(':id/completions/:completionId/receipt')
  receipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('completionId', ParseUUIDPipe) completionId: string,
  ): Promise<{ url: string }> {
    return this.reminders.receiptUrl(user.tenantId, id, completionId, user.facilityScope ?? null);
  }
}
