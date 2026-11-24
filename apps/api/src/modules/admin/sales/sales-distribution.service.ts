import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  normalizeSalesBatch,
  normalizeSalesCode,
  platformLeadName,
  renderAdminEmail,
  SALES_REP_COLUMN_ALIASES,
  type SalesBatchDto,
  type SalesBulkImportInput,
  type SalesDistributeLeadsInput,
  type SalesDistributionMode,
  type SalesDistributionResultDto,
  type SalesDistributionRowDto,
} from '@storageos/shared';

import { PrismaAdminService } from '../../database/prisma-admin.service';
import { EmailService } from '../../email/email.service';
import { normalizeHeader, parseRaw, resolveImportCsv } from '../../imports/import-engine';
import {
  IMPORT_ALIASES,
  IMPORT_MAX_ROWS,
  sourceFrom,
  type ImportField,
} from '../leads/platform-lead-tools.service';
import { PlatformLeadsService } from '../leads/platform-leads.service';
import { SuperAdminAuditService } from '../super-admin-audit.service';

import { SalesAssignmentService } from './sales-assignment.service';
import { clean, phoneTail } from './sales-common';
import { SalesNotifyService } from './sales-notify.service';

import type { Env } from '../../../config/env.schema';

const REP_COLUMNS = new Set<string>(SALES_REP_COLUMN_ALIASES);
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

interface Rep {
  id: string;
  fullName: string;
  email: string;
  salesCode: string | null;
}

