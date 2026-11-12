import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { renderAdminEmail } from '@storageos/shared';

import {
  PLATFORM_LEAD_INBOUND,
  type PlatformLeadInboundEvent,
} from '../../common/platform-lead-events';
import { escapeHtml } from '../../common/tenant-email-layout';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { EmailService } from '../email/email.service';
import { PlatformService } from '../platform/platform.service';

import type { PlatformContactMessage, PlatformWebsite, Prisma } from '@storageos/database';
import type {
  ReplyContactMessageInput,
  UpdateContactMessageInput,
  PlatformContactMessageDto,
  PlatformContactMessagesPageDto,
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
    private readonly events: EventEmitter2,
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
    // El mensaje entra en Leads del panel admin (o se suma al lead que ya hay).
    await this.events
      .emitAsync(PLATFORM_LEAD_INBOUND, {
        contactMessageId: message.id,
        name: message.name,
        email: message.email,
        phone: message.phone,
        company: message.company,
        units: message.units,
        profile: message.profile,
        message: message.message,
        utmSource: input.utmSource?.trim() || null,
        utmMedium: input.utmMedium?.trim() || null,
        utmCampaign: input.utmCampaign?.trim() || null,
      } satisfies PlatformLeadInboundEvent)
      .catch((err: unknown) =>
        this.logger.warn(`[contacto] el mensaje ${message.id} no entró en Leads: ${String(err)}`),
      );
    // Aviso por Telegram/Slack (lo escucha el módulo admin, si está activado).
    this.events.emit(PLATFORM_CONTACT_RECEIVED, {
      id: message.id,
      name: message.name,
      email: message.email,
      company: message.company,
      message: message.message,
    } satisfies PlatformContactReceivedEvent);
    await this.platform.notify({
      type: 'platform_contact.received',
      title: `Contacto desde la web: ${message.name}`,
      body: message.message.slice(0, 200),
      link: '/admin/leads',
    });
  }

  async listMessages(
    f: { cursor?: string; search?: string; handled?: boolean } = {},
  ): Promise<PlatformContactMessagesPageDto> {
    const take = 30;
    const where: Prisma.PlatformContactMessageWhereInput = {};
    if (f.handled !== undefined) where.handledAt = f.handled ? { not: null } : null;
    if (f.search) {
      const contains = { contains: f.search, mode: 'insensitive' as const };
      where.OR = [
        { name: contains },
        { email: contains },
        { company: contains },
        { message: contains },
      ];
    }
    const [rows, pending] = await Promise.all([
      this.admin.platformContactMessage.findMany({
        where,
        include: WITH_ASSIGNEE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
      }),
      this.admin.platformContactMessage.count({ where: { handledAt: null } }),
    ]);
    const page = rows.slice(0, take);
    return {
      items: page.map(toMessageDto),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
      pending,
    };
  }

  async deleteMessage(id: string): Promise<void> {
    const deleted = await this.admin.platformContactMessage.deleteMany({ where: { id } });
    if (deleted.count === 0) {
      throw new NotFoundException({ code: 'message_not_found', message: 'Mensaje no encontrado' });
    }
  }

  async setHandled(id: string, handled: boolean): Promise<PlatformContactMessageDto> {
    const existing = await this.admin.platformContactMessage.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ code: 'message_not_found', message: 'Mensaje no encontrado' });
    }
    const row = await this.admin.platformContactMessage.update({
      where: { id },
      data: { handledAt: handled ? new Date() : null },
      include: WITH_ASSIGNEE,
    });
    return toMessageDto(row);
  }

  /** Nota interna y quién lo lleva (un super admin activo). */
  async update(id: string, input: UpdateContactMessageInput): Promise<PlatformContactMessageDto> {
    await this.findOrThrow(id);
    if (input.assignedToId) {
      const admin = await this.admin.superAdmin.findFirst({
        where: { id: input.assignedToId, isActive: true },
        select: { id: true },
      });
      if (!admin) {
        throw new BadRequestException({
          code: 'invalid_assignee',
          message: 'Ese administrador no existe o está desactivado',
        });
      }
    }
    const row = await this.admin.platformContactMessage.update({
      where: { id },
      data: {
        ...(input.note !== undefined ? { note: input.note || null } : {}),
        ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
      },
      include: WITH_ASSIGNEE,
    });
    return toMessageDto(row);
  }

  /**
   * Responde al visitante desde el panel: sale con el remitente de «Contacto
   * web», queda en «Correos enviados» y el mensaje pasa a atendido.
   */
  async reply(id: string, input: ReplyContactMessageInput): Promise<PlatformContactMessageDto> {
    const msg = await this.findOrThrow(id);
    const settings = await this.row();
    const quote = msg.message
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    const mail = renderAdminEmail(`${input.body}\n\n---\n\n${quote}`);
    const result = await this.email.sendRendered({
      to: msg.email,
      subject: input.subject,
      html: mail.html,
      text: mail.text,
      ...(settings.contactEmail ? { replyTo: { email: settings.contactEmail } } : {}),
      kind: 'web_contact',
      tags: { type: 'platform_contact_reply' },
    });
    if (result.suppressed) {
      throw new BadRequestException({
        code: 'email_suppressed',
        message: 'Esa dirección está bloqueada (rebotes o quejas): no se le puede escribir',
      });
    }
    const now = new Date();
    const row = await this.admin.platformContactMessage.update({
      where: { id },
      data: {
        repliedAt: now,
        replySubject: input.subject,
        replyBody: input.body,
        handledAt: msg.handledAt ?? now,
      },
      include: WITH_ASSIGNEE,
    });
    return toMessageDto(row);
  }

  /** Todos los mensajes (o los del filtro) en CSV para Excel. */
  async exportCsv(f: { search?: string; handled?: boolean } = {}): Promise<string> {
    const where: Prisma.PlatformContactMessageWhereInput = {};
    if (f.handled !== undefined) where.handledAt = f.handled ? { not: null } : null;
    if (f.search) {
      const contains = { contains: f.search, mode: 'insensitive' as const };
      where.OR = [{ name: contains }, { email: contains }, { company: contains }];
    }
    const rows = await this.admin.platformContactMessage.findMany({
      where,
      include: WITH_ASSIGNEE,
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const cell = (v: string | null | undefined) => {
      const t = (v ?? '').replace(/\r?\n/g, ' ');
      return /[";]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const date = (d: Date | null) =>
      d ? d.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' }) : '';
    const header = [
      'Fecha',
      'Nombre',
      'Email',
      'Teléfono',
      'Empresa',
      'Trasteros',
      'Perfil',
      'Mensaje',
      'Atendido',
      'Respondido',
      'Lo lleva',
      'Nota',
    ];
    const lines = rows.map((r) =>
      [
        date(r.createdAt),
        r.name,
        r.email,
        r.phone,
        r.company,
        r.units,
        r.profile,
        r.message,
        date(r.handledAt),
        date(r.repliedAt),
        r.assignedTo?.fullName ?? '',
        r.note,
      ]
        .map(cell)
        .join(';'),
    );
    return `${String.fromCharCode(0xfeff)}${[header.join(';'), ...lines].join('\r\n')}`;
  }

  private async findOrThrow(id: string): Promise<PlatformContactMessage> {
    const row = await this.admin.platformContactMessage.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ code: 'message_not_found', message: 'Mensaje no encontrado' });
    }
    return row;
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

export const PLATFORM_CONTACT_RECEIVED = 'platform.contact_received';

export interface PlatformContactReceivedEvent {
  id: string;
  name: string;
  email: string;
  company: string | null;
  message: string;
}

const WITH_ASSIGNEE = { assignedTo: { select: { fullName: true } } } as const;

function toMessageDto(
  r: PlatformContactMessage & { assignedTo?: { fullName: string } | null },
): PlatformContactMessageDto {
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
    note: r.note,
    assignedToId: r.assignedToId,
    assignedToName: r.assignedTo?.fullName ?? null,
    repliedAt: r.repliedAt?.toISOString() ?? null,
    replySubject: r.replySubject,
    replyBody: r.replyBody,
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
