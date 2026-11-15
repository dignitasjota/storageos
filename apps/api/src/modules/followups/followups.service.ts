import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';
import { leadDisplayName } from '@storageos/shared';

import { customerScopeWhere } from '../../common/customer-scope';
import { type FacilityScope } from '../../common/facility-scope';
import { assertTeamMember, followupUpdateData } from '../../common/followup-update';
import { todayInTimezone } from '../../common/format';
import { leadScopeWhere } from '../../common/lead-scope';
import { PrismaAdminService } from '../database/prisma-admin.service';
import { PrismaService } from '../database/prisma.service';

import type {
  CreateCustomerFollowupInput,
  CustomerFollowupDto,
  FollowupInboxDto,
  FollowupInboxItemDto,
  FollowupInboxTab,
  UpdateCustomerFollowupInput,
} from '@storageos/shared';

const include = {
  customer: {
    select: { customerType: true, firstName: true, lastName: true, companyName: true },
  },
  user: { select: { fullName: true } },
  assignedTo: { select: { fullName: true } },
} satisfies Prisma.CustomerFollowupInclude;

type Row = Prisma.CustomerFollowupGetPayload<{ include: typeof include }>;

/** Lo que trae la bandeja, como mucho, en cada pestaña. */
const INBOX_LIMIT = 300;
/** «Hechos» enseña los de los últimos días. */
const DONE_DAYS = 30;

function customerName(c: Row['customer']): string {
  if (c.customerType === 'business') return c.companyName ?? 'Empresa';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Cliente';
}

