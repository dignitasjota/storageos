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
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  UpsertSupportCannedResponseSchema,
  type AdminSupportStatsDto,
  type SupportCannedResponseDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { SupportAgilityService } from './support-agility.service';

class UpsertCannedDto extends createZodDto(UpsertSupportCannedResponseSchema) {}

/**
 * Respuestas guardadas y tiempos de respuesta del soporte. Las gestiona
 * cualquier super admin (también el rol soporte, que es quien las usa).
 */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/support')
export class SupportAgilityController {
  constructor(private readonly service: SupportAgilityService) {}

  @Get('stats')
  stats(@Query('days') days?: string): Promise<AdminSupportStatsDto> {
    return this.service.stats(days ? Number(days) : 30);
  }

  @Get('canned-responses')
  list(): Promise<SupportCannedResponseDto[]> {
    return this.service.listCanned();
  }

  @Post('canned-responses')
  create(
    @Body() body: UpsertCannedDto,
    @CurrentSuperAdmin() admin: AuthenticatedSuperAdmin,
  ): Promise<SupportCannedResponseDto> {
    return this.service.createCanned(body, admin.sub);
  }

  @Put('canned-responses/:id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpsertCannedDto,
  ): Promise<SupportCannedResponseDto> {
    return this.service.updateCanned(id, body);
  }

  @Delete('canned-responses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.removeCanned(id);
  }
}
