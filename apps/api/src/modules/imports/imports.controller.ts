import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import {
  ImportCustomersCommitSchema,
  type ImportCustomersCommitDto,
  ImportCustomersPreviewSchema,
  type ImportCustomersPreviewDto,
} from '@storageos/shared';
import { createZodDto } from 'nestjs-zod';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

import { ImportsService } from './imports.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

class ImportCustomersPreviewBody extends createZodDto(ImportCustomersPreviewSchema) {}
class ImportCustomersCommitBody extends createZodDto(ImportCustomersCommitSchema) {}

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('customers/template')
  customersTemplate(): { csv: string } {
    return { csv: this.imports.customersTemplate() };
  }

  @Roles('owner', 'manager')
  @Post('customers/preview')
  previewCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportCustomersPreviewBody,
  ): Promise<ImportCustomersPreviewDto> {
    return this.imports.previewCustomers(user.tenantId, body.csv);
  }

  @Roles('owner', 'manager')
  @Post('customers/commit')
  commitCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportCustomersCommitBody,
    @Req() req: Request,
  ): Promise<ImportCustomersCommitDto> {
    return this.imports.commitCustomers({
      tenantId: user.tenantId,
      userId: user.sub,
      meta: extractMeta(req),
      csv: body.csv,
      onDuplicate: body.onDuplicate,
    });
  }
}
