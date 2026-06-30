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
} from '@nestjs/common';
import { CreateFaqEntrySchema, type FaqEntryDto, UpdateFaqEntrySchema } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { FaqService } from './faq.service';

class CreateFaqEntryDto extends createZodDto(CreateFaqEntrySchema) {}
class UpdateFaqEntryDto extends createZodDto(UpdateFaqEntrySchema) {}

/** Gestión del centro de ayuda (lado staff). */
@Controller('faq-entries')
export class FaqController {
  constructor(private readonly faq: FaqService) {}

  @RequirePermission('settings:read')
  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<FaqEntryDto[]> {
    return this.faq.list(user.tenantId);
  }

  @RequirePermission('settings:manage')
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateFaqEntryDto,
  ): Promise<FaqEntryDto> {
    return this.faq.create(user.tenantId, body);
  }

  @RequirePermission('settings:manage')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateFaqEntryDto,
  ): Promise<FaqEntryDto> {
    return this.faq.update(user.tenantId, id, body);
  }

  @RequirePermission('settings:manage')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.faq.remove(user.tenantId, id);
  }
}
