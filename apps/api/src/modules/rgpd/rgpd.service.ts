import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { RequestMeta } from '../auth/auth.service';
import type { DataSubjectRequest } from '@storageos/database';
import type { CreateDataSubjectRequestInput, DataSubjectRequestDto } from '@storageos/shared';

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
@Injectable()
export class RgpdService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<DataSubjectRequestDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.dataSubjectRequest.findMany({
          orderBy: [{ submittedAt: 'desc' }],
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
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
      return { customer };
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
    await this.prisma.withTenant(async (tx) => {
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
          firstName: '*** ANONIMIZADO ***',
          lastName: '',
          companyName: customer.companyName ? '*** ANONIMIZADO ***' : null,
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
          deletedAt: new Date(),
        },
      });
      // Borrar documentos del cliente (no son obligatorios fiscalmente).
      await tx.customerDocument.deleteMany({ where: { customerId: args.customerId } });
      // Borrar metodos de pago.
      await tx.paymentMethod.deleteMany({ where: { customerId: args.customerId } });
      if (args.requestId) {
        await tx.dataSubjectRequest.update({
          where: { id: args.requestId },
          data: { status: 'fulfilled', fulfilledAt: new Date() },
        });
      }
    }, args.tenantId);
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

  private toDto(row: DataSubjectRequest): DataSubjectRequestDto {
    return {
      id: row.id,
      customerId: row.customerId,
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
