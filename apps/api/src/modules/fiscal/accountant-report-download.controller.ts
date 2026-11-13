import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import {
  accountantReportKey,
  readAccountantReportToken,
} from '../../common/accountant-report-token';
import { Public } from '../../common/decorators/public.decorator';
import { FilesService } from '../files/files.service';

import type { Env } from '../../config/env.schema';
import type { Response } from 'express';

/**
 * Descarga del Excel enviado a la asesoría, sin iniciar sesión: el enlace va
 * firmado, dura 60 días y lleva a una dirección del almacén de 5 minutos.
 */
@Public()
@Controller('public/accountant-reports')
export class AccountantReportDownloadController {
  constructor(
    private readonly files: FilesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async download(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const key = accountantReportKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
    const found = readAccountantReportToken(key, token);
    if (!found) {
      throw new NotFoundException({
        code: 'link_expired',
        message: 'Este enlace ha caducado: pide que te lo vuelvan a enviar',
      });
    }
    const url = await this.files.getPresignedGetUrl(
      'reports',
      `${found.tenantId}/accountant/${found.fileName}`,
      300,
      found.fileName.replace(/-[0-9a-f]{8}\.xlsx$/, '.xlsx'),
    );
    res.redirect(302, url);
  }
}
