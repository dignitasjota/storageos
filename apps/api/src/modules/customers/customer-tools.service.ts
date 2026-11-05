import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { customerScopeWhere } from '../../common/customer-scope';
import { tenantPortalLoginUrl } from '../../common/portal-url';
import { AuditService } from '../auth/audit.service';
import { CommunicationsService } from '../communications/communications.service';
import { TEMPLATE_VARIABLES_BY_TRIGGER, renderText } from '../communications/template-engine';
import { PrismaService } from '../database/prisma.service';

import type { FacilityScope } from '../../common/facility-scope';
import type { Env } from '../../config/env.schema';
import type { Prisma } from '@storageos/database';
import type {
  BulkCustomerMessageInput,
  BulkCustomerTagsInput,
  CreateCustomerDocumentRequestInput,
  CustomerContactDto,
  CustomerDocumentRequestDto,
  CustomerMessageInput,
  CustomerSavedViewDto,
  DeletedCustomerDto,
  SaveCustomerViewInput,
  UpsertCustomerContactInput,
} from '@storageos/shared';

const DOCUMENT_LABELS: Record<string, string> = {
  id_front: 'DNI/NIE (anverso)',
  id_back: 'DNI/NIE (reverso)',
  proof_of_address: 'comprobante de domicilio',
  other: 'documento',
};

const nameOf = (c: {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}) =>
  (c.customerType === 'business'
    ? c.companyName
    : [c.firstName, c.lastName].filter(Boolean).join(' ')) || 'Sin nombre';

/** Anonimizar no deja marca propia: el nombre es lo que lo delata. */
const ANON = '*** ANONIMIZADO ***';
const isAnonymized = (c: { firstName: string | null; companyName: string | null }) =>
  c.firstName === ANON || c.companyName === ANON;

const CUSTOMER_NAME = {
  customerType: true,
  firstName: true,
  lastName: true,
  companyName: true,
} as const;

