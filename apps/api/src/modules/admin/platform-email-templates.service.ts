import { BadRequestException, Injectable } from '@nestjs/common';
import {
  fillLifecycleTemplate,
  LIFECYCLE_EMAIL_CODES,
  LIFECYCLE_EMAIL_DEFAULTS,
  renderAdminEmail,
  type LifecycleEmailCode,
  type LifecycleEmailTemplateDto,
  type UpdateLifecycleEmailInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../database/prisma-admin.service';

/**
 * Textos de los correos automáticos a los tenants (bienvenida, fin de la
 * prueba, impago). Sin texto propio se usa el de serie.
 */
@Injectable()
export class PlatformEmailTemplatesService {
  constructor(private readonly admin: PrismaAdminService) {}

  async list(): Promise<LifecycleEmailTemplateDto[]> {
    const rows = await this.admin.platformEmailTemplate.findMany();
    const byCode = new Map(rows.map((r) => [r.code, r]));
    return LIFECYCLE_EMAIL_CODES.map((code) => {
      const def = LIFECYCLE_EMAIL_DEFAULTS[code];
      const row = byCode.get(code);
      return {
        code,
        label: def.label,
        description: def.description,
        subject: row?.subject ?? def.subject,
        body: row?.body ?? def.body,
        custom: !!row,
        variables: def.variables,
        defaultSubject: def.subject,
        defaultBody: def.body,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    });
  }

  async update(
    code: string,
    input: UpdateLifecycleEmailInput,
  ): Promise<LifecycleEmailTemplateDto[]> {
    const c = this.parse(code);
    await this.admin.platformEmailTemplate.upsert({
      where: { code: c },
      create: { code: c, subject: input.subject, body: input.body },
      update: { subject: input.subject, body: input.body },
    });
    return this.list();
  }

  /** Vuelve al texto de serie. */
  async reset(code: string): Promise<LifecycleEmailTemplateDto[]> {
    const c = this.parse(code);
    await this.admin.platformEmailTemplate.deleteMany({ where: { code: c } });
    return this.list();
  }

  /** Asunto, HTML y texto de un correo automático con sus variables. */
  async render(
    code: LifecycleEmailCode,
    vars: Record<string, string>,
  ): Promise<{ subject: string; html: string; text: string }> {
    const row = await this.admin.platformEmailTemplate.findUnique({ where: { code } });
    const def = LIFECYCLE_EMAIL_DEFAULTS[code];
    const subject = fillLifecycleTemplate(row?.subject ?? def.subject, vars);
    const body = fillLifecycleTemplate(row?.body ?? def.body, vars);
    return { subject, ...renderAdminEmail(body) };
  }

  private parse(code: string): LifecycleEmailCode {
    if (!(LIFECYCLE_EMAIL_CODES as readonly string[]).includes(code)) {
      throw new BadRequestException({ code: 'invalid_template', message: 'Correo no válido' });
    }
    return code as LifecycleEmailCode;
  }
}
