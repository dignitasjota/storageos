import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BUSINESS_REMINDER_EXPENSE_CATEGORY,
  REMINDER_TEMPLATES,
  daysBetween,
  findReminderTemplate,
  fiscalNextDueDate,
  fiscalTemplateOccurrences,
  nextReminderDueDate,
  recurrenceMonths,
  reminderState,
  reminderTemplateBaseKey,
  reminderTemplateDto,
} from '@storageos/shared';

import { CryptoService } from '../../common/crypto/crypto.service';
import { assertFacilityAllowed, optionalFacilityWhere } from '../../common/facility-scope';
import { todayInTimezone } from '../../common/format';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';
import { ExpensesService } from '../expenses/expenses.service';
import { FilesService } from '../files/files.service';

import type { FacilityScope } from '../../common/facility-scope';
import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';
import type {
  BusinessReminderCategory,
  BusinessReminderCompletionDto,
  BusinessReminderDto,
  BusinessReminderRecurrence,
  BusinessReminderSettingsDto,
  BusinessRemindersListDto,
  CompleteBusinessReminderInput,
  CreateBusinessReminderInput,
  ReminderReceiptUploadDto,
  ReminderTemplateDto,
  SystemDeadlineDto,
  UpdateBusinessReminderInput,
} from '@storageos/shared';

const RECEIPT_MIME = ['application/pdf', 'image/png', 'image/jpeg'] as const;
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};
/** Plazos del sistema que se enseñan: hasta un año vista. */
const SYSTEM_HORIZON_DAYS = 365;

