import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { readReportFileToken, reportFileKey } from '../../common/report-file-token';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { FilesService } from '../files/files.service';

import type { Env } from '../../config/env.schema';
import type { Response } from 'express';

/**
 * Descarga del informe que llega por correo, sin iniciar sesión: el enlace va
 * firmado, dura lo que el fichero (7 días) y lleva a una dirección de 5 minutos.
 */
@Public()
@Controller('public/report-files')
export class ReportFileDownloadController {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async download(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const gone = new NotFoundException({
      code: 'link_expired',
      message: 'Este enlace ha caducado: vuelve a generar el informe en TrasterOS',
    });
    const key = reportFileKey(this.config.get('MASTER_ENCRYPTION_KEY', { infer: true }));
    const found = readReportFileToken(key, token);
    if (!found) throw gone;
    const run = await this.admin.reportRun.findFirst({
      where: { id: found.runId, tenantId: found.tenantId, status: 'done' },
      select: { downloadUrl: true, format: true, generatorCode: true, createdAt: true },
    });
    const objectKey = run?.downloadUrl
      ? this.files.keyFromPublicUrl('reports', run.downloadUrl)
      : null;
    if (!run || !objectKey) throw gone;
    const ext = run.format === 'xlsx' ? 'xlsx' : 'pdf';
    const url = await this.files.getPresignedGetUrl(
      'reports',
      objectKey,
      300,
      `informe-${run.createdAt.toISOString().slice(0, 10)}.${ext}`,
    );
    res.redirect(302, url);
  }
}
