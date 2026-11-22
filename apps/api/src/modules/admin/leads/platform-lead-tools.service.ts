import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@storageos/database';
import {
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_SOURCES,
  parseLeadCount,
  platformLeadName,
  type ImportCommitDto,
  type ImportPreviewDto,
  type PlatformLeadBulkInput,
  type PlatformLeadBulkResultDto,
  type PlatformLeadDetailDto,
  type PlatformLeadDto,
  type PlatformLeadImportInput,
  type PlatformLeadListDto,
  type PlatformLeadListQuery,
  type PlatformLeadSource,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { FilesService } from '../../files/files.service';
import {
  buildPreview,
  normalizeHeader,
  parseRaw,
  resolveImportCsv,
  runCommit,
  type RowEval,
} from '../../imports/import-engine';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import {
  LEAD_INCLUDE,
  PlatformLeadsService,
  clean,
  digits,
  type LeadActor,
} from './platform-leads.service';

const DAY = 86_400_000;
const CAPTURE_PREFIX = 'platform/leads/capture/';
const PHOTO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** Tope de filas de un fichero de leads. */
const IMPORT_MAX_ROWS = 2000;

type ImportField =
  | 'companyName'
  | 'contactName'
  | 'email'
  | 'phone'
  | 'city'
  | 'units'
  | 'facilities'
  | 'currentSoftware'
  | 'profile'
  | 'source'
  | 'note'
  | 'utmCampaign';

/** Cabeceras que se entienden (sin tildes, espacios ni mayúsculas). */
const IMPORT_ALIASES: Record<string, ImportField> = {
  empresa: 'companyName',
  compania: 'companyName',
  company: 'companyName',
  razonsocial: 'companyName',
  negocio: 'companyName',
  persona: 'contactName',
  nombre: 'contactName',
  contacto: 'contactName',
  name: 'contactName',
  personadecontacto: 'contactName',
  email: 'email',
  'e-mail': 'email',
  correo: 'email',
  mail: 'email',
  correoelectronico: 'email',
  telefono: 'phone',
  tel: 'phone',
  movil: 'phone',
  phone: 'phone',
  ciudad: 'city',
  localidad: 'city',
  provincia: 'city',
  city: 'city',
  trasteros: 'units',
  unidades: 'units',
  units: 'units',
  ntrasteros: 'units',
  numerodetrasteros: 'units',
  locales: 'facilities',
  centros: 'facilities',
  facilities: 'facilities',
  programa: 'currentSoftware',
  programaactual: 'currentSoftware',
  software: 'currentSoftware',
  perfil: 'profile',
  profile: 'profile',
  origen: 'source',
  source: 'source',
  fuente: 'source',
  nota: 'note',
  notas: 'note',
  comentario: 'note',
  comentarios: 'note',
  mensaje: 'note',
  observaciones: 'note',
  campana: 'utmCampaign',
  campaign: 'utmCampaign',
  utmcampaign: 'utmCampaign',
};

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Origen escrito en el fichero (su código o su nombre en español), o null. */
function sourceFrom(text: string): PlatformLeadSource | null {
  const t = normalizeHeader(text);
  if (!t) return null;
  return (
    PLATFORM_LEAD_SOURCES.find(
      (s) => normalizeHeader(s) === t || normalizeHeader(PLATFORM_LEAD_SOURCE_LABELS[s]) === t,
    ) ?? null
  );
}

/**
 * Herramientas del tablero de leads: la vista de lista (filtros, orden y
 * páginas), las acciones en lote, la fusión de duplicados, la importación desde
 * un fichero y la captura rápida desde el móvil.
 */
@Injectable()
export class PlatformLeadToolsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly leads: PlatformLeadsService,
    private readonly files: FilesService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  // ---------------------------------------------------------------- lista

  async list(
    q: PlatformLeadListQuery,
    superAdminId: string,
    now = new Date(),
  ): Promise<PlatformLeadListDto> {
    const where: Prisma.PlatformLeadWhereInput = {
      ...this.leads.listWhere(
        {
          ...(q.search ? { search: q.search } : {}),
          ...(q.source ? { source: q.source } : {}),
          ...(q.assignedTo ? { assignedTo: q.assignedTo } : {}),
          ...(q.discarded ? { discarded: true } : {}),
        },
        superAdminId,
      ),
    };
    if (q.status?.length) where.status = { in: q.status };
    if (q.city) where.city = { contains: q.city, mode: 'insensitive' };
    if (q.campaign) where.utmCampaign = { contains: q.campaign, mode: 'insensitive' };
    const rows = await this.admin.platformLead.findMany({
      where,
      include: LEAD_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5000,
    });
    let items = await this.leads.toDtos(rows, undefined, now);
    if (q.sizeMin !== undefined || q.sizeMax !== undefined) {
      items = items.filter((l) => {
        const n = parseLeadCount(l.units);
        if (n === null) return false;
        return (
          (q.sizeMin === undefined || n >= q.sizeMin) && (q.sizeMax === undefined || n <= q.sizeMax)
        );
      });
    }
    if (q.inactiveDays) {
      const limit = now.getTime() - q.inactiveDays * DAY;
      items = items.filter((l) => new Date(l.lastActivityAt ?? l.createdAt).getTime() <= limit);
    }
    if (q.stale) items = items.filter((l) => l.staleDays !== null);
    items.sort(comparator(q.sort, q.dir));
    const offset = Number(q.cursor ?? 0);
    const page = items.slice(offset, offset + q.limit);
    return {
      items: page,
      nextCursor: offset + q.limit < items.length ? String(offset + q.limit) : null,
      total: items.length,
      totalValue: Math.round(items.reduce((a, l) => a + (l.estimatedMonthly ?? 0), 0) * 100) / 100,
    };
  }

  // ----------------------------------------------------------------- lote

  /** Una acción sobre varios leads: cada uno por su cuenta (si uno falla, los demás siguen). */
  async bulk(input: PlatformLeadBulkInput, actor: LeadActor): Promise<PlatformLeadBulkResultDto> {
    const ids = [...new Set(input.ids)];
    const names = await this.admin.platformLead.findMany({
      where: { id: { in: ids } },
      select: { id: true, companyName: true, contactName: true, email: true },
    });
    const nameOf = new Map(names.map((n) => [n.id, platformLeadName(n)]));
    const failed: PlatformLeadBulkResultDto['failed'] = [];
    let done = 0;
    for (const id of ids) {
      try {
        switch (input.action) {
          case 'assign':
            await this.leads.update(
              id,
              { assignedToId: input.assignedToId },
              actor.superAdminId,
              actor,
            );
            break;
          case 'move':
            await this.leads.move(id, { status: input.status }, actor);
            break;
          case 'lose':
            await this.leads.lose(
              id,
              { reasonCode: input.reasonCode, reason: input.reason ?? '' },
              actor,
            );
            break;
          case 'discard':
            await this.leads.discard(id, actor, {
              reasonCode: input.reasonCode,
              reason: input.reason ?? null,
            });
            break;
          case 'followup':
            await this.leads.createFollowup(
              id,
              { title: input.title, dueDate: input.dueDate, note: input.note ?? '' },
              actor,
            );
            break;
        }
        done += 1;
      } catch (err) {
        const body =
          err && typeof err === 'object' && 'getResponse' in err
            ? ((err as { getResponse: () => unknown }).getResponse() as { message?: string })
            : null;
        failed.push({
          id,
          name: nameOf.get(id) ?? 'Lead que ya no existe',
          message: body?.message ?? (err instanceof Error ? err.message : 'No se ha podido'),
        });
      }
    }
    await this.leads.record(actor, 'bulk', ids[0]!, {
      action: input.action,
      count: ids.length,
      done,
    });
    return { done, failed };
  }

  // ---------------------------------------------------------------- fusión

  /**
   * Une `sourceId` a `targetId`: pasan su actividad, seguimientos, propuestas y
   * citas, se rellenan los datos que faltan y el origen queda descartado como
   * «Fusionado con …» (sus respuestas por correo siguen llegando al destino).
   */
  async merge(
    targetId: string,
    sourceId: string,
    actor: LeadActor,
  ): Promise<PlatformLeadDetailDto> {
    if (targetId === sourceId) {
      throw new BadRequestException({ code: 'same_lead', message: 'Elige otro lead' });
    }
    const target = await this.leads.leadOrThrow(targetId);
    const source = await this.admin.platformLead.findUnique({ where: { id: sourceId } });
    if (!source || source.discardedAt) {
      throw new NotFoundException({ code: 'lead_not_found', message: 'Lead no encontrado' });
    }
    if (source.tenantId && target.tenantId) {
      throw new ConflictException({
        code: 'both_have_account',
        message: 'Los dos tienen cuenta: no se pueden fusionar',
      });
    }
    const now = new Date();
    // Lo que el destino no tiene y el origen sí.
    const filled: Record<string, unknown> = {};
    for (const k of [
      'companyName',
      'contactName',
      'email',
      'phone',
      'units',
      'facilities',
      'profile',
      'currentSoftware',
      'city',
      'planSlug',
      'message',
      'utmSource',
      'utmMedium',
      'utmCampaign',
      'firstResponseAt',
      'contactedAt',
      'interestedAt',
    ] as const) {
      if ((target[k] === null || target[k] === '') && source[k] !== null) filled[k] = source[k];
    }
    await this.admin.$transaction(async (tx) => {
      // Lo que no puede estar dos veces en marcha a la vez, se para en el origen.
      await tx.platformLeadSequenceEnrollment.updateMany({
        where: { leadId: sourceId, status: 'active' },
        data: { status: 'stopped', stopReason: 'merged', finishedAt: now, nextRunAt: null },
      });
      await tx.salesCadenceEnrollment.updateMany({
        where: { leadId: sourceId, status: 'active' },
        data: { status: 'stopped', finishedAt: now },
      });
      if (source.tenantId) {
        await tx.platformLead.update({ where: { id: sourceId }, data: { tenantId: null } });
      }
      await tx.platformLeadActivity.updateMany({
        where: { leadId: sourceId },
        data: { leadId: targetId },
      });
      await tx.platformLeadFollowup.updateMany({
        where: { leadId: sourceId },
        data: { leadId: targetId },
      });
      await tx.platformQuoteOffer.updateMany({
        where: { leadId: sourceId },
        data: { leadId: targetId },
      });
      if (target.tenantId) {
        // Las propuestas del origen pasan a ser de su cuenta.
        await tx.platformQuoteOffer.updateMany({
          where: { leadId: targetId, tenantId: null },
          data: { tenantId: target.tenantId },
        });
      }
      await tx.salesAppointment.updateMany({
        where: { leadId: sourceId },
        data: { leadId: targetId },
      });
      await tx.platformLeadSequenceEnrollment.updateMany({
        where: { leadId: sourceId },
        data: { leadId: targetId },
      });
      await tx.platformLead.update({
        where: { id: targetId },
        data: {
          ...(filled as Prisma.PlatformLeadUncheckedUpdateInput),
          ...(source.tenantId
            ? {
                tenantId: source.tenantId,
                status: source.status === 'customer' ? 'customer' : 'trial',
                trialAt: target.trialAt ?? source.trialAt ?? now,
                customerAt: target.customerAt ?? source.customerAt,
                lostAt: null,
                lostReasonCode: null,
                lostReason: null,
              }
            : {}),
          ...(target.createdAt > source.createdAt ? { createdAt: source.createdAt } : {}),
        },
      });
      await tx.platformLead.update({
        where: { id: sourceId },
        data: {
          discardedAt: now,
          discardReasonCode: 'merged',
          discardReason: `Fusionado con «${platformLeadName(target)}»`,
          mergedIntoId: targetId,
        },
      });
    });
    if (!target.assignedToId && source.assignedToId) {
      await this.leads.update(targetId, { assignedToId: source.assignedToId }, actor.superAdminId);
    }
    await this.leads.addActivity(
      targetId,
      'system',
      `Fusionado con «${platformLeadName(source)}»: se han unido su actividad, seguimientos y propuestas`,
      actor.superAdminId,
    );
    await this.leads.record(actor, 'merged', targetId, { sourceId });
    return this.leads.detail(targetId);
  }

  // --------------------------------------------------------------- importar

  private async evaluator(input: PlatformLeadImportInput, actor: LeadActor) {
    const csv = await resolveImportCsv(input.csv, input.format);
    const { columns, records } = parseRaw(csv);
    if (records.length > IMPORT_MAX_ROWS) {
      throw new BadRequestException({
        code: 'too_many_rows',
        message: `Como mucho ${IMPORT_MAX_ROWS} leads por fichero`,
      });
    }
    const map = new Map<string, ImportField>();
    for (const col of columns) {
      const field = IMPORT_ALIASES[normalizeHeader(col)];
      if (field) map.set(col, field);
    }
    if (input.assignedToId) {
      const found = await this.admin.superAdmin.count({
        where: { id: input.assignedToId, isActive: true },
      });
      if (!found) {
        throw new BadRequestException({
          code: 'invalid_assignee',
          message: 'Ese administrador no existe o está desactivado',
        });
      }
    }
    const existing = await this.admin.platformLead.findMany({
      where: { discardedAt: null },
      select: { id: true, email: true, phone: true },
    });
    const byEmail = new Map<string, string>();
    const byPhone = new Map<string, string>();
    for (const e of existing) {
      if (e.email) byEmail.set(e.email.toLowerCase(), e.id);
      const tail = digits(e.phone).slice(-9);
      if (tail.length === 9) byPhone.set(tail, e.id);
    }
    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();
    const evaluate = (raw: Record<string, string>): RowEval => {
      const f: Partial<Record<ImportField, string>> = {};
      for (const [col, field] of map) {
        const v = (raw[col] ?? '').trim();
        if (v && !f[field]) f[field] = v;
      }
      const errors: string[] = [];
      const email = f.email?.toLowerCase() ?? null;
      const phone = f.phone ?? null;
      if (!f.companyName && !f.contactName) errors.push('Falta la empresa o la persona');
      if (!email && !phone) errors.push('Falta un email o un teléfono');
      if (email && !emailOk(email)) errors.push('Email no válido');
      const source = f.source ? sourceFrom(f.source) : null;
      if (f.source && !source) errors.push(`Origen desconocido: «${f.source}»`);
      if (errors.length) return { status: 'error', errors };
      const tail = digits(phone).slice(-9);
      const existingId =
        (email ? byEmail.get(email) : undefined) ??
        (tail.length === 9 ? byPhone.get(tail) : undefined) ??
        null;
      const repeated =
        (email !== null && seenEmails.has(email)) || (tail.length === 9 && seenPhones.has(tail));
      if (email) seenEmails.add(email);
      if (tail.length === 9) seenPhones.add(tail);
      if (repeated) {
        return { status: 'error', errors: ['Repetido en el fichero (mismo email o teléfono)'] };
      }
      const data = {
        companyName: clean(f.companyName),
        contactName: clean(f.contactName),
        email,
        phone: clean(phone),
        city: clean(f.city),
        units: clean(f.units),
        facilities: clean(f.facilities),
        currentSoftware: clean(f.currentSoftware),
        profile: clean(f.profile),
        utmCampaign: clean(f.utmCampaign),
      };
      if (existingId) {
        return {
          status: 'duplicate',
          errors: [
            input.onDuplicate === 'merge'
              ? 'Ya existe: se le suman los datos que le faltan'
              : 'Ya existe: se omite',
          ],
          create: () => this.mergeImported(existingId, data, f.note ?? null, actor),
        };
      }
      return {
        status: 'valid',
        errors: [],
        create: async () => {
          const lead = await this.admin.platformLead.create({
            data: {
              ...data,
              status: 'new',
              source: source ?? input.source,
              assignedToId: input.assignedToId ?? null,
              createdById: actor.superAdminId,
            },
            select: { id: true },
          });
          await this.leads.addActivity(
            lead.id,
            'note',
            f.note ? `Importado: ${f.note}` : 'Importado desde un fichero',
            actor.superAdminId,
          );
          if (input.assignedToId) {
            await this.leads.applyPortfolio(lead.id, input.assignedToId, actor.superAdminId);
          }
          return lead.id;
        },
      };
    };
    return { columns, records, evaluate };
  }

  /** Un lead que ya estaba: se le rellena lo que no tenía y se anota la importación. */
  private async mergeImported(
    id: string,
    data: Record<string, string | null>,
    note: string | null,
    actor: LeadActor,
  ): Promise<string> {
    const lead = await this.admin.platformLead.findUniqueOrThrow({ where: { id } });
    const patch: Prisma.PlatformLeadUncheckedUpdateInput = {};
    for (const [k, v] of Object.entries(data)) {
      const current = (lead as unknown as Record<string, unknown>)[k];
      if (v && (current === null || current === '')) {
        (patch as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(patch).length) {
      await this.admin.platformLead.update({ where: { id }, data: patch });
    }
    await this.leads.addActivity(
      id,
      'note',
      `Importado otra vez${note ? `: ${note}` : ''}${Object.keys(patch).length ? ' (se han completado datos que faltaban)' : ''}`,
      actor.superAdminId,
    );
    return id;
  }

  async importPreview(input: PlatformLeadImportInput, actor: LeadActor): Promise<ImportPreviewDto> {
    const { columns, records, evaluate } = await this.evaluator(input, actor);
    return buildPreview(columns, records, evaluate);
  }

  async importCommit(input: PlatformLeadImportInput, actor: LeadActor): Promise<ImportCommitDto> {
    const { records, evaluate } = await this.evaluator(input, actor);
    const result = await runCommit(
      records,
      evaluate,
      input.onDuplicate === 'merge' ? 'create' : 'skip',
    );
    await this.audit.record({
      superAdminId: actor.superAdminId,
      action: 'admin.platform_lead.imported',
      targetType: 'platform_lead',
      targetId: null,
      changes: { ...result.summary, source: input.source, onDuplicate: input.onDuplicate },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    return result;
  }

  // -------------------------------------------------------- captura rápida

  /** URL para subir la foto de su tarjeta (desde el móvil). */
  async capturePhotoUrl(
    adminId: string,
    mimeType: keyof typeof PHOTO_EXT,
  ): Promise<{ uploadUrl: string; key: string; requiredHeaders: Record<string, string> }> {
    const key = `${CAPTURE_PREFIX}${adminId}/${randomUUID()}.${PHOTO_EXT[mimeType]}`;
    const { uploadUrl } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, key, requiredHeaders: { 'Content-Type': mimeType } };
  }

  /** Deja la foto de la tarjeta en la ficha, como nota. */
  async attachCapturePhoto(leadId: string, key: string, adminId: string): Promise<void> {
    if (!key.startsWith(`${CAPTURE_PREFIX}${adminId}/`) || key.includes('..')) {
      throw new BadRequestException({ code: 'invalid_photo', message: 'Foto no válida' });
    }
    const ext = key.split('.').pop() ?? '';
    const mimeType = Object.entries(PHOTO_EXT).find(([, e]) => e === ext)?.[0];
    if (!mimeType)
      throw new BadRequestException({ code: 'invalid_photo', message: 'Foto no válida' });
    await this.files.assertObjectMimeType('uploads', key, [mimeType], PHOTO_MAX_BYTES, {
      mustExist: true,
    });
    await this.leads.addActivity(leadId, 'note', 'Foto de su tarjeta', adminId, {
      attachments: [{ key, mimeType, filename: `tarjeta.${ext}` }],
    });
  }
}

/** Orden de la lista: los vacíos siempre al final. */
function comparator(
  sort: PlatformLeadListQuery['sort'],
  dir: PlatformLeadListQuery['dir'],
): (a: PlatformLeadDto, b: PlatformLeadDto) => number {
  const STAGE_ORDER = ['new', 'contacted', 'interested', 'trial', 'customer', 'lost'];
  const value = (l: PlatformLeadDto): string | number | null => {
    switch (sort) {
      case 'score':
        return l.score;
      case 'value':
        return l.estimatedMonthly;
      case 'name':
        return l.displayName.toLowerCase();
      case 'company':
        return l.companyName?.toLowerCase() ?? null;
      case 'status':
        return STAGE_ORDER.indexOf(l.status);
      case 'source':
        return PLATFORM_LEAD_SOURCE_LABELS[l.source] ?? l.source;
      case 'city':
        return l.city?.toLowerCase() ?? null;
      case 'assignee':
        return l.assignedToName?.toLowerCase() ?? null;
      case 'lastActivity':
        return l.lastActivityAt ?? l.createdAt;
      case 'nextFollowup':
        return l.nextFollowup?.dueDate ?? null;
      default:
        return l.createdAt;
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return a.id.localeCompare(b.id);
    if (x === null) return 1;
    if (y === null) return -1;
    const c =
      typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y), 'es');
    return c !== 0 ? c * sign : a.id.localeCompare(b.id);
  };
}
