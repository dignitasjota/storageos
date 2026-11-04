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
  Req,
  UseGuards,
} from '@nestjs/common';
import { CreateSecurityBlockSchema, type SecurityBlockDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';
import { SecurityBlocksService } from '../security-events/security-blocks.service';

import { AdminAudit } from './admin-audit.decorator';
import { AdminGuard } from './admin.guard';
import { type AuthenticatedSuperAdmin, CurrentSuperAdmin } from './current-super-admin.decorator';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type { Request } from 'express';

class CreateSecurityBlockDto extends createZodDto(CreateSecurityBlockSchema) {}

@Public()
@UseGuards(AdminGuard)
@Controller('admin/security-blocks')
export class SecurityBlocksController {
  constructor(private readonly blocks: SecurityBlocksService) {}

  @Get()
  list(): Promise<SecurityBlockDto[]> {
    return this.blocks.list();
  }

  @RequireSuperadmin()
  @AdminAudit('admin.security_block.created')
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async create(
    @CurrentSuperAdmin() actor: AuthenticatedSuperAdmin,
    @Body() input: CreateSecurityBlockDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.blocks.create(input, { id: actor.sub, ipAddress: req.ip });
  }

  @RequireSuperadmin()
  @AdminAudit('admin.security_block.removed')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.blocks.remove(id);
  }
}