interface Actor {
  superAdminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Lo que se hará con cada fila (y, al confirmar, cómo hacerlo). */
interface PlannedRow extends SalesDistributionRowDto {
  create?: {
    companyName: string | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    city: string | null;
    units: string | null;
    facilities: string | null;
    currentSoftware: string | null;
    profile: string | null;
    utmCampaign: string | null;
    source: string;
    note: string | null;
  };
}

interface ExistingLead {
  id: string;
  tenantId: string | null;
  salesRepId: string | null;
  salesRepName: string | null;
  companyName: string | null;
  contactName: string | null;
  email: string | null;
}

/**
 * Reparto de prospectos desde la dirección: un fichero (CSV o Excel) o los
 * leads elegidos en la lista, a un comercial, según la columna «comercial» o a
 * partes iguales. Lo que ya lleva otro comercial no se toca y lo que ya es
 * cliente se omite. Cada comercial recibe un solo aviso con lo que le toca y
 * los prospectos le salen como «Nuevos para ti» hasta que los abre.
 */
@Injectable()
export class SalesDistributionService {
  private readonly logger = new Logger(SalesDistributionService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly assignment: SalesAssignmentService,
    private readonly leads: PlatformLeadsService,
    private readonly notify: SalesNotifyService,
    private readonly email: EmailService,
    private readonly audit: SuperAdminAuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ------------------------------------------------------------- comerciales

  private async activeReps(): Promise<Rep[]> {
    return this.admin.superAdmin.findMany({
      where: { role: 'sales', isActive: true },
      select: { id: true, fullName: true, email: true, salesCode: true },
      orderBy: { fullName: 'asc' },
    });
  }

  /**
   * Quién recibe cada fila. `pick` reparte a partes iguales: siempre al que
   * menos tiene (contando los prospectos que ya llevaba), y a igualdad, en el
   * orden elegido.
   */
  private async chooser(
    mode: SalesDistributionMode,
    repId: string | undefined,
    repIds: string[] | undefined,
  ): Promise<{ reps: Rep[]; pick: (columnValue?: string | null) => Rep | string }> {
    const reps = await this.activeReps();
    const byId = new Map(reps.map((r) => [r.id, r]));
    const notFound = () =>
      new NotFoundException({
        code: 'rep_not_found',
        message: 'Ese comercial no existe o está desactivado',
      });
    if (mode === 'single') {
      const rep = repId ? byId.get(repId) : undefined;
      if (!rep) throw notFound();
      return { reps, pick: () => rep };
    }
    if (mode === 'even') {
      const ids = [...new Set(repIds ?? [])];
      const chosen = ids.map((id) => byId.get(id));
      if (chosen.length === 0 || chosen.some((r) => !r)) throw notFound();
      const groups = await this.admin.platformLead.groupBy({
        by: ['salesRepId'],
        where: {
          salesRepId: { in: ids },
          tenantId: null,
          discardedAt: null,
          status: { in: ['new', 'contacted', 'interested'] },
        },
        _count: { _all: true },
      });
      const load = new Map(ids.map((id) => [id, 0]));
      for (const g of groups) if (g.salesRepId) load.set(g.salesRepId, g._count._all);
      return {
        reps,
        pick: () => {
          let best = chosen[0]!;
          for (const r of chosen as Rep[]) {
            if (load.get(r.id)! < load.get(best.id)!) best = r;
          }
          load.set(best.id, load.get(best.id)! + 1);
          return best;
        },
      };
    }
    // Columna del fichero: su código de comercial o su email.
    const byCode = new Map(reps.filter((r) => r.salesCode).map((r) => [r.salesCode!, r]));
    const byEmail = new Map(reps.map((r) => [r.email.toLowerCase(), r]));
    return {
      reps,
      pick: (value) => {
        const v = (value ?? '').trim();
        if (!v) return 'Falta el comercial (columna «comercial»)';
        const rep = v.includes('@')
          ? byEmail.get(v.toLowerCase())
          : byCode.get(normalizeSalesCode(v) ?? '');
        return rep ?? `Comercial desconocido o desactivado: «${v}»`;
      },
    };
  }

  // -------------------------------------------------------- lo que ya existe

  /** Leads (sin descartar) y cuentas para casar por email o teléfono. */
  private async existingIndex() {
    const [rows, owners] = await Promise.all([
      this.admin.platformLead.findMany({
        where: { discardedAt: null },
        select: {
          id: true,
          tenantId: true,
          salesRepId: true,
          companyName: true,
          contactName: true,
          email: true,
          phone: true,
          salesRep: { select: { fullName: true } },
        },
      }),
      this.admin.user.findMany({
        where: { role: 'owner', tenant: { deletedAt: null } },
        select: { email: true, tenant: { select: { name: true } } },
      }),
    ]);
    const byEmail = new Map<string, ExistingLead>();
    const byPhone = new Map<string, ExistingLead>();
    for (const r of rows) {
      const lead: ExistingLead = { ...r, salesRepName: r.salesRep?.fullName ?? null };
      if (r.email) byEmail.set(r.email.toLowerCase(), lead);
      const tail = phoneTail(r.phone);
      if (tail) byPhone.set(tail, lead);
    }
    const accounts = new Map<string, string>();
    for (const o of owners) accounts.set(o.email.toLowerCase(), o.tenant.name);
    return { byEmail, byPhone, accounts };
  }

  /** Lo que se hace con un contacto que ya está en TrasterOS. */
  private existingOutcome(
    lead: ExistingLead | null,
    accountName: string | null,
  ): Pick<PlannedRow, 'status' | 'repId' | 'repName' | 'message'> | null {
    if (lead?.tenantId || accountName) {
      return {
        status: 'customer',
        repId: null,
        repName: null,
        message: accountName
          ? `Ya tiene cuenta (${accountName}): se omite`
          : 'Ya tiene cuenta: se omite',
      };
    }
    if (lead?.salesRepId) {
      return {
        status: 'taken',
        repId: lead.salesRepId,
        repName: lead.salesRepName,
        message: `Ya lo lleva ${lead.salesRepName ?? 'un comercial'}: no se toca`,
      };
    }
    return null;
  }

  // ------------------------------------------------------------- importar

  private async planImport(input: SalesBulkImportInput): Promise<PlannedRow[]> {
    const csv = await resolveImportCsv(input.csv, input.format);
    const { columns, records } = parseRaw(csv);
    if (records.length > IMPORT_MAX_ROWS) {
      throw new BadRequestException({
        code: 'too_many_rows',
        message: `Como mucho ${IMPORT_MAX_ROWS} prospectos por fichero`,
      });
    }
    const map = new Map<string, ImportField>();
    let repColumn: string | null = null;
    for (const col of columns) {
      const key = normalizeHeader(col);
      if (REP_COLUMNS.has(key)) {
        repColumn ??= col;
        continue;
      }
      const field = IMPORT_ALIASES[key];
      if (field) map.set(col, field);
    }
    if (input.mode === 'column' && !repColumn) {
      throw new BadRequestException({
        code: 'rep_column_missing',
        message: 'El fichero no tiene la columna «comercial» (su código o su email)',
      });
    }
    const { pick } = await this.chooser(input.mode, input.repId, input.repIds);
    const { byEmail, byPhone, accounts } = await this.existingIndex();
    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();

    return records.map((raw, i): PlannedRow => {
      const f: Partial<Record<ImportField, string>> = {};
      for (const [col, field] of map) {
        const v = (raw[col] ?? '').trim();
        if (v && !f[field]) f[field] = v;
      }
      const email = f.email?.toLowerCase() ?? null;
      const phone = clean(f.phone);
      const base = {
        line: i + 2,
        leadId: null,
        name: clean(f.companyName) ?? clean(f.contactName) ?? email ?? phone ?? `Fila ${i + 2}`,
        email,
        phone,
        city: clean(f.city),
      };
      const error = (message: string): PlannedRow => ({
        ...base,
        status: 'error',
        repId: null,
        repName: null,
        message,
      });
      if (!f.companyName && !f.contactName) return error('Falta la empresa o la persona');
      if (!email && !phone) return error('Falta un email o un teléfono');
      if (email && !emailOk(email)) return error('Email no válido');
      const tail = phoneTail(phone);
      const repeated = (email && seenEmails.has(email)) || (tail && seenPhones.has(tail));
      if (email) seenEmails.add(email);
      if (tail) seenPhones.add(tail);
      if (repeated) return error('Repetido en el fichero (mismo email o teléfono)');

      const lead =
        (email ? byEmail.get(email) : undefined) ?? (tail ? byPhone.get(tail) : undefined) ?? null;
      const known = this.existingOutcome(lead, email ? (accounts.get(email) ?? null) : null);
      if (known) return { ...base, leadId: lead?.id ?? null, ...known };

      const rep = pick(repColumn ? raw[repColumn] : null);
      if (typeof rep === 'string') return error(rep);
      if (lead) {
        return {
          ...base,
          leadId: lead.id,
          name: platformLeadName(lead),
          status: 'assign',
          repId: rep.id,
          repName: rep.fullName,
          message: 'Ya estaba en TrasterOS sin comercial: se le asigna',
        };
      }
      return {
        ...base,
        status: 'new',
        repId: rep.id,
        repName: rep.fullName,
        message: null,
        create: {
          companyName: clean(f.companyName),
          contactName: clean(f.contactName),
          email,
          phone,
          city: clean(f.city),
          units: clean(f.units),
          facilities: clean(f.facilities),
          currentSoftware: clean(f.currentSoftware),
          profile: clean(f.profile),
          utmCampaign: clean(f.utmCampaign),
          source: (f.source ? sourceFrom(f.source) : null) ?? 'admin',
          note: clean(f.note),
        },
      };
    });
  }

  /** Importa y reparte un fichero (o solo lo revisa, sin `commit`). */
  async importAndDistribute(
    input: SalesBulkImportInput,
    actor: Actor,
  ): Promise<SalesDistributionResultDto> {
    const batch = normalizeSalesBatch(input.batch);
    if (!input.commit) return this.result(await this.planImport(input), batch, false, 0);
    return this.withContactLock(async () => {
      const rows = await this.planImport(input);
      const assigned = await this.apply(rows, batch, actor);
      await this.audit.record({
        superAdminId: actor.superAdminId,
        action: 'admin.sales.prospects_distributed',
        targetType: 'platform_lead',
        targetId: null,
        changes: { from: 'file', mode: input.mode, batch, ...this.counts(rows), assigned },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
      return this.result(rows, batch, true, assigned);
    });
  }

  // --------------------------------------------------- leads de la lista

  private async planLeads(input: SalesDistributeLeadsInput): Promise<PlannedRow[]> {
    const { pick } = await this.chooser(input.mode, input.repId, input.repIds);
    const ids = [...new Set(input.leadIds)];
    const rows = await this.admin.platformLead.findMany({
      where: { id: { in: ids }, discardedAt: null },
      select: {
        id: true,
        tenantId: true,
        salesRepId: true,
        companyName: true,
        contactName: true,
        email: true,
        phone: true,
        city: true,
        createdAt: true,
        salesRep: { select: { fullName: true } },
      },
    });
    const emails = rows.filter((r) => !r.tenantId && r.email).map((r) => r.email!.toLowerCase());
    const owners = emails.length
      ? await this.admin.user.findMany({
          where: { role: 'owner', email: { in: emails }, tenant: { deletedAt: null } },
          select: { email: true, tenant: { select: { name: true } } },
        })
      : [];
    const accounts = new Map(owners.map((o) => [o.email.toLowerCase(), o.tenant.name]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    // En el orden de la lista elegida (los más antiguos primero si vienen sin orden).
    return ids.map((id): PlannedRow => {
      const r = byId.get(id);
      if (!r) {
        return {
          line: null,
          leadId: id,
          name: 'Lead que ya no existe',
          email: null,
          phone: null,
          city: null,
          status: 'error',
          repId: null,
          repName: null,
          message: 'Ya no existe o está descartado',
        };
      }
      const base = {
        line: null,
        leadId: r.id,
        name: platformLeadName(r),
        email: r.email,
        phone: r.phone,
        city: r.city,
      };
      const lead: ExistingLead = { ...r, salesRepName: r.salesRep?.fullName ?? null };
      const known = this.existingOutcome(
        lead,
        r.email && !r.tenantId ? (accounts.get(r.email.toLowerCase()) ?? null) : null,
      );
      if (known) return { ...base, ...known };
      const rep = pick();
      if (typeof rep === 'string') {
        return { ...base, status: 'error', repId: null, repName: null, message: rep };
      }
      return { ...base, status: 'assign', repId: rep.id, repName: rep.fullName, message: null };
    });
  }

  /** Reparte leads que ya están en TrasterOS (o solo lo revisa, sin `commit`). */
  async distributeLeads(
    input: SalesDistributeLeadsInput,
    actor: Actor,
  ): Promise<SalesDistributionResultDto> {
    const batch = normalizeSalesBatch(input.batch);
    if (!input.commit) return this.result(await this.planLeads(input), batch, false, 0);
    return this.withContactLock(async () => {
      const rows = await this.planLeads(input);
      const assigned = await this.apply(rows, batch, actor);
      await this.audit.record({
        superAdminId: actor.superAdminId,
        action: 'admin.sales.prospects_distributed',
        targetType: 'platform_lead',
        targetId: null,
        changes: { from: 'leads', mode: input.mode, batch, ...this.counts(rows), assigned },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
      return this.result(rows, batch, true, assigned);
    });
  }

  // ------------------------------------------------------------- aplicar

  /**
   * Las altas y repartos van de uno en uno con el mismo cerrojo que las altas
   * de los comerciales: nadie da de alta el mismo contacto mientras tanto.
   */
  private async withContactLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.admin.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sales-new-contact'))`;
        return fn();
      },
      { maxWait: 30_000, timeout: 600_000 },
    );
  }

  private async apply(rows: PlannedRow[], batch: string | null, actor: Actor): Promise<number> {
    const byRep = new Map<string, { name: string; count: number }>();
    let assigned = 0;
    for (const row of rows) {
      if ((row.status !== 'new' && row.status !== 'assign') || !row.repId) continue;
      try {
        let leadId = row.leadId;
        if (row.status === 'new' && row.create) {
          const { note, ...data } = row.create;
          const lead = await this.admin.platformLead.create({
            data: { ...data, status: 'new', createdById: actor.superAdminId },
            select: { id: true },
          });
          leadId = lead.id;
          row.leadId = lead.id;
          if (note) {
            await this.leads.addActivity(leadId, 'note', `Importado: ${note}`, actor.superAdminId);
          }
        }
        if (!leadId) continue;
        await this.assignment.assign({
          leadId,
          repId: row.repId,
          source: 'direction',
          byId: actor.superAdminId,
          quiet: true,
          batch,
        });
        await this.leads.addActivity(
          leadId,
          'system',
          `Repartido a ${row.repName ?? 'un comercial'} por la dirección${batch ? ` (lote «${batch}»)` : ''}`,
          null,
        );
        assigned += 1;
        const entry = byRep.get(row.repId) ?? { name: row.repName ?? '', count: 0 };
        entry.count += 1;
        byRep.set(row.repId, entry);
      } catch (err) {
        this.logger.warn(`[sales] reparto de «${row.name}»: ${String(err)}`);
        row.status = 'error';
        row.message = 'No se ha podido repartir';
      }
    }
    for (const [repId, { count }] of byRep) await this.tellRep(repId, count, batch);
    return assigned;
  }

  /** Un solo aviso por comercial: en su panel y por correo. */
  private async tellRep(repId: string, count: number, batch: string | null): Promise<void> {
    const title =
      count === 1
        ? `Tienes un prospecto nuevo${batch ? ` del lote «${batch}»` : ' de la dirección'}`
        : `Tienes ${count} prospectos nuevos${batch ? ` del lote «${batch}»` : ' de la dirección'}`;
    const params = new URLSearchParams({ filter: 'new_for_you' });
    if (batch) params.set('batch', batch);
    const link = `/admin/sales/leads?${params.toString()}`;
    await this.notify.rep(repId, {
      type: 'sales.batch_assigned',
      title,
      body: 'Los tienes en «Prospectos», marcados como «Nuevos para ti» hasta que los abras.',
      link,
    });
    const rep = await this.admin.superAdmin.findUnique({
      where: { id: repId },
      select: { email: true, fullName: true },
    });
    if (!rep) return;
    const site = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
    const hello = rep.fullName.trim().split(/\s+/)[0];
    const mail = renderAdminEmail(
      [
        `Hola${hello ? ` ${hello}` : ''}:`,
        '',
        `La dirección te ha pasado ${count === 1 ? 'un prospecto nuevo' : `${count} prospectos nuevos`}${batch ? ` del lote «${batch}»` : ''}.`,
        'Te salen en «Prospectos» marcados como «Nuevos para ti» hasta que los abras.',
        '',
        `[[boton: Ver mis prospectos nuevos | ${site}${link}]]`,
      ].join('\n'),
    );
    await this.email
      .sendRendered({
        to: rep.email,
        subject: title,
        html: mail.html,
        text: mail.text,
        kind: 'staff_notice',
        tags: { type: 'sales' },
      })
      .catch((err: unknown) => this.logger.warn(`[sales] correo del reparto: ${String(err)}`));
  }

  // ------------------------------------------------------------- resultado

  private counts(rows: PlannedRow[]) {
    const n = (s: PlannedRow['status']) => rows.filter((r) => r.status === s).length;
    return {
      total: rows.length,
      new: n('new'),
      assign: n('assign'),
      taken: n('taken'),
      customers: n('customer'),
      errors: n('error'),
    };
  }

  private result(
    rows: PlannedRow[],
    batch: string | null,
    committed: boolean,
    assigned: number,
  ): SalesDistributionResultDto {
    const c = this.counts(rows);
    const byRep = new Map<string, { repId: string; repName: string; count: number }>();
    for (const r of rows) {
      if ((r.status !== 'new' && r.status !== 'assign') || !r.repId) continue;
      const e = byRep.get(r.repId) ?? { repId: r.repId, repName: r.repName ?? '', count: 0 };
      e.count += 1;
      byRep.set(r.repId, e);
    }
    return {
      batch,
      committed,
      rows: rows.map(({ create: _c, ...r }) => r),
      summary: { ...c, toAssign: c.new + c.assign },
      byRep: [...byRep.values()].sort((a, b) => b.count - a.count),
      assigned,
    };
  }

  // ---------------------------------------------------------------- lotes

  /** Lotes repartidos con en qué fase está cada prospecto ahora. */
  async batches(): Promise<SalesBatchDto[]> {
    const rows = await this.admin.$queryRaw<
      {
        name: string;
        total: number;
        with_rep: number;
        reps: number;
        new: number;
        contacted: number;
        interested: number;
        trial: number;
        customer: number;
        lost: number;
        unseen: number;
        first_at: Date | null;
        last_at: Date | null;
      }[]
    >`
      SELECT sales_batch AS name,
             count(*)::int AS total,
             count(*) FILTER (WHERE sales_rep_id IS NOT NULL)::int AS with_rep,
             count(DISTINCT sales_rep_id)::int AS reps,
             count(*) FILTER (WHERE status = 'new')::int AS new,
             count(*) FILTER (WHERE status = 'contacted')::int AS contacted,
             count(*) FILTER (WHERE status = 'interested')::int AS interested,
             count(*) FILTER (WHERE status = 'trial')::int AS trial,
             count(*) FILTER (WHERE status = 'customer')::int AS customer,
             count(*) FILTER (WHERE status = 'lost')::int AS lost,
             count(*) FILTER (WHERE sales_rep_id IS NOT NULL AND sales_seen_at IS NULL)::int AS unseen,
             min(sales_assigned_at) AS first_at,
             max(sales_assigned_at) AS last_at
        FROM platform_leads
       WHERE sales_batch IS NOT NULL AND discarded_at IS NULL
       GROUP BY sales_batch
       ORDER BY max(created_at) DESC
       LIMIT 200`;
    return rows.map((r) => ({
      name: r.name,
      total: r.total,
      withRep: r.with_rep,
      reps: r.reps,
      new: r.new,
      contacted: r.contacted,
      interested: r.interested,
      trial: r.trial,
      customer: r.customer,
      lost: r.lost,
      unseen: r.unseen,
      firstAssignedAt: r.first_at?.toISOString() ?? null,
      lastAssignedAt: r.last_at?.toISOString() ?? null,
    }));
  }
}
