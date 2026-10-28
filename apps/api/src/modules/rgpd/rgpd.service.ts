import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import {
  anonymizeWhatsappConversations,
  customerWhatsappWhere,
} from '../../common/whatsapp-anonymize';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { RequestMeta } from '../auth/auth.service';
import type { DataSubjectRequest } from '@storageos/database';
import type {
  CreateDataSubjectRequestInput,
  DataSubjectRequestDto,
  UpdateDataSubjectRequestInput,
} from '@storageos/shared';

/**
 * Servicio RGPD. Gestiona los derechos del titular de los datos:
 * acceso, rectificacion, supresion, portabilidad, restriccion.
 *
 * SLA legal: 1 mes desde `submitted_at`. El sistema fija `due_at`
 * automaticamente al crear la solicitud.
 *
 * **Supresion**: la legislacion fiscal espanyola (Ley 58/2003 art. 70.3
 * y RD 1619/2012 art. 17 + Verifactu RD 1007/2023) obliga a conservar
 * facturas durante 4-6 anyos. Por tanto el "borrado" anonimiza el
 * customer (nombre, email, telefono, direccion, documento) pero mantiene
 * sus facturas intactas (`invoices.customer_id` queda apuntando a un
 * customer anonimo). La anonimizacion es irreversible.
 */
const ANON = '*** ANONIMIZADO ***';

