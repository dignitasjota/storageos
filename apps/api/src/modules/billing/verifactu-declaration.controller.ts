import { Controller, Get, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';

import { VerifactuDeclarationService } from './verifactu-declaration.service';

import type { Response } from 'express';

/**
 * La declaración responsable de TrasterOS en PDF, sin iniciar sesión: la
 * descargan los clientes (desde el panel o la web) y quien quiera comprobarla.
 */
@Public()
@Controller('public/verifactu')
export class VerifactuDeclarationController {
  constructor(private readonly declarations: VerifactuDeclarationService) {}

  /** `?version=` para una versión anterior; sin ella, la de la versión en uso. */
  @Get('declaration/pdf')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async pdf(@Query('version') version: string | undefined, @Res() res: Response): Promise<void> {
    const { buffer, filename } = await this.declarations.pdf(version);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(buffer);
  }
}
