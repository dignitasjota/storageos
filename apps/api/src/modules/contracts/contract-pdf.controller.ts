import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';

import {
  type AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';

import { ContractPdfService } from './contract-pdf.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Request } from 'express';

function extractMeta(req: Request): RequestMeta {
  const ua = req.header('user-agent');
  const ip = req.ip;
  return {
    ...(ua ? { userAgent: ua } : {}),
    ...(ip ? { ipAddress: ip } : {}),
  };
}

@Controller('contracts')
export class ContractPdfController {
  constructor(private readonly pdf: ContractPdfService) {}

  @RequirePermission('contracts:manage')
  @Post(':id/generate-pdf')
  @HttpCode(HttpStatus.OK)
  async generate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<{ pdfUrl: string }> {
    return this.pdf.generate({
      tenantId: user.tenantId,
      userId: user.sub,
      contractId: id,
      meta: extractMeta(req),
    });
  }
}