/** Lo que el equipo hace con un inquilino o con varios, fuera de su ficha básica. */
@Injectable()
export class CustomerToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ------------------------------------------------------------- contactos
  async listContacts(tenantId: string, customerId: string): Promise<CustomerContactDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) => tx.customerContact.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
      tenantId,
    );
    return rows.map((r) => this.contactDto(r));
  }

  async addContact(
    tenantId: string,
    customerId: string,
    input: UpsertCustomerContactInput,
  ): Promise<CustomerContactDto> {
    const row = await this.prisma.withTenant(async (tx) => {
      await this.assertCustomer(tx, customerId);
      return tx.customerContact.create({
        data: {
          tenantId,
          customerId,
          name: input.name,
          role: input.role || null,
          email: input.email || null,
          phone: input.phone || null,
        },
      });
    }, tenantId);
    return this.contactDto(row);
  }

  async updateContact(
    tenantId: string,
    customerId: string,
    id: string,
    input: UpsertCustomerContactInput,
  ): Promise<CustomerContactDto> {
    const row = await this.prisma.withTenant(async (tx) => {
      await this.assertContact(tx, customerId, id);
      return tx.customerContact.update({
        where: { id },
        data: {
          name: input.name,
          role: input.role || null,
          email: input.email || null,
          phone: input.phone || null,
        },
      });
    }, tenantId);
    return this.contactDto(row);
  }

  async removeContact(tenantId: string, customerId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      await this.assertContact(tx, customerId, id);
      await tx.customerContact.delete({ where: { id } });
    }, tenantId);
  }

  // ---------------------------------------------------- documentos pedidos
  async listRequests(tenantId: string, customerId: string): Promise<CustomerDocumentRequestDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerDocumentRequest.findMany({
          where: { customerId, status: { not: 'cancelled' } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      tenantId,
    );
    return rows.map((r) => this.requestDto(r));
  }

  async requestDocument(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    input: CreateCustomerDocumentRequestInput;
  }): Promise<CustomerDocumentRequestDto> {
    const { tenantId, customerId, input } = args;
    const { row, customer, tenant } = await this.prisma.withTenant(async (tx) => {
      const customer = await this.assertCustomer(tx, customerId);
      const pending = await tx.customerDocumentRequest.count({
        where: { customerId, type: input.type, status: 'pending' },
      });
      if (pending > 0) {
        throw new ConflictException({
          code: 'document_already_requested',
          message: 'Ya está pedido y sin subir',
        });
      }
      const row = await tx.customerDocumentRequest.create({
        data: {
          tenantId,
          customerId,
          type: input.type,
          note: input.note || null,
          requestedByUserId: args.userId,
        },
      });
      const tenant = await tx.tenant.findFirstOrThrow({
        select: { name: true, slug: true, customDomain: true, customDomainVerifiedAt: true },
      });
      return { row, customer, tenant };
    }, tenantId);

    let emailed = false;
    if (customer.email) {
      const url = tenantPortalLoginUrl(this.config.get('WEB_BASE_URL', { infer: true }), tenant);
      const lines = [
        `Hola ${customer.firstName ?? customer.companyName ?? ''},`.replace(' ,', ','),
        '',
        `Necesitamos tu ${DOCUMENT_LABELS[input.type] ?? 'documento'}.`,
        ...(input.note ? [input.note] : []),
        '',
        `Puedes subirlo desde tu área de clientes: ${url}`,
        '',
        `El equipo de ${tenant.name}`,
      ];
      await this.communications.enqueue({
        tenantId,
        channel: 'email',
        recipient: customer.email,
        customerId,
        subject: `Necesitamos un documento · ${tenant.name}`,
        bodyText: lines.join('\n'),
        source: 'customer.document_request',
      });
      emailed = true;
    }
    return { ...this.requestDto(row), emailed };
  }

  async cancelRequest(tenantId: string, customerId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const done = await tx.customerDocumentRequest.updateMany({
        where: { id, customerId, status: 'pending' },
        data: { status: 'cancelled' },
      });
      if (done.count === 0) {
        throw new NotFoundException({
          code: 'document_request_not_found',
          message: 'Solicitud no encontrada',
        });
      }
    }, tenantId);
  }

  // ---------------------------------------------------------------- vistas
  async listViews(tenantId: string): Promise<CustomerSavedViewDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customerSavedView.findMany({
          orderBy: { name: 'asc' },
          include: { createdBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      filters: r.filters as Record<string, unknown>,
      createdByName: r.createdBy?.fullName ?? null,
    }));
  }

  /** Guardar con un nombre que ya existe la sustituye. */
  async saveView(
    tenantId: string,
    userId: string,
    input: SaveCustomerViewInput,
  ): Promise<CustomerSavedViewDto> {
    const filters = input.filters as Prisma.InputJsonValue;
    const row = await this.prisma.withTenant(
      (tx) =>
        tx.customerSavedView.upsert({
          where: { tenantId_name: { tenantId, name: input.name } },
          create: { tenantId, name: input.name, filters, createdByUserId: userId },
          update: { filters },
          include: { createdBy: { select: { fullName: true } } },
        }),
      tenantId,
    );
    return {
      id: row.id,
      name: row.name,
      filters: row.filters as Record<string, unknown>,
      createdByName: row.createdBy?.fullName ?? null,
    };
  }

  async deleteView(tenantId: string, id: string): Promise<void> {
    await this.prisma.withTenant(
      (tx) => tx.customerSavedView.deleteMany({ where: { id } }),
      tenantId,
    );
  }

  // ------------------------------------------------------ borrados y lotes
  async listDeleted(tenantId: string, scope: FacilityScope): Promise<DeletedCustomerDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: { deletedAt: { not: null }, ...customerScopeWhere(scope) },
          orderBy: { deletedAt: 'desc' },
          take: 200,
          select: {
            id: true,
            ...CUSTOMER_NAME,
            email: true,
            deletedAt: true,
            mergedInto: { select: { id: true, ...CUSTOMER_NAME } },
          },
        }),
      tenantId,
    );
    return rows.map((r) => ({
      id: r.id,
      displayName: nameOf(r),
      email: r.email,
      deletedAt: r.deletedAt!.toISOString(),
      mergedInto: r.mergedInto ? { id: r.mergedInto.id, displayName: nameOf(r.mergedInto) } : null,
      anonymized: isAnonymized(r),
    }));
  }

  async restore(tenantId: string, userId: string, id: string): Promise<void> {
    await this.prisma.withTenant(async (tx) => {
      const row = await tx.customer.findUnique({
        where: { id },
        select: {
          deletedAt: true,
          mergedIntoCustomerId: true,
          firstName: true,
          companyName: true,
        },
      });
      if (!row) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Inquilino no encontrado',
        });
      }
      if (!row.deletedAt) {
        throw new BadRequestException({
          code: 'customer_not_deleted',
          message: 'Este inquilino no está borrado',
        });
      }
      if (row.mergedIntoCustomerId || isAnonymized(row)) {
        throw new ConflictException({
          code: 'customer_not_restorable',
          message: isAnonymized(row)
            ? 'Sus datos se anonimizaron: no se puede recuperar'
            : 'Se fusionó con otro inquilino: no se puede recuperar',
        });
      }
      await tx.customer.update({ where: { id }, data: { deletedAt: null } });
    }, tenantId);
    await this.audit.write({
      tenantId,
      userId,
      action: 'customer.restored',
      entityType: 'Customer',
      entityId: id,
    });
  }

  async bulkTags(
    tenantId: string,
    input: BulkCustomerTagsInput,
    scope: FacilityScope,
  ): Promise<{ updated: number }> {
    return this.prisma.withTenant(
      async (tx) => {
        const rows = await tx.customer.findMany({
          where: {
            id: { in: input.customerIds },
            deletedAt: null,
            ...customerScopeWhere(scope),
          },
          select: { id: true, tags: true },
        });
        const drop = new Set(input.remove);
        for (const row of rows) {
          const tags = [...new Set([...row.tags, ...input.add])].filter((t) => !drop.has(t));
          await tx.customer.update({ where: { id: row.id }, data: { tags: tags.slice(0, 20) } });
        }
        return { updated: rows.length };
      },
      tenantId,
      { timeout: 30_000 },
    );
  }

  async sendMessage(
    tenantId: string,
    customerId: string,
    input: CustomerMessageInput,
  ): Promise<{ recipient: string }> {
    const { customer, variables } = await this.messageContext(tenantId, customerId);
    const recipient = input.channel === 'whatsapp' ? customer.phone : customer.email;
    if (!recipient) {
      throw new BadRequestException({
        code: input.channel === 'whatsapp' ? 'customer_without_phone' : 'customer_without_email',
        message:
          input.channel === 'whatsapp'
            ? 'Este inquilino no tiene teléfono'
            : 'Este inquilino no tiene email',
      });
    }
    const allowed = TEMPLATE_VARIABLES_BY_TRIGGER.manual;
    await this.communications.sendManual({
      tenantId,
      input: {
        channel: input.channel,
        customerId,
        recipient,
        variables,
        ...(input.templateId && !input.bodyText ? { templateId: input.templateId } : {}),
        ...(input.bodyText ? { bodyText: renderText(input.bodyText, variables, allowed) } : {}),
        ...(input.subject ? { subject: renderText(input.subject, variables, allowed) } : {}),
      },
    });
    return { recipient };
  }

  async bulkMessage(
    tenantId: string,
    input: BulkCustomerMessageInput,
    scope: FacilityScope,
  ): Promise<{ sent: number; skipped: number }> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.customer.findMany({
          where: {
            id: { in: input.customerIds },
            deletedAt: null,
            email: { not: null },
            ...customerScopeWhere(scope),
          },
          select: { id: true },
        }),
      tenantId,
    );
    let sent = 0;
    for (const row of rows) {
      await this.sendMessage(tenantId, row.id, {
        channel: 'email',
        subject: input.subject,
        bodyText: input.bodyText,
      });
      sent += 1;
    }
    return { sent, skipped: input.customerIds.length - sent };
  }

  private async messageContext(tenantId: string, customerId: string) {
    return this.prisma.withTenant(async (tx) => {
      const customer = await this.assertCustomer(tx, customerId);
      const tenant = await tx.tenant.findFirstOrThrow({ select: { name: true } });
      return {
        customer,
        variables: {
          customer: {
            firstName: customer.firstName ?? customer.companyName ?? '',
            lastName: customer.lastName ?? '',
            displayName: nameOf(customer),
          },
          tenant: { name: tenant.name },
        },
      };
    }, tenantId);
  }

  private async assertCustomer(tx: Prisma.TransactionClient, id: string) {
    const customer = await tx.customer.findFirst({
      where: { id, deletedAt: null },
      select: { ...CUSTOMER_NAME, email: true, phone: true },
    });
    if (!customer) {
      throw new NotFoundException({
        code: 'customer_not_found',
        message: 'Inquilino no encontrado',
      });
    }
    return customer;
  }

  private async assertContact(tx: Prisma.TransactionClient, customerId: string, id: string) {
    const found = await tx.customerContact.count({ where: { id, customerId } });
    if (!found) {
      throw new NotFoundException({
        code: 'customer_contact_not_found',
        message: 'Contacto no encontrado',
      });
    }
  }

  private contactDto(r: {
    id: string;
    customerId: string;
    name: string;
    role: string | null;
    email: string | null;
    phone: string | null;
    createdAt: Date;
  }): CustomerContactDto {
    return { ...r, createdAt: r.createdAt.toISOString() };
  }

  private requestDto(r: {
    id: string;
    type: CustomerDocumentRequestDto['type'];
    note: string | null;
    status: string;
    createdAt: Date;
    fulfilledAt: Date | null;
  }): CustomerDocumentRequestDto {
    return {
      id: r.id,
      type: r.type,
      note: r.note,
      status: r.status as CustomerDocumentRequestDto['status'],
      createdAt: r.createdAt.toISOString(),
      fulfilledAt: r.fulfilledAt ? r.fulfilledAt.toISOString() : null,
    };
  }
}
