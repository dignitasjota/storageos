import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PLATFORM_EMAIL_KINDS } from '@storageos/shared';

import { Public } from '../../common/decorators/public.decorator';
import { EmailService } from '../email/email.service';
import { PlatformEmailLogService } from '../email/platform-email-log.service';

import { AdminGuard } from './admin.guard';
import { RequireSuperadmin } from './require-superadmin.decorator';

import type {
  PlatformEmailBodyDto,
  PlatformEmailLogPageDto,
  PlatformEmailProblemDto,
  PlatformEmailStatsDto,
} from '@storageos/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['sent', 'delivered', 'bounced', 'failed', 'suppressed'];

/** Historial de los correos que manda la plataforma (lectura: también soporte). */
@Public()
@UseGuards(AdminGuard)
@Controller('admin/email-log')
export class AdminEmailLogController {
  constructor(
    private readonly log: PlatformEmailLogService,
    private readonly email: EmailService,
  ) {}

  @Get('stats')
  stats(@Query('weeks') weeks?: string): Promise<PlatformEmailStatsDto> {
    return this.log.stats(Number(weeks) || 8);
  }

  @Get('problems')
  problems(): Promise<PlatformEmailProblemDto[]> {
    return this.log.problems();
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="correos-enviados.csv"')
  exportCsv(
    @Query('search') search?: string,
    @Query('tenantId') tenantId?: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('announcementId') announcementId?: string,
  ): Promise<string> {
    return this.log.exportCsv(this.filters({ search, tenantId, kind, status, announcementId }));
  }

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('tenantId') tenantId?: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
    @Query('announcementId') announcementId?: string,
  ): Promise<PlatformEmailLogPageDto> {
    return this.log.list({
      ...this.filters({ cursor, search, tenantId, kind, status, announcementId }),
      ...(limit ? { limit: Number(limit) || 50 } : {}),
    });
  }

  @Get(':id/body')
  body(@Param('id', new ParseUUIDPipe()) id: string): Promise<PlatformEmailBodyDto> {
    return this.log.body(id);
  }

  /** Vuelve a enviar el mismo correo a la misma dirección (queda como uno nuevo). */
  @Post(':id/resend')
  @RequireSuperadmin()
  @HttpCode(HttpStatus.OK)
  async resend(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ suppressed: string | null }> {
    const mail = await this.log.forResend(id);
    const result = await this.email.sendRendered({
      to: mail.recipient,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(mail.kind ? { kind: mail.kind } : {}),
      ...(mail.announcementId ? { announcementId: mail.announcementId } : {}),
    });
    return { suppressed: result.suppressed ?? null };
  }

  private filters(q: {
    cursor?: string | undefined;
    search?: string | undefined;
    tenantId?: string | undefined;
    kind?: string | undefined;
    status?: string | undefined;
    announcementId?: string | undefined;
  }) {
    const { cursor, search, tenantId, kind, status, announcementId } = q;
    for (const [key, value] of [
      ['cursor', cursor],
      ['tenantId', tenantId],
      ['announcementId', announcementId],
    ] as const) {
      if (value && !UUID_RE.test(value)) {
        throw new BadRequestException({ code: 'invalid_id', message: `${key} no es un UUID` });
      }
    }
    if (status && !STATUSES.includes(status)) {
      throw new BadRequestException({ code: 'invalid_status', message: 'Estado no válido' });
    }
    if (kind && !(PLATFORM_EMAIL_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException({ code: 'invalid_kind', message: 'Tipo de correo no válido' });
    }
    return {
      ...(cursor ? { cursor } : {}),
      ...(search ? { search } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(kind ? { kind } : {}),
      ...(status ? { status } : {}),
      ...(announcementId ? { announcementId } : {}),
    };
  }
}
