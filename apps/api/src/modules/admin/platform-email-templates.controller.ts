import { Body, Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import { UpdateLifecycleEmailSchema, type LifecycleEmailTemplateDto } from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import { Public } from '../../common/decorators/public.decorator';

import { AdminAudit } from './admin-audit.decorator';
import { AdminGuard } from './admin.guard';
import { PlatformEmailTemplatesService } from './platform-email-templates.service';
import { RequireSuperadmin } from './require-superadmin.decorator';

class UpdateLifecycleEmailDto extends createZodDto(UpdateLifecycleEmailSchema) {}

/** Textos de los correos automáticos a los tenants. */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/email-templates')
export class PlatformEmailTemplatesController {
  constructor(private readonly templates: PlatformEmailTemplatesService) {}

  @Get()
  list(): Promise<LifecycleEmailTemplateDto[]> {
    return this.templates.list();
  }

  @Put(':code')
  @RequireSuperadmin()
  @AdminAudit('admin.email_template.updated')
  update(
    @Param('code') code: string,
    @Body() body: UpdateLifecycleEmailDto,
  ): Promise<LifecycleEmailTemplateDto[]> {
    return this.templates.update(code, body);
  }

  @Delete(':code')
  @RequireSuperadmin()
  @AdminAudit('admin.email_template.reset')
  reset(@Param('code') code: string): Promise<LifecycleEmailTemplateDto[]> {
    return this.templates.reset(code);
  }
}
