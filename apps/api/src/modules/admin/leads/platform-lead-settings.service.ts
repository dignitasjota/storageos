import { BadRequestException, Injectable } from '@nestjs/common';
import {
  PLATFORM_LEAD_HIGH_VALUE_MONTHLY,
  PLATFORM_LEAD_STALE_DEFAULTS,
  PlatformLeadZoneRuleSchema,
  normalizeCompanyName,
  responseDeadline,
  type PlatformLeadAssignMode,
  type PlatformLeadSettingsDto,
  type PlatformLeadStaleDays,
  type UpdatePlatformLeadSettingsInput,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import type { PlatformLeadSettings, Prisma } from '@storageos/database';

const ROUND_ROBIN_LOCK = 'platform-lead-round-robin';

/**
 * Ajustes de los leads del panel admin (un registro): cómo se reparten los
 * que entran solos, el plazo de primera respuesta, cuándo un lead está parado
 * y si la secuencia de correos empieza sola.
 */
@Injectable()
export class PlatformLeadSettingsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: SuperAdminAuditService,
  ) {}

  async get(): Promise<PlatformLeadSettings> {
    const row = await this.admin.platformLeadSettings.findFirst();
    return row ?? this.admin.platformLeadSettings.create({ data: {} });
  }

  staleDaysOf(row: PlatformLeadSettings): PlatformLeadStaleDays {
    const raw = (row.staleDays ?? {}) as Partial<Record<keyof PlatformLeadStaleDays, unknown>>;
    const pick = (k: keyof PlatformLeadStaleDays) =>
      typeof raw[k] === 'number' && (raw[k] as number) > 0
        ? (raw[k] as number)
        : PLATFORM_LEAD_STALE_DEFAULTS[k];
    return {
      new: pick('new'),
      contacted: pick('contacted'),
      interested: pick('interested'),
      trial: pick('trial'),
    };
  }

  highValueOf(row: PlatformLeadSettings): number {
    const n = Number(row.highValueMonthly);
    return Number.isFinite(n) ? n : PLATFORM_LEAD_HIGH_VALUE_MONTHLY;
  }

  private zoneRulesOf(row: PlatformLeadSettings) {
    const parsed = PlatformLeadZoneRuleSchema.array().safeParse(row.zoneRules);
    return parsed.success ? parsed.data : [];
  }

  toDto(row: PlatformLeadSettings): PlatformLeadSettingsDto {
    return {
      assignMode: (['off', 'round_robin', 'zone'].includes(row.assignMode)
        ? row.assignMode
        : 'off') as PlatformLeadAssignMode,
      roundRobinIds: row.roundRobinIds,
      zoneRules: this.zoneRulesOf(row),
      zoneFallbackRoundRobin: row.zoneFallbackRoundRobin,
      responseHours: row.responseHours,
      businessHours: row.businessHours,
      reassignEnabled: row.reassignEnabled,
      staleDays: this.staleDaysOf(row),
      highValueMonthly: this.highValueOf(row),
      sequenceAutoStart: row.sequenceAutoStart,
    };
  }

  async dto(): Promise<PlatformLeadSettingsDto> {
    return this.toDto(await this.get());
  }

  async update(
    input: UpdatePlatformLeadSettingsInput,
    byId: string,
  ): Promise<PlatformLeadSettingsDto> {
    const ids = [
      ...(input.roundRobinIds ?? []),
      ...(input.zoneRules ?? []).map((r) => r.superAdminId),
    ];
    if (ids.length) {
      const unique = [...new Set(ids)];
      const found = await this.admin.superAdmin.count({
        where: { id: { in: unique }, isActive: true },
      });
      if (found !== unique.length) {
        throw new BadRequestException({
          code: 'invalid_assignee',
          message: 'Alguna de esas personas no existe o está desactivada',
        });
      }
    }
    const current = await this.get();
    const data: Prisma.PlatformLeadSettingsUpdateInput = {};
    if (input.assignMode) data.assignMode = input.assignMode;
    if (input.roundRobinIds) data.roundRobinIds = [...new Set(input.roundRobinIds)];
    if (input.zoneRules) {
      data.zoneRules = input.zoneRules.map((r) => ({
        match: r.match.trim(),
        superAdminId: r.superAdminId,
      })) as unknown as Prisma.InputJsonValue;
    }
    if (input.zoneFallbackRoundRobin !== undefined) {
      data.zoneFallbackRoundRobin = input.zoneFallbackRoundRobin;
    }
    if (input.responseHours !== undefined) data.responseHours = input.responseHours;
    if (input.businessHours !== undefined) data.businessHours = input.businessHours;
    if (input.reassignEnabled !== undefined) data.reassignEnabled = input.reassignEnabled;
    if (input.staleDays) data.staleDays = input.staleDays as unknown as Prisma.InputJsonValue;
    if (input.highValueMonthly !== undefined) data.highValueMonthly = input.highValueMonthly;
    if (input.sequenceAutoStart !== undefined) data.sequenceAutoStart = input.sequenceAutoStart;
    const row = await this.admin.platformLeadSettings.update({ where: { id: current.id }, data });
    await this.audit.record({
      superAdminId: byId,
      action: 'admin.platform_lead.settings_changed',
      targetType: 'platform',
      targetId: null,
      changes: { fields: Object.keys(input) },
    });
    return this.toDto(row);
  }

  /** Hasta cuándo tiene para responder quien recibe ahora un lead. */
  async deadline(from: Date): Promise<Date> {
    const s = await this.get();
    return responseDeadline(from, s.responseHours, s.businessHours);
  }

  /** Quién recibe un lead que entra solo, o null si no se reparte. */
  async pickAssignee(lead: { city: string | null }): Promise<string | null> {
    const s = await this.get();
    if (s.assignMode === 'off') return null;
    if (s.assignMode === 'zone') {
      const city = normalizeCompanyName(lead.city);
      if (city) {
        const rules = this.zoneRulesOf(s);
        const active = await this.activeIds(rules.map((r) => r.superAdminId));
        const rule = rules.find((r) => {
          const match = normalizeCompanyName(r.match);
          return !!match && active.has(r.superAdminId) && ` ${city} `.includes(` ${match} `);
        });
        if (rule) return rule.superAdminId;
      }
      if (!s.zoneFallbackRoundRobin) return null;
    }
    return this.nextInTurn(null);
  }

  private async activeIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.admin.superAdmin.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * El siguiente del turno (saltando a los desactivados y a `except`). Va de
   * uno en uno: dos leads a la vez no le tocan a la misma persona por error.
   */
  async nextInTurn(except: string | null): Promise<string | null> {
    return this.admin.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ROUND_ROBIN_LOCK}))`;
      const s = await tx.platformLeadSettings.findFirst();
      if (!s || s.roundRobinIds.length === 0) return null;
      const active = await tx.superAdmin.findMany({
        where: { id: { in: s.roundRobinIds }, isActive: true },
        select: { id: true },
      });
      const ok = new Set(active.map((a) => a.id));
      const members = s.roundRobinIds.filter((id) => ok.has(id) && id !== except);
      if (members.length === 0) return null;
      const lastIndex = s.lastAssignedId ? s.roundRobinIds.indexOf(s.lastAssignedId) : -1;
      // El siguiente en el orden del turno después del último que recibió uno.
      const ordered = [
        ...s.roundRobinIds.slice(lastIndex + 1),
        ...s.roundRobinIds.slice(0, lastIndex + 1),
      ].filter((id) => members.includes(id));
      const next = ordered[0] ?? members[0]!;
      await tx.platformLeadSettings.update({
        where: { id: s.id },
        data: { lastAssignedId: next },
      });
      return next;
    });
  }
}
