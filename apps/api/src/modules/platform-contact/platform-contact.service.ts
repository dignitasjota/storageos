import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { escapeHtml } from '../../common/tenant-email-layout';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { PlatformService } from '../platform/platform.service';

import type { PlatformContactMessage, PlatformWebsite } from '@storageos/database';
import type {
  PlatformContactMessageDto,
  PlatformContactSettingsDto,
  SubmitPlatformContactInput,
  UpdatePlatformContactSettingsInput,
} from '@storageos/shared';

/**
 * Formulario de contacto de la web de TrasterOS: el mensaje se guarda siempre
 * (para no perder ninguno) y se envía al email configurado en el panel admin.
 */
@Injectable()
export class PlatformContactService {
  private readonly logger = new Logger(PlatformContactService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly email: EmailService,
    private readonly platform: PlatformService,
  ) {}

  private async row(): Promise<PlatformWebsite> {
    return (
      (await this.admin.platformWebsite.findFirst()) ??
      (await this.admin.platformWebsite.create({ data: {} }))
    );
  }

  async getSettings(): Promise<PlatformContactSettingsDto> {
    return toSettingsDto(await this.row());
  }

  async updateSettings(
    input: UpdatePlatformContactSettingsInput,
  ): Promise<PlatformContactSettingsDto> {
    const row = await this.row();
    const updated = await this.admin.platformWebsite.update({
      where: { id: row.id },
      data: {
        contactEnabled: input.enabled,
        contactEmail: input.email || null,
        contactTitle: input.title,
        contactSubtitle: input.subtitle,
        contactShowPhone: input.showPhone,
        contactRequirePhone: input.showPhone && input.requirePhone,
        contactShowCompany: input.showCompany,
        contactShowUnits: input.showUnits,
        contactShowProfile: input.showProfile,
      },
    });
    return toSettingsDto(updated);
  }

  async submit(input: SubmitPlatformContactInput, ipAddress: string | null): Promise<void> {
    // Un bot que rellena el campo oculto: se le responde igual, sin guardar.
    if (input.hp) return;
    const settings = await this.row();
    if (!settings.contactEnabled || !settings.contactEmail) {
      throw new NotFoundException({
        code: 'contact_form_disabled',
        message: 'El formulario de contacto no está disponible',
      });
    }
    const clean = (v: string | undefined, show: boolean) => (show && v?.trim() ? v.trim() : null);
    const phone = clean(input.phone, settings.contactShowPhone);
    if (settings.contactShowPhone && settings.contactRequirePhone && !phone) {
      throw new BadRequestException({ code: 'phone_required', message: 'Indica tu teléfono' });
    }
    const message = await this.admin.platformContactMessage.create({
      data: {
        name: input.name,
        email: input.email,
        phone,
        company: clean(input.company, settings.contactShowCompany),
        units: clean(input.units, settings.contactShowUnits),
        profile: clean(input.profile, settings.contactShowProfile),
        message: input.message,
        ipAddress,
      },
    });

    try {
      const mail = renderContactEmail(message);
      const result = await this.email.sendRendered({
        to: settings.contactEmail,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: { email: message.email, name: message.name },
        kind: 'web_contact',
        tags: { type: 'platform_contact' },
      });
      if (!result.suppressed) {
        await this.admin.platformContactMessage.update({
          where: { id: message.id },
          data: { emailSent: true },
        });
      }
    } catch (err) {
      // Queda guardado y visible en el panel; no se le devuelve error al visitante.
      this.logger.warn(
        `[contacto] no se pudo enviar el aviso del mensaje ${message.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.platform.notify({
      type: 'platform_contact.received',
      title: `Contacto desde la web: ${message.name}`,
      body: message.message.slice(0, 200),
      link: '/admin/website',
    });
  }

  async listMessages(): Promise<PlatformContactMessageDto[]> {
    const rows = await this.admin.platformContactMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(toMessageDto);
  }

  async setHandled(id: string, handled: boolean): Promise<PlatformContactMessageDto> {
    const existing = await this.admin.platformContactMessage.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ code: 'message_not_found', message: 'Mensaje no encontrado' });
    }
    const row = await this.admin.platformContactMessage.update({
      where: { id },
      data: { handledAt: handled ? new Date() : null },
    });
    return toMessageDto(row);
  }
}

function toSettingsDto(row: PlatformWebsite): PlatformContactSettingsDto {
  return {
    enabled: row.contactEnabled,
    email: row.contactEmail ?? '',
    title: row.contactTitle,
    subtitle: row.contactSubtitle,
    showPhone: row.contactShowPhone,
    requirePhone: row.contactShowPhone && row.contactRequirePhone,
    showCompany: row.contactShowCompany,
    showUnits: row.contactShowUnits,
    showProfile: row.contactShowProfile,
  };
}

function toMessageDto(r: PlatformContactMessage): PlatformContactMessageDto {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    company: r.company,
    units: r.units,
    profile: r.profile,
    message: r.message,
    emailSent: r.emailSent,
    handledAt: r.handledAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Correo al equipo con el mensaje (datos del visitante escapados). */
export function renderContactEmail(m: {
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  units: string | null;
  profile: string | null;
  message: string;
}): { subject: string; html: string; text: string } {
  const rows: Array<[string, string | null]> = [
    ['Nombre', m.name],
    ['Email', m.email],
    ['Teléfono', m.phone],
    ['Empresa', m.company],
    ['Trasteros', m.units],
    ['Perfil', m.profile],
  ];
  const present = rows.filter((r): r is [string, string] => Boolean(r[1]));
  const html = [
    '<p>Nuevo mensaje desde el formulario de contacto de la web.</p>',
    '<table style="border-collapse:collapse;font-size:14px">',
    ...present.map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`,
    ),
    '</table>',
    `<p style="white-space:pre-wrap;border-left:3px solid #2563eb;padding-left:12px">${escapeHtml(m.message)}</p>`,
    '<p style="color:#64748b">Responde a este correo para contestarle directamente.</p>',
  ].join('');
  const text = [
    'Nuevo mensaje desde el formulario de contacto de la web.',
    '',
    ...present.map(([k, v]) => `${k}: ${v}`),
    '',
    m.message,
  ].join('\n');
  return { subject: `Contacto desde la web: ${m.name}`, html, text };
}