function toDto(r: Row): CustomerFollowupDto {
  return {
    id: r.id,
    customerId: r.customerId,
    customerName: customerName(r.customer),
    title: r.title,
    note: r.note,
    dueDate: r.dueDate.toISOString().slice(0, 10),
    status: r.status as CustomerFollowupDto['status'],
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    authorName: r.user?.fullName ?? null,
    assignedToUserId: r.assignedToUserId,
    assignedToName: r.assignedTo?.fullName ?? null,
    outcome: r.outcome,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Seguimientos/recordatorios del staff sobre inquilinos (CRM ligero). */
@Injectable()
export class FollowupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: PrismaAdminService,
  ) {}

  /** Que el usuario pueda ver al inquilino (alcance por local) y que no esté borrado. */
  private visible(scope: FacilityScope) {
    return { customer: { deletedAt: null, ...customerScopeWhere(scope ?? null) } };
  }

  /** Bandeja: los pendientes de los inquilinos que ve, los más urgentes primero. */
  async listPending(tenantId: string, scope?: FacilityScope): Promise<CustomerFollowupDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.findMany({
          where: { status: 'pending', ...this.visible(scope) },
          orderBy: [{ dueDate: 'asc' }],
          include,
          take: 200,
        }),
      tenantId,
    );
    return rows.map(toDto);
  }

  async listForCustomer(tenantId: string, customerId: string): Promise<CustomerFollowupDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.findMany({
          where: { customerId },
          orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
          include,
        }),
      tenantId,
    );
    return rows.map(toDto);
  }

  async create(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    input: CreateCustomerFollowupInput;
  }): Promise<CustomerFollowupDto> {
    const created = await this.prisma.withTenant(async (tx) => {
      await assertTeamMember(tx, args.input.assignedToUserId);
      return tx.customerFollowup.create({
        data: {
          tenantId: args.tenantId,
          customerId: args.customerId,
          userId: args.userId,
          assignedToUserId: args.input.assignedToUserId ?? null,
          title: args.input.title,
          note: args.input.note ?? null,
          dueDate: new Date(args.input.dueDate),
        },
        include,
      });
    }, args.tenantId);
    return toDto(created);
  }

  /**
   * Marcar hecho (con lo que pasó, que queda en las conversaciones del
   * inquilino), reabrir, posponer, editar o cambiar el responsable.
   */
  async setStatus(args: {
    tenantId: string;
    id: string;
    input: UpdateCustomerFollowupInput;
    scope?: FacilityScope;
    userId?: string;
  }): Promise<CustomerFollowupDto> {
    const updated = await this.prisma.withTenant(async (tx) => {
      const existing = await tx.customerFollowup.findFirst({
        where: { id: args.id, ...this.visible(args.scope) },
        select: { id: true, customerId: true, title: true, status: true },
      });
      if (!existing) {
        throw new NotFoundException({
          code: 'followup_not_found',
          message: 'Seguimiento no encontrado',
        });
      }
      await assertTeamMember(tx, args.input.assignedToUserId);
      const row = await tx.customerFollowup.update({
        where: { id: args.id },
        data: followupUpdateData(args.input),
        include,
      });
      if (args.input.status === 'done' && existing.status !== 'done' && args.userId) {
        await tx.customerInteraction.create({
          data: {
            tenantId: args.tenantId,
            customerId: existing.customerId,
            userId: args.userId,
            type: 'note',
            content: `Seguimiento hecho: ${existing.title}${
              args.input.outcome?.trim() ? ` — ${args.input.outcome.trim()}` : ''
            }`,
          },
        });
      }
      return row;
    }, args.tenantId);
    return toDto(updated);
  }

  async remove(tenantId: string, id: string, scope?: FacilityScope): Promise<void> {
    const existing = await this.prisma.withTenant(
      (tx) =>
        tx.customerFollowup.findFirst({
          where: { id, ...this.visible(scope) },
          select: { id: true },
        }),
      tenantId,
    );
    if (!existing) {
      throw new NotFoundException({
        code: 'followup_not_found',
        message: 'Seguimiento no encontrado',
      });
    }
    await this.prisma.withTenant((tx) => tx.customerFollowup.delete({ where: { id } }), tenantId);
  }

  // --------------------------------------------------------------------------
  // Bandeja única: inquilinos y contactos
  // --------------------------------------------------------------------------

  private async today(tenantId: string): Promise<Date> {
    const t = await this.admin.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return todayInTimezone(t?.timezone ?? 'Europe/Madrid');
  }

  /**
   * Seguimientos de inquilinos y contactos juntos: hoy, atrasados, próximos o
   * hechos (30 días). «Míos» = los que tengo asignados o los que creé sin
   * responsable.
   */
  async inbox(
    tenantId: string,
    opts: {
      tab: FollowupInboxTab;
      mine: boolean;
      userId: string;
      scope: FacilityScope;
      customers: boolean;
      leads: boolean;
    },
  ): Promise<FollowupInboxDto> {
    const today = await this.today(tenantId);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const doneSince = new Date(Date.now() - DONE_DAYS * 86_400_000);
    const byTab = {
      today: { status: 'pending', dueDate: { gte: today, lt: tomorrow } },
      overdue: { status: 'pending', dueDate: { lt: today } },
      upcoming: { status: 'pending', dueDate: { gte: tomorrow } },
      done: { status: { in: ['done', 'cancelled'] }, completedAt: { gte: doneSince } },
    } satisfies Record<FollowupInboxTab, Prisma.CustomerFollowupWhereInput>;
    const mineWhere = opts.mine
      ? {
          OR: [{ assignedToUserId: opts.userId }, { assignedToUserId: null, userId: opts.userId }],
        }
      : {};
    const customerWhere = (tab: FollowupInboxTab): Prisma.CustomerFollowupWhereInput => ({
      ...byTab[tab],
      ...this.visible(opts.scope),
      ...mineWhere,
    });
    const leadWhere = (tab: FollowupInboxTab): Prisma.LeadFollowupWhereInput => ({
      ...byTab[tab],
      lead: {
        deletedAt: null,
        // Los de contactos perdidos se cancelan solos; en «Hechos» sí se ven.
        ...(tab === 'done' ? {} : { status: { not: 'lost' as const } }),
        ...leadScopeWhere(opts.scope),
      },
      ...mineWhere,
    });

    return this.prisma.withTenant(async (tx) => {
      const tabs = Object.keys(byTab) as FollowupInboxTab[];
      const counted = await Promise.all(
        tabs.map(async (t) => {
          const [c, l] = await Promise.all([
            opts.customers ? tx.customerFollowup.count({ where: customerWhere(t) }) : 0,
            opts.leads ? tx.leadFollowup.count({ where: leadWhere(t) }) : 0,
          ]);
          return [t, c + l] as const;
        }),
      );
      const counts = Object.fromEntries(counted) as Record<FollowupInboxTab, number>;

      const done = opts.tab === 'done';
      const [customers, leads] = await Promise.all([
        opts.customers
          ? tx.customerFollowup.findMany({
              where: customerWhere(opts.tab),
              include,
              orderBy: done
                ? [{ completedAt: 'desc' }]
                : [{ dueDate: 'asc' }, { createdAt: 'asc' }],
              take: INBOX_LIMIT,
            })
          : [],
        opts.leads
          ? tx.leadFollowup.findMany({
              where: leadWhere(opts.tab),
              include: {
                lead: {
                  select: {
                    firstName: true,
                    lastName: true,
                    companyName: true,
                    email: true,
                    phone: true,
                  },
                },
                user: { select: { fullName: true } },
                assignedTo: { select: { fullName: true } },
              },
              orderBy: done
                ? [{ completedAt: 'desc' }]
                : [{ dueDate: 'asc' }, { createdAt: 'asc' }],
              take: INBOX_LIMIT,
            })
          : [],
      ]);
      const items: FollowupInboxItemDto[] = [
        ...customers.map((r) => ({
          id: r.id,
          kind: 'customer' as const,
          targetId: r.customerId,
          targetName: customerName(r.customer),
          title: r.title,
          note: r.note,
          dueDate: r.dueDate.toISOString().slice(0, 10),
          status: r.status as FollowupInboxItemDto['status'],
          outcome: r.outcome,
          completedAt: r.completedAt?.toISOString() ?? null,
          authorName: r.user?.fullName ?? null,
          assignedToUserId: r.assignedToUserId,
          assignedToName: r.assignedTo?.fullName ?? null,
        })),
        ...leads.map((r) => ({
          id: r.id,
          kind: 'lead' as const,
          targetId: r.leadId,
          targetName: leadDisplayName(r.lead),
          title: r.title,
          note: r.note,
          dueDate: r.dueDate.toISOString().slice(0, 10),
          status: r.status as FollowupInboxItemDto['status'],
          outcome: r.outcome,
          completedAt: r.completedAt?.toISOString() ?? null,
          authorName: r.user?.fullName ?? null,
          assignedToUserId: r.assignedToUserId,
          assignedToName: r.assignedTo?.fullName ?? null,
        })),
      ];
      items.sort((a, b) =>
        done
          ? (b.completedAt ?? '').localeCompare(a.completedAt ?? '')
          : a.dueDate.localeCompare(b.dueDate),
      );
      return { items: items.slice(0, INBOX_LIMIT), counts };
    }, tenantId);
  }

  /** Los de hoy y los atrasados que ve el usuario (número del menú). */
  async dueCount(
    tenantId: string,
    opts: { scope: FacilityScope; customers: boolean; leads: boolean },
  ): Promise<{ due: number }> {
    const today = await this.today(tenantId);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const [c, l] = await this.prisma.withTenant(
      (tx) =>
        Promise.all([
          opts.customers
            ? tx.customerFollowup.count({
                where: {
                  status: 'pending',
                  dueDate: { lt: tomorrow },
                  ...this.visible(opts.scope),
                },
              })
            : 0,
          opts.leads
            ? tx.leadFollowup.count({
                where: {
                  status: 'pending',
                  dueDate: { lt: tomorrow },
                  lead: {
                    deletedAt: null,
                    status: { not: 'lost' },
                    ...leadScopeWhere(opts.scope),
                  },
                },
              })
            : 0,
        ]),
      tenantId,
    );
    return { due: c + l };
  }
}