@Injectable()
export class RgpdService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  async list(tenantId: string): Promise<DataSubjectRequestDto[]> {
    const { rows, names } = await this.prisma.withTenant(async (tx) => {
      const rows = await tx.dataSubjectRequest.findMany({
        orderBy: [{ submittedAt: 'desc' }],
      });
      const ids = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))];
      const customers = ids.length
        ? await tx.customer.findMany({
            where: { id: { in: ids } },
            select: { id: true, firstName: true, lastName: true, companyName: true },
          })
        : [];
      const names = new Map(
        customers.map((c) => [
          c.id,
          c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
        ]),
      );
      return { rows, names };
    }, tenantId);
    return rows.map((r) => this.toDto(r, r.customerId ? names.get(r.customerId) : null));
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateDataSubjectRequestInput;
    meta: RequestMeta;
  }): Promise<DataSubjectRequestDto> {
    const submittedAt = new Date();
    const dueAt = new Date(submittedAt);
    dueAt.setUTCMonth(dueAt.getUTCMonth() + 1);
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.dataSubjectRequest.create({
          data: {
            tenantId: args.tenantId,
            ...(args.input.customerId ? { customerId: args.input.customerId } : {}),
            email: args.input.email,
            requestType: args.input.requestType,
            submittedAt,
            dueAt,
            notes: args.input.notes?.trim() || null,
            handledByUserId: args.userId,
          },
        }),
      args.tenantId,
    );
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'rgpd.request_created',
      entityType: 'DataSubjectRequest',
      entityId: created.id,
      changes: { requestType: args.input.requestType, email: args.input.email },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(created);
  }

  /**
   * Exporta todos los datos personales de un customer en un JSON. El
   * usuario llama a este endpoint, recibe un JSON inline con el detalle
   * (de momento sin firma; en Fase 8 se cifrara con la clave del cliente
   * y se subira a MinIO).
   */
  async exportCustomerData(tenantId: string, customerId: string): Promise<Record<string, unknown>> {
    const data = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: customerId },
        include: {
          documents: true,
          contracts: { include: { events: true } },
          reservations: true,
          invoices: { include: { items: true, payments: true } },
          paymentMethods: { select: { id: true, type: true, brand: true, last4: true } },
          consents: true,
        },
      });
      const whatsappConversations = await tx.whatsappConversation.findMany({
        where: customerWhatsappWhere(customerId, customer.phone),
        select: {
          waId: true,
          contactName: true,
          createdAt: true,
          messages: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { direction: true, sender: true, body: true, createdAt: true },
          },
        },
      });
      return { customer, whatsappConversations };
    }, tenantId);
    return data;
  }

  /**
   * Anonimiza un customer. Mantiene sus facturas (obligacion fiscal) pero
   * sustituye los datos personales por placeholders.
   *
   * Importante: invoices.customer_id sigue apuntando al mismo row, pero
   * los campos personales del customer quedan vacios (`*** ANONIMIZADO ***`).
   * Esto permite imprimir facturas historicas con `Cliente: *** ANONIMIZADO ***`
   * cumpliendo a la vez derecho al olvido y obligacion fiscal.
   */
  async anonymizeCustomer(args: {
    tenantId: string;
    userId: string;
    customerId: string;
    requestId?: string;
    meta: RequestMeta;
  }): Promise<void> {
    const chatAttachmentKeys: string[] = [];
    const filesToDelete = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: args.customerId },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'Customer no encontrado',
        });
      }
      const activeContract = await tx.contract.findFirst({
        where: { customerId: args.customerId, status: { in: ['active', 'ending'] } },
      });
      if (activeContract) {
        throw new BadRequestException({
          code: 'has_active_contract',
          message: 'No se puede anonimizar un cliente con contratos activos',
        });
      }
      await tx.customer.update({
        where: { id: args.customerId },
        data: {
          firstName: ANON,
          lastName: '',
          companyName: customer.companyName ? ANON : null,
          email: null,
          phone: null,
          address: null,
          city: null,
          postalCode: null,
          documentNumber: null,
          emergencyContactName: null,
          emergencyContactPhone: null,
          notes: null,
          tags: [],
          portalAccessEnabled: false,
          portalPasswordHash: null,
          // Cierra las sesiones del área de clientes que siguieran abiertas.
          portalSessionVersion: { increment: 1 },
          referralCode: null,
          deletedAt: new Date(),
        },
      });
      const customerId = args.customerId;
      // Borrar documentos del cliente (no son obligatorios fiscalmente).
      await tx.customerDocument.deleteMany({ where: { customerId } });
      // Borrar metodos de pago.
      await tx.paymentMethod.deleteMany({ where: { customerId } });

      // Accesos: revocados y sin secreto, tarjeta ni cara (el PIN no debe abrir
      // nada y la foto es un dato biométrico).
      const faces = await tx.accessCredential.findMany({
        where: { customerId, facePhotoKey: { not: null } },
        select: { facePhotoKey: true },
      });
      await tx.accessCredential.updateMany({
        where: { customerId },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          secretHash: null,
          secretPreview: null,
          secretEncrypted: null,
          rfidUid: null,
          facePhotoKey: null,
          label: null,
          metadata: {},
        },
      });
      await tx.pushSubscription.deleteMany({ where: { customerId } });

      // Lo que el inquilino escribió o lo que el equipo anotó sobre él.
      // Los adjuntos del chat (fotos, PDF) también se borran.
      const chatFiles = await tx.customerMessage.findMany({
        where: { customerId, attachmentKey: { not: null } },
        select: { attachmentKey: true },
      });
      chatAttachmentKeys.push(...chatFiles.map((m) => m.attachmentKey!));
      await tx.customerMessage.updateMany({
        where: { customerId },
        data: { body: ANON, attachmentKey: null, attachmentMime: null, attachmentName: null },
      });
      await tx.customerInteraction.updateMany({ where: { customerId }, data: { content: ANON } });
      // Las personas autorizadas son datos de terceros: se borran.
      await tx.customerAuthorizedPerson.deleteMany({ where: { customerId } });
      await tx.customerFollowup.updateMany({
        where: { customerId },
        data: { title: ANON, note: null },
      });
      await tx.review.updateMany({
        where: { customerId },
        data: { comment: null, ip: null, userAgent: null },
      });
      await tx.unitChangeRequest.updateMany({
        where: { customerId },
        data: { note: ANON, resolutionNote: null },
      });
      await tx.unitRequest.updateMany({
        where: { customerId },
        data: { note: ANON, resolutionNote: null },
      });
      await tx.waitlistEntry.updateMany({
        where: { customerId },
        data: { contactName: ANON, contactEmail: ANON, contactPhone: null, notes: null },
      });

      // Correos y mensajes que se le enviaron (el texto lleva sus datos).
      await tx.communication.updateMany({
        where: { customerId },
        data: {
          recipient: ANON,
          subject: ANON,
          bodyText: ANON,
          bodyHtml: null,
          variables: {},
          secretsEncrypted: null,
          errorMessage: null,
        },
      });
      // Su ficha de contacto (lead) de antes de ser cliente.
      if (customer.email) {
        await tx.lead.updateMany({
          where: {
            OR: [
              { convertedCustomerId: customerId },
              { email: { equals: customer.email, mode: 'insensitive' } },
            ],
          },
          data: {
            firstName: ANON,
            lastName: null,
            companyName: null,
            email: null,
            phone: null,
            message: null,
            metadata: {},
            deletedAt: new Date(),
          },
        });
      }

      // Fotos de inspección del trastero (entrada/salida).
      const photos = await tx.contractInspectionPhoto.findMany({
        where: { contract: { customerId } },
        select: { id: true, key: true },
      });
      await tx.contractInspectionPhoto.deleteMany({
        where: { id: { in: photos.map((p) => p.id) } },
      });
      // Mandatos SEPA: se dan de baja. Se conservan referencia, fecha y cuenta
      // (cifrada) porque son la prueba ante una reclamación de un adeudo ya
      // cobrado (el banco la admite hasta 13 meses después), igual que la firma
      // del contrato y los preavisos de las remesas.
      await tx.sepaMandate.updateMany({
        where: { customerId, status: 'active' },
        data: { status: 'cancelled' },
      });
      const fileKeys = [...faces.map((f) => f.facePhotoKey!), ...photos.map((p) => p.key)];
      // Conversaciones de WhatsApp: sin texto ni número.
      const whatsapp = await anonymizeWhatsappConversations(
        tx,
        customerWhatsappWhere(args.customerId, customer.phone),
      );
      if (args.requestId) {
        await tx.dataSubjectRequest.update({
          where: { id: args.requestId },
          data: { status: 'fulfilled', fulfilledAt: new Date() },
        });
      }
      return [...whatsapp.mediaKeys, ...fileKeys];
    }, args.tenantId);
    await this.files.deleteObjects('uploads', [...filesToDelete, ...chatAttachmentKeys]);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'rgpd.customer_anonymized',
      entityType: 'Customer',
      entityId: args.customerId,
      ...(args.requestId ? { changes: { requestId: args.requestId } } : {}),
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  async updateRequest(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateDataSubjectRequestInput;
    meta: RequestMeta;
  }): Promise<DataSubjectRequestDto> {
    const row = await this.prisma.withTenant(async (tx) => {
      const current = await tx.dataSubjectRequest.findUnique({ where: { id: args.id } });
      if (!current) {
        throw new NotFoundException({
          message: 'Solicitud no encontrada',
          code: 'request_not_found',
        });
      }
      const closing = args.input.status === 'fulfilled' || args.input.status === 'denied';
      return tx.dataSubjectRequest.update({
        where: { id: args.id },
        data: {
          status: args.input.status,
          handledByUserId: args.userId,
          fulfilledAt: closing ? (current.fulfilledAt ?? new Date()) : null,
          ...(args.input.notes !== undefined ? { notes: args.input.notes } : {}),
        },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'rgpd.request_updated',
      entityType: 'DataSubjectRequest',
      entityId: args.id,
      changes: { status: args.input.status },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
    return this.toDto(row);
  }

  private toDto(row: DataSubjectRequest, customerName?: string | null): DataSubjectRequestDto {
    return {
      id: row.id,
      customerId: row.customerId,
      customerName: customerName ?? null,
      email: row.email,
      requestType: row.requestType,
      status: row.status,
      submittedAt: row.submittedAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      fulfilledAt: row.fulfilledAt ? row.fulfilledAt.toISOString() : null,
      exportFileUrl: row.exportFileUrl,
      notes: row.notes,
    };
  }
}