const INCLUDE = {
  facility: { select: { name: true } },
  completions: { select: { completedAt: true }, orderBy: { completedAt: 'desc' }, take: 1 },
} satisfies Prisma.BusinessReminderInclude;
type ReminderRow = Prisma.BusinessReminderGetPayload<{ include: typeof INCLUDE }>;

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateOf(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

function emptyToNull(v: string | undefined): string | null {
  return v === undefined || v === '' ? null : v;
}

function icsEscape(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Vencimientos del negocio (función `business_reminders`): lo que el tenant
 * apunta para que no se le pase (dominio, alquiler, Hacienda…). Los avisos los
 * manda `BusinessReminderNoticesService`.
 */
@Injectable()
export class BusinessRemindersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
    private readonly files: FilesService,
    private readonly crypto: CryptoService,
    private readonly expenses: ExpensesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private async today(tenantId: string): Promise<string> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return dateStr(todayInTimezone(t?.timezone ?? 'Europe/Madrid'));
  }

  private toDto(row: ReminderRow, today: string): BusinessReminderDto {
    const due = dateStr(row.dueDate);
    const daysLeft = daysBetween(today, due);
    const status = row.status as BusinessReminderDto['status'];
    return {
      id: row.id,
      title: row.title,
      category: row.category as BusinessReminderCategory,
      dueDate: due,
      daysLeft,
      state: reminderState(status, daysLeft),
      recurrence: row.recurrence as BusinessReminderRecurrence,
      intervalMonths: row.intervalMonths,
      notifyDaysBefore: row.notifyDaysBefore,
      notifyEmail: row.notifyEmail,
      notifyInApp: row.notifyInApp,
      notifyPush: row.notifyPush,
      recipientMode: row.recipientMode as BusinessReminderDto['recipientMode'],
      recipientUserIds: row.recipientUserIds,
      extraEmails: row.extraEmails,
      overdueReminders: row.overdueReminders,
      overdueMaxDays: row.overdueMaxDays,
      amount: row.amount === null ? null : Number(row.amount),
      vendor: row.vendor,
      link: row.link,
      notes: row.notes,
      facilityId: row.facilityId,
      facilityName: row.facility?.name ?? null,
      status,
      snoozedUntil: row.snoozedUntil ? dateStr(row.snoozedUntil) : null,
      templateKey: row.templateKey,
      lastCompletedAt: row.completions[0]?.completedAt.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async findOrThrow(
    tenantId: string,
    id: string,
    scope: FacilityScope,
  ): Promise<ReminderRow> {
    const row = await this.prisma.withTenant(
      (tx) => tx.businessReminder.findFirst({ where: { id, tenantId }, include: INCLUDE }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'reminder_not_found',
        message: 'Vencimiento no encontrado',
      });
    }
    if (row.facilityId) assertFacilityAllowed(scope, row.facilityId);
    return row;
  }

  /** Comprueba el local y las personas elegidas. */
  private async validateRefs(
    tenantId: string,
    scope: FacilityScope,
    input: { facilityId?: string | null | undefined; recipientUserIds?: string[] | undefined },
  ): Promise<void> {
    if (input.facilityId) {
      assertFacilityAllowed(scope, input.facilityId);
      const f = await this.admin.facility.count({
        where: { id: input.facilityId, tenantId, deletedAt: null },
      });
      if (f === 0) {
        throw new BadRequestException({
          code: 'facility_not_found',
          message: 'Local no encontrado',
        });
      }
    }
    if (input.recipientUserIds && input.recipientUserIds.length > 0) {
      const ok = await this.admin.user.count({
        where: { id: { in: input.recipientUserIds }, tenantId, isActive: true },
      });
      if (ok !== new Set(input.recipientUserIds).size) {
        throw new BadRequestException({
          code: 'invalid_recipients',
          message: 'Alguna de las personas elegidas no es del equipo',
        });
      }
    }
  }

  async list(
    tenantId: string,
    opts: { facilityScope: FacilityScope; includeDone?: boolean },
  ): Promise<BusinessRemindersListDto> {
    const where = optionalFacilityWhere(opts.facilityScope);
    const today = await this.today(tenantId);
    const [rows, system] = await Promise.all([
      this.prisma.withTenant(
        (tx) =>
          tx.businessReminder.findMany({
            where: {
              tenantId,
              ...(where ?? {}),
              ...(opts.includeDone ? {} : { status: { in: ['active', 'paused'] } }),
            },
            include: INCLUDE,
            orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
            take: 500,
          }),
        tenantId,
      ),
      this.systemDeadlines(tenantId, today, opts.facilityScope),
    ]);
    return { items: rows.map((r) => this.toDto(r, today)), system };
  }

  async get(tenantId: string, id: string, scope: FacilityScope): Promise<BusinessReminderDto> {
    const row = await this.findOrThrow(tenantId, id, scope);
    return this.toDto(row, await this.today(tenantId));
  }

  async create(
    tenantId: string,
    userId: string | null,
    scope: FacilityScope,
    input: CreateBusinessReminderInput,
    templateKey: string | null = null,
  ): Promise<BusinessReminderDto> {
    await this.validateRefs(tenantId, scope, input);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.businessReminder.create({
          data: {
            tenantId,
            facilityId: input.facilityId ?? null,
            title: input.title,
            category: input.category,
            dueDate: dateOf(input.dueDate),
            recurrence: input.recurrence,
            intervalMonths: input.recurrence === 'custom' ? (input.intervalMonths ?? null) : null,
            notifyDaysBefore: input.notifyDaysBefore,
            notifyEmail: input.notifyEmail,
            notifyInApp: input.notifyInApp,
            notifyPush: input.notifyPush,
            recipientMode: input.recipientMode,
            recipientUserIds: input.recipientMode === 'users' ? input.recipientUserIds : [],
            extraEmails: input.extraEmails,
            overdueReminders: input.overdueReminders,
            overdueMaxDays: input.overdueMaxDays,
            amount: input.amount ?? null,
            vendor: emptyToNull(input.vendor),
            link: emptyToNull(input.link),
            notes: emptyToNull(input.notes),
            templateKey,
            createdByUserId: userId,
          },
          include: INCLUDE,
        }),
      tenantId,
    );
    return this.toDto(row, await this.today(tenantId));
  }

  async update(
    tenantId: string,
    id: string,
    scope: FacilityScope,
    input: UpdateBusinessReminderInput,
  ): Promise<BusinessReminderDto> {
    const current = await this.findOrThrow(tenantId, id, scope);
    await this.validateRefs(tenantId, scope, input);
    const recurrence = input.recurrence ?? (current.recurrence as BusinessReminderRecurrence);
    const intervalMonths =
      input.intervalMonths !== undefined ? input.intervalMonths : current.intervalMonths;
    if (recurrence === 'custom' && !intervalMonths) {
      throw new BadRequestException({
        code: 'interval_required',
        message: 'Indica cada cuántos meses se repite',
      });
    }
    const email = input.notifyEmail ?? current.notifyEmail;
    const inApp = input.notifyInApp ?? current.notifyInApp;
    const push = input.notifyPush ?? current.notifyPush;
    if (!email && !inApp && !push) {
      throw new BadRequestException({
        code: 'channel_required',
        message: 'Elige al menos una forma de aviso',
      });
    }
    const mode = input.recipientMode ?? current.recipientMode;
    const users = input.recipientUserIds ?? current.recipientUserIds;
    if (mode === 'users' && users.length === 0) {
      throw new BadRequestException({
        code: 'recipients_required',
        message: 'Elige al menos una persona',
      });
    }
    const data: Prisma.BusinessReminderUncheckedUpdateInput = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.dueDate !== undefined
        ? { dueDate: dateOf(input.dueDate), snoozedUntil: null }
        : {}),
      recurrence,
      intervalMonths: recurrence === 'custom' ? intervalMonths : null,
      ...(input.notifyDaysBefore !== undefined ? { notifyDaysBefore: input.notifyDaysBefore } : {}),
      notifyEmail: email,
      notifyInApp: inApp,
      notifyPush: push,
      recipientMode: mode,
      recipientUserIds: mode === 'users' ? users : [],
      ...(input.extraEmails !== undefined ? { extraEmails: input.extraEmails } : {}),
      ...(input.overdueReminders !== undefined ? { overdueReminders: input.overdueReminders } : {}),
      ...(input.overdueMaxDays !== undefined ? { overdueMaxDays: input.overdueMaxDays } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.vendor !== undefined ? { vendor: emptyToNull(input.vendor) } : {}),
      ...(input.link !== undefined ? { link: emptyToNull(input.link) } : {}),
      ...(input.notes !== undefined ? { notes: emptyToNull(input.notes) } : {}),
      ...(input.facilityId !== undefined ? { facilityId: input.facilityId ?? null } : {}),
      ...(input.status !== undefined && current.status !== 'done' ? { status: input.status } : {}),
    };
    const row = await this.prisma.withTenant(
      (tx) => tx.businessReminder.update({ where: { id }, data, include: INCLUDE }),
      tenantId,
    );
    return this.toDto(row, await this.today(tenantId));
  }

  async remove(tenantId: string, id: string, scope: FacilityScope): Promise<void> {
    await this.findOrThrow(tenantId, id, scope);
    const receipts = await this.prisma.withTenant(
      (tx) =>
        tx.businessReminderCompletion.findMany({
          where: { reminderId: id, receiptKey: { not: null } },
          select: { receiptKey: true },
        }),
      tenantId,
    );
    await this.prisma.withTenant((tx) => tx.businessReminder.delete({ where: { id } }), tenantId);
    const keys = receipts.map((r) => r.receiptKey).filter((k): k is string => !!k);
    if (keys.length > 0) await this.files.deleteObjects('uploads', keys).catch(() => undefined);
  }

  /** Pospone los avisos unos días (no cambia la fecha del vencimiento). */
  async snooze(
    tenantId: string,
    id: string,
    scope: FacilityScope,
    days: number,
  ): Promise<BusinessReminderDto> {
    const current = await this.findOrThrow(tenantId, id, scope);
    if (current.status !== 'active') {
      throw new BadRequestException({
        code: 'reminder_not_active',
        message: 'Solo se puede posponer un vencimiento activo',
      });
    }
    const today = await this.today(tenantId);
    const until = dateOf(today);
    until.setUTCDate(until.getUTCDate() + days);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.businessReminder.update({
          where: { id },
          data: { snoozedUntil: until },
          include: INCLUDE,
        }),
      tenantId,
    );
    return this.toDto(row, today);
  }

  async receiptUploadUrl(
    tenantId: string,
    id: string,
    scope: FacilityScope,
    mimeType: (typeof RECEIPT_MIME)[number],
  ): Promise<ReminderReceiptUploadDto> {
    await this.findOrThrow(tenantId, id, scope);
    const key = `${tenantId}/reminders/${id}/${randomUUID()}.${RECEIPT_EXT[mimeType]}`;
    const { uploadUrl, expiresIn } = await this.files.getPresignedPutUrl({
      bucket: 'uploads',
      key,
      contentType: mimeType,
    });
    return { uploadUrl, key, expiresIn };
  }

  /**
   * Marca hecho el vencimiento: queda en el historial (con el importe, el gasto
   * y el justificante) y, si se repite, pasa a la siguiente fecha.
   */
  async complete(
    tenantId: string,
    userId: string | null,
    id: string,
    scope: FacilityScope,
    input: CompleteBusinessReminderInput,
  ): Promise<BusinessReminderDto> {
    const current = await this.findOrThrow(tenantId, id, scope);
    if (current.status === 'done') {
      throw new ConflictException({ code: 'reminder_done', message: 'Ya está marcado como hecho' });
    }
    if (input.receiptKey) {
      if (!input.receiptKey.startsWith(`${tenantId}/reminders/${id}/`)) {
        throw new BadRequestException({
          code: 'invalid_receipt_key',
          message: 'Justificante no válido',
        });
      }
      await this.files.assertObjectMimeType(
        'uploads',
        input.receiptKey,
        RECEIPT_MIME,
        RECEIPT_MAX_BYTES,
      );
    }
    const amount = input.amount ?? (current.amount === null ? null : Number(current.amount));
    const dueDate = dateStr(current.dueDate);
    let expenseId: string | null = null;
    if (input.registerExpense && amount && amount > 0) {
      const expense = await this.expenses.create(tenantId, userId, {
        facilityId: current.facilityId,
        category: BUSINESS_REMINDER_EXPENSE_CATEGORY[current.category as BusinessReminderCategory],
        description: current.title,
        amount,
        expenseDate: await this.today(tenantId),
        vendor: current.vendor ?? '',
        notes: input.note ?? '',
      });
      expenseId = expense.id;
    }
    const next =
      fiscalNextDueDate(current.templateKey, dueDate) ??
      nextReminderDueDate(
        dueDate,
        current.recurrence as BusinessReminderRecurrence,
        current.intervalMonths,
      );
    const row = await this.prisma.withTenant(async (tx) => {
      // Reserva: si dos personas lo marcan a la vez, solo vale una.
      const claimed = await tx.businessReminder.updateMany({
        where: { id, status: { not: 'done' }, dueDate: current.dueDate },
        data: next
          ? { dueDate: dateOf(next), snoozedUntil: null }
          : { status: 'done', snoozedUntil: null },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: 'reminder_done',
          message: 'Ya está marcado como hecho',
        });
      }
      await tx.businessReminderCompletion.create({
        data: {
          tenantId,
          reminderId: id,
          dueDate: current.dueDate,
          completedByUserId: userId,
          note: emptyToNull(input.note),
          amount,
          expenseId,
          receiptKey: input.receiptKey ?? null,
          receiptName: input.receiptKey ? (input.receiptName ?? 'Justificante') : null,
          receiptMime: input.receiptKey ? (input.receiptMime ?? null) : null,
        },
      });
      return tx.businessReminder.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    }, tenantId);
    return this.toDto(row, await this.today(tenantId));
  }

  async completions(
    tenantId: string,
    id: string,
    scope: FacilityScope,
  ): Promise<BusinessReminderCompletionDto[]> {
    await this.findOrThrow(tenantId, id, scope);
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.businessReminderCompletion.findMany({
          where: { reminderId: id },
          include: { completedBy: { select: { fullName: true } } },
          orderBy: { completedAt: 'desc' },
          take: 100,
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      dueDate: dateStr(r.dueDate),
      completedAt: r.completedAt.toISOString(),
      completedByName: r.completedBy?.fullName ?? null,
      note: r.note,
      amount: r.amount === null ? null : Number(r.amount),
      expenseId: r.expenseId,
      hasReceipt: !!r.receiptKey,
      receiptName: r.receiptName,
    }));
  }

  async receiptUrl(
    tenantId: string,
    id: string,
    completionId: string,
    scope: FacilityScope,
  ): Promise<{ url: string }> {
    await this.findOrThrow(tenantId, id, scope);
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.businessReminderCompletion.findFirst({ where: { id: completionId, reminderId: id } }),
      tenantId,
    );
    if (!row?.receiptKey) {
      throw new NotFoundException({ code: 'receipt_not_found', message: 'Sin justificante' });
    }
    return {
      url: await this.files.getPresignedGetUrl(
        'uploads',
        row.receiptKey,
        300,
        row.receiptName ?? 'justificante',
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Plantillas
  // -------------------------------------------------------------------------

  async templates(tenantId: string): Promise<ReminderTemplateDto[]> {
    const used = await this.prisma.withTenant(
      (tx) =>
        tx.businessReminder.findMany({
          where: { tenantId, templateKey: { not: null }, status: { in: ['active', 'paused'] } },
          select: { templateKey: true },
        }),
      tenantId,
    );
    const applied = new Set(used.map((u) => reminderTemplateBaseKey(u.templateKey)));
    return REMINDER_TEMPLATES.map((t) => reminderTemplateDto(t, applied.has(t.key)));
  }

  async applyTemplate(
    tenantId: string,
    userId: string | null,
    scope: FacilityScope,
    key: string,
    input: { dueDate?: string | undefined; facilityId?: string | null | undefined },
  ): Promise<BusinessReminderDto[]> {
    const template = findReminderTemplate(key);
    if (!template) {
      throw new NotFoundException({
        code: 'template_not_found',
        message: 'Plantilla no encontrada',
      });
    }
    const base = {
      category: template.category,
      recurrence: template.recurrence,
      intervalMonths: template.intervalMonths ?? null,
      notifyDaysBefore: template.notifyDaysBefore,
      notifyEmail: true,
      notifyInApp: true,
      notifyPush: true,
      recipientMode: 'managers' as const,
      recipientUserIds: [],
      extraEmails: [],
      overdueReminders: true,
      overdueMaxDays: 7,
      facilityId: input.facilityId ?? null,
    };
    if (template.occurrences) {
      const today = await this.today(tenantId);
      const out: BusinessReminderDto[] = [];
      for (const o of fiscalTemplateOccurrences(template, today)) {
        out.push(
          await this.create(
            tenantId,
            userId,
            scope,
            { ...base, title: o.title, dueDate: o.dueDate },
            o.templateKey,
          ),
        );
      }
      return out;
    }
    if (!input.dueDate) {
      throw new BadRequestException({ code: 'due_date_required', message: 'Indica la fecha' });
    }
    return [
      await this.create(
        tenantId,
        userId,
        scope,
        { ...base, title: template.title, dueDate: input.dueDate },
        template.key,
      ),
    ];
  }

  // -------------------------------------------------------------------------
  // Plazos que el sistema ya conoce
  // -------------------------------------------------------------------------

  async systemDeadlines(
    tenantId: string,
    today: string,
    scope: FacilityScope,
  ): Promise<SystemDeadlineDto[]> {
    const horizon = dateOf(today);
    horizon.setUTCDate(horizon.getUTCDate() + SYSTEM_HORIZON_DAYS);
    const [cert, docs, sub, card] = await Promise.all([
      this.admin.tenantAeatCredential.findFirst({
        where: { tenantId, ownerId: null, revokedAt: null },
        orderBy: { uploadedAt: 'desc' },
        select: { certValidTo: true, certCommonName: true },
      }),
      this.admin.facilityDocument.findMany({
        where: {
          tenantId,
          expiresOn: { not: null, lte: horizon },
          facility: { deletedAt: null },
          ...(scope ? { facilityId: { in: scope } } : {}),
        },
        select: {
          id: true,
          name: true,
          expiresOn: true,
          facilityId: true,
          facility: { select: { name: true } },
        },
        orderBy: { expiresOn: 'asc' },
        take: 50,
      }),
      this.admin.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          currentPeriodEnd: true,
          billingMode: true,
          tenant: { select: { billingExempt: true } },
          plan: { select: { name: true, priceMonthly: true } },
        },
      }),
      this.admin.platformRedsysCard.findUnique({
        where: { tenantId },
        select: { expMonth: true, expYear: true, last4: true },
      }),
    ]);
    const out: SystemDeadlineDto[] = [];
    const push = (d: Omit<SystemDeadlineDto, 'daysLeft'>) => {
      if (d.date > dateStr(horizon)) return;
      out.push({ ...d, daysLeft: daysBetween(today, d.date) });
    };
    if (cert) {
      push({
        key: 'aeat_certificate',
        title: 'Caduca el certificado de la AEAT',
        detail: cert.certCommonName,
        date: dateStr(cert.certValidTo),
        href: '/settings/billing/verifactu',
      });
    }
    for (const d of docs) {
      push({
        key: `facility_document:${d.id}`,
        title: `Caduca «${d.name}»`,
        detail: d.facility.name,
        date: dateStr(d.expiresOn!),
        href: `/facilities/${d.facilityId}?tab=documents`,
      });
    }
    if (
      sub &&
      sub.billingMode === 'manual' &&
      !sub.tenant.billingExempt &&
      Number(sub.plan.priceMonthly) > 0
    ) {
      push({
        key: 'subscription_payment',
        title: 'Pago de tu suscripción a TrasterOS',
        detail: `Plan ${sub.plan.name}`,
        date: dateStr(sub.currentPeriodEnd),
        href: '/settings/saas-billing',
      });
    }
    if (card?.expMonth && card.expYear) {
      const y = card.expYear < 100 ? 2000 + card.expYear : card.expYear;
      const last = new Date(Date.UTC(y, card.expMonth, 0));
      push({
        key: 'subscription_card',
        title: 'Caduca la tarjeta con la que pagas TrasterOS',
        detail: card.last4 ? `Terminada en ${card.last4}` : null,
        date: dateStr(last),
        href: '/settings/saas-billing',
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  // -------------------------------------------------------------------------
  // Ajustes y calendario (ICS)
  // -------------------------------------------------------------------------

  private icsUrl(token: string): string {
    const base = this.config.get('API_BASE_URL', { infer: true }).replace(/\/$/, '');
    return `${base}/v1/public/reminders-calendar/${token}`;
  }

  async getSettings(tenantId: string): Promise<BusinessReminderSettingsDto> {
    const t = await this.admin.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { remindersWeeklyDigest: true, remindersIcsTokenEncrypted: true },
    });
    let icsUrl: string | null = null;
    if (t.remindersIcsTokenEncrypted) {
      try {
        icsUrl = this.icsUrl(this.crypto.decryptString(t.remindersIcsTokenEncrypted, tenantId));
      } catch {
        icsUrl = null;
      }
    }
    return { weeklyDigest: t.remindersWeeklyDigest, icsUrl };
  }

  async updateSettings(
    tenantId: string,
    input: { weeklyDigest: boolean },
  ): Promise<BusinessReminderSettingsDto> {
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { remindersWeeklyDigest: input.weeklyDigest },
    });
    return this.getSettings(tenantId);
  }

  /** Crea (o cambia, invalidando el anterior) el enlace de calendario. */
  async regenerateIcs(tenantId: string): Promise<BusinessReminderSettingsDto> {
    const token = randomBytes(24).toString('base64url');
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: {
        remindersIcsTokenHash: createHash('sha256').update(token).digest('hex'),
        remindersIcsTokenEncrypted: this.crypto.encryptString(token, tenantId),
      },
    });
    return this.getSettings(tenantId);
  }

  async revokeIcs(tenantId: string): Promise<BusinessReminderSettingsDto> {
    await this.admin.tenant.update({
      where: { id: tenantId },
      data: { remindersIcsTokenHash: null, remindersIcsTokenEncrypted: null },
    });
    return this.getSettings(tenantId);
  }

  /** Calendario de los vencimientos activos (null si el enlace no vale). */
  async icsFeed(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const hash = createHash('sha256').update(token).digest('hex');
    const tenant = await this.admin.tenant.findFirst({
      where: { remindersIcsTokenHash: hash, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!tenant) return null;
    const rows = await this.admin.businessReminder.findMany({
      where: { tenantId: tenant.id, status: 'active' },
      include: { facility: { select: { name: true } } },
      orderBy: { dueDate: 'asc' },
      take: 500,
    });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TrasterOS//Vencimientos//ES',
      'CALSCALE:GREGORIAN',
      `X-WR-CALNAME:${icsEscape(`Vencimientos · ${tenant.name}`)}`,
    ];
    const web = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    for (const r of rows) {
      const start = dateStr(r.dueDate).replace(/-/g, '');
      const endDate = new Date(r.dueDate);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
      const end = dateStr(endDate).replace(/-/g, '');
      const months = recurrenceMonths(r.recurrence as BusinessReminderRecurrence, r.intervalMonths);
      const desc = [
        r.facility?.name,
        r.vendor,
        r.amount !== null ? `${Number(r.amount).toFixed(2).replace('.', ',')} €` : null,
        r.notes,
        `${web}/reminders`,
      ]
        .filter(Boolean)
        .join('\n');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${r.id}@trasteros`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${start}`,
        `DTEND;VALUE=DATE:${end}`,
        `SUMMARY:${icsEscape(r.title)}`,
        `DESCRIPTION:${icsEscape(desc)}`,
        // Las fechas fiscales pueden pasarse al lunes: sin repetición fija.
        ...(months && !r.templateKey?.startsWith('fiscal_')
          ? [
              months % 12 === 0
                ? `RRULE:FREQ=YEARLY;INTERVAL=${months / 12}`
                : `RRULE:FREQ=MONTHLY;INTERVAL=${months}`,
            ]
          : []),
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
  }
}
