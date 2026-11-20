import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { phoneKey } from '@storageos/shared';

import { attachmentKeysOf } from '../../common/message-attachments';
import { subtractAmounts } from '../../common/money';
import { readOpsFiles } from '../../common/ops-files';
import { releaseReservedUnit } from '../../common/unit-holds';
import {
  anonymizeWhatsappConversations,
  customerWhatsappWhere,
} from '../../common/whatsapp-anonymize';
import { AuditService } from '../auth/audit.service';
import { DOMAIN_EVENTS, type UnitAvailablePayload } from '../automations/domain-events';
import { addMonthsUtc } from '../billing-saas/platform-due';
import { ContractsService } from '../contracts/contracts.service';
import { PrismaService } from '../database/prisma.service';
import { FilesService } from '../files/files.service';

import type { RequestMeta } from '../auth/auth.service';
import type { DataSubjectRequest, Prisma } from '@storageos/database';
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claves que nunca salen en la exportación de un inquilino: contraseñas,
 * tokens y secretos (aunque vayan cifrados o con hash). Las huellas de los
 * documentos firmados (`documentHash`, `contentHash`) sí: son su prueba.
 */
const SECRET_KEY_RE =
  /^(portalPasswordHash|portalSessionVersion|secretHash|secretPreview|signatureImage)$|TokenHash$|Encrypted$/;

/** Copia de `value` sin las claves secretas (recorre objetos y listas). */
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  // Decimal de Prisma y otros objetos con toJSON: se dejan como están.
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) continue;
    out[k] = stripSecrets(v);
  }
  return out;
}

/** IBAN enmascarado: solo los 4 últimos dígitos. */
function maskedIban(last4: string): string {
  return `**** **** **** **** **** ${last4}`;
}

@Injectable()
export class RgpdService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly events: EventEmitter2,
    private readonly contracts: ContractsService,
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
    // Un mes natural (art. 12.3 RGPD) sin desbordar: 31 de enero → 28/29 de febrero.
    const dueAt = addMonthsUtc(submittedAt, 1);
    const created = await this.prisma.withTenant(async (tx) => {
      if (args.input.customerId) {
        const customer = await tx.customer.findFirst({
          where: { id: args.input.customerId },
          select: { id: true },
        });
        if (!customer) {
          throw new NotFoundException({
            code: 'customer_not_found',
            message: 'El inquilino no existe.',
          });
        }
      }
      return tx.dataSubjectRequest.create({
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
      });
    }, args.tenantId);
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
   * Exporta todos los datos personales de un inquilino en un JSON (derecho de
   * acceso y portabilidad). Sin contraseñas, tokens ni secretos; las cuentas
   * bancarias solo con los 4 últimos dígitos. Queda en el registro de actividad.
   */
  async exportCustomerData(
    tenantId: string,
    customerId: string,
    actor?: { userId: string; meta: RequestMeta },
  ): Promise<Record<string, unknown>> {
    const data = await this.prisma.withTenant(async (tx) => {
      const exists = await tx.customer.findFirst({
        where: { id: customerId },
        select: { id: true },
      });
      if (!exists) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'El inquilino no existe.',
        });
      }
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: customerId },
        include: {
          documents: true,
          contracts: {
            include: {
              events: true,
              // Firmas y condiciones generales aceptadas (con su evidencia).
              signatures: {
                select: {
                  signerName: true,
                  signerEmail: true,
                  method: true,
                  channel: true,
                  documentHash: true,
                  ipAddress: true,
                  userAgent: true,
                  signedAt: true,
                },
              },
              // Anexos (texto, estado y evidencia de la firma).
              annexes: {
                select: {
                  number: true,
                  title: true,
                  status: true,
                  termsText: true,
                  documentHash: true,
                  signerName: true,
                  signatureMethod: true,
                  ipAddress: true,
                  userAgent: true,
                  signedAt: true,
                  cancelledAt: true,
                  createdAt: true,
                },
              },
              legalDocAcceptances: {
                select: {
                  channel: true,
                  ipAddress: true,
                  userAgent: true,
                  acceptedAt: true,
                  version: {
                    select: { title: true, version: true, contentHash: true, content: true },
                  },
                },
              },
            },
          },
          reservations: true,
          invoices: { include: { items: true, payments: true } },
          paymentMethods: { select: { id: true, type: true, brand: true, last4: true } },
          consents: true,
          contacts: true,
          documentRequests: true,
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
      const webChatConversations = await tx.webChatConversation.findMany({
        where: webChatConversationsOf(customerId, customer.email),
        select: {
          createdAt: true,
          pagePath: true,
          messages: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { role: true, content: true, createdAt: true },
          },
        },
      });
      const [messages, communications, credentials, accessLogs, incidents, mandates] =
        await Promise.all([
          // El chat con el equipo (sin las notas internas que el inquilino no ve).
          tx.customerMessage.findMany({
            where: { customerId, isInternal: false },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              senderType: true,
              channel: true,
              body: true,
              attachmentName: true,
              createdAt: true,
            },
          }),
          tx.communication.findMany({
            where: { customerId },
            orderBy: { createdAt: 'asc' },
            select: {
              channel: true,
              status: true,
              recipient: true,
              subject: true,
              bodyText: true,
              source: true,
              sentAt: true,
              createdAt: true,
            },
          }),
          tx.accessCredential.findMany({
            where: { customerId },
            select: {
              method: true,
              status: true,
              label: true,
              holderName: true,
              validFrom: true,
              expiresAt: true,
              activatedAt: true,
              suspendedAt: true,
              revokedAt: true,
              lastUsedAt: true,
              createdAt: true,
            },
          }),
          tx.accessLog.findMany({
            where: { customerId },
            orderBy: { occurredAt: 'desc' },
            take: 2000,
            select: { method: true, result: true, reason: true, occurredAt: true },
          }),
          tx.incident.findMany({
            where: { customerId, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: {
              title: true,
              description: true,
              category: true,
              status: true,
              severity: true,
              occurredAt: true,
              resolution: true,
              resolvedAt: true,
              createdAt: true,
            },
          }),
          tx.sepaMandate.findMany({
            where: { customerId },
            select: {
              reference: true,
              ibanLast4: true,
              bic: true,
              status: true,
              signatureStatus: true,
              signedAt: true,
              signerName: true,
              signatureMethod: true,
              debtorName: true,
              debtorAddress: true,
              debtorPostalCode: true,
              debtorCity: true,
              debtorCountry: true,
              documentText: true,
              lastCollectedAt: true,
              createdAt: true,
            },
          }),
        ]);
      return {
        customer,
        chatMessages: messages,
        communications,
        accessCredentials: credentials,
        accessLogs,
        incidents,
        sepaMandates: mandates.map(({ ibanLast4, ...m }) => ({
          ...m,
          iban: maskedIban(ibanLast4),
        })),
        whatsappConversations,
        webChatConversations,
      };
    }, tenantId);
    if (actor) {
      await this.audit.write({
        tenantId,
        userId: actor.userId,
        action: 'rgpd.customer_exported',
        entityType: 'Customer',
        entityId: customerId,
        ipAddress: actor.meta.ipAddress ?? null,
        userAgent: actor.meta.userAgent ?? null,
      });
    }
    return stripSecrets(data) as Record<string, unknown>;
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
    /** Ya sabe que debe dinero y quiere anonimizarlo igual. */
    confirmDebt?: boolean;
    meta: RequestMeta;
  }): Promise<void> {
    const draftIds = await this.assertCanAnonymize(args);
    // Sus borradores se cancelan (sueltan el trastero que guardaban).
    for (const contractId of draftIds) {
      await this.contracts.cancel({
        tenantId: args.tenantId,
        userId: args.userId,
        contractId,
        input: { reason: 'Inquilino anonimizado (protección de datos)' },
        meta: args.meta,
      });
    }
    const chatAttachmentKeys: string[] = [];
    const freedUnitIds: string[] = [];
    const filesToDelete = await this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: args.customerId },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'El inquilino no existe.',
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
      // Ficheros de sus documentos (DNI, justificantes…): se borran del almacén.
      const documents = await tx.customerDocument.findMany({
        where: { customerId: args.customerId },
        select: { fileUrl: true },
      });
      const documentKeys = documents
        .map((d) => this.files.keyFromPublicUrl('uploads', d.fileUrl))
        .filter((k): k is string => !!k);
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
          billingEmail: null,
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
      await tx.customerDocumentRequest.deleteMany({ where: { customerId } });
      await tx.customerContact.deleteMany({ where: { customerId } });
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
        select: { attachmentKey: true, extraAttachments: true },
      });
      chatAttachmentKeys.push(...chatFiles.flatMap(attachmentKeysOf));
      await tx.customerMessage.updateMany({
        where: { customerId },
        data: {
          body: ANON,
          attachmentKey: null,
          attachmentMime: null,
          attachmentName: null,
          extraAttachments: [],
        },
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
      // Citas para retirar los bienes de un impago: sin notas; las pendientes se anulan.
      await tx.delinquencyPickupRequest.updateMany({
        where: { customerId, status: 'pending' },
        data: { status: 'cancelled', resolvedAt: new Date() },
      });
      await tx.delinquencyPickupRequest.updateMany({
        where: { customerId },
        data: { note: null, resolutionNote: null },
      });
      // Las reglas de la conciliación llevan su nombre como en el banco.
      await tx.bankMatchRule.deleteMany({ where: { customerId } });
      await tx.reservation.updateMany({
        where: { customerId },
        data: { notes: null, cancelReason: null },
      });
      // Fuera de la cola: si le tocara, se guardaría un trastero para nadie.
      const held = await tx.waitlistEntry.findMany({
        where: { customerId, status: 'notified', heldUnitId: { not: null } },
        select: { heldUnitId: true },
      });
      await tx.waitlistEntry.updateMany({
        where: { customerId, status: { in: ['waiting', 'notified'] } },
        data: {
          status: 'cancelled',
          holdTokenHash: null,
          interestTokenHash: null,
          preassignedUnitId: null,
        },
      });
      await tx.waitlistEntry.updateMany({
        where: { customerId },
        data: { contactName: ANON, contactEmail: ANON, contactPhone: null, notes: null },
      });
      for (const { heldUnitId } of held) {
        if (
          heldUnitId &&
          (await releaseReservedUnit(tx, {
            tenantId: args.tenantId,
            unitId: heldUnitId,
            userId: args.userId,
            reason: 'Lista de espera: inquilino anonimizado',
          }))
        ) {
          freedUnitIds.push(heldUnitId);
        }
      }

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
      // Sus conversaciones del chat de la web (nombre, teléfono, DNI de la
      // reserva…): se borran, antes de quitarle el email al contacto.
      await tx.webChatConversation.deleteMany({
        where: webChatConversationsOf(customerId, customer.email),
      });
      // Su ficha de contacto (lead) de antes de ser cliente: la convertida, la
      // de su email o, si no tiene email, la de su teléfono (por sus 9 últimas
      // cifras, como al juntar contactos: «600 555 444» = «+34600555444»).
      {
        const key = customer.email ? null : phoneKey(customer.phone);
        const byPhone = key
          ? await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM leads
               WHERE right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 9) = ${key}`
          : [];
        await tx.lead.updateMany({
          where: {
            OR: [
              { convertedCustomerId: customerId },
              ...(customer.email
                ? [{ email: { equals: customer.email, mode: 'insensitive' as const } }]
                : []),
              ...(byPhone.length > 0 ? [{ id: { in: byPhone.map((r) => r.id) } }] : []),
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
      // Fotos de sus incidencias (las que subió y las del equipo).
      const incidents = await tx.incident.findMany({
        where: { customerId, NOT: { photos: { equals: [] } } },
        select: { id: true, photos: true },
      });
      const incidentPhotoKeys = incidents.flatMap((i) => readOpsFiles(i.photos).map((f) => f.key));
      if (incidents.length > 0) {
        await tx.incident.updateMany({
          where: { id: { in: incidents.map((i) => i.id) } },
          data: { photos: [] },
        });
      }
      // Las que reportó él desde el área de clientes llevan su nombre y su texto;
      // las del equipo conservan el texto (son del local), pero sin su nombre.
      await tx.incident.updateMany({
        where: { customerId, reportedByUserId: null, reportedByExternal: { startsWith: 'Portal' } },
        data: { title: ANON, description: ANON, reportedByExternal: 'Portal' },
      });
      await tx.incident.updateMany({
        where: {
          customerId,
          reportedByExternal: { not: null },
          NOT: { reportedByExternal: 'Portal' },
        },
        data: { reportedByExternal: null },
      });
      // Mandatos SEPA: se dan de baja. Se conservan referencia, fecha y cuenta
      // (cifrada) porque son la prueba ante una reclamación de un adeudo ya
      // cobrado (el banco la admite hasta 13 meses después), igual que la firma
      // del contrato y los preavisos de las remesas.
      await tx.sepaMandate.updateMany({
        where: { customerId, status: 'active' },
        data: { status: 'cancelled' },
      });
      // Firma del contrato y condiciones generales aceptadas: se conservan como
      // prueba (qué se firmó, qué versión, cuándo y por qué canal) sin la IP,
      // el navegador ni el email de quien firmó.
      await tx.contractSignature.updateMany({
        where: { contract: { customerId } },
        data: { ipAddress: null, userAgent: null, signerEmail: null },
      });
      await tx.contractAnnex.updateMany({
        where: { contract: { customerId } },
        data: { ipAddress: null, userAgent: null, sentTo: null },
      });
      await tx.legalDocAcceptance.updateMany({
        where: { customerId },
        data: { ipAddress: null, userAgent: null },
      });
      const fileKeys = [
        ...documentKeys,
        ...faces.map((f) => f.facePhotoKey!),
        ...photos.map((p) => p.key),
        ...incidentPhotoKeys,
      ];
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
    // Fotos que subió para una incidencia y no llegó a enviar.
    await this.files
      .deleteByPrefix('uploads', `${args.tenantId}/incidents/portal/${args.customerId}/`)
      .catch(() => undefined);
    for (const unitId of freedUnitIds) {
      this.events.emit(DOMAIN_EVENTS.unit_available, {
        tenantId: args.tenantId,
        unitId,
      } satisfies UnitAvailablePayload);
    }
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'rgpd.customer_anonymized',
      entityType: 'Customer',
      entityId: args.customerId,
      changes: {
        ...(args.requestId ? { requestId: args.requestId } : {}),
        ...(draftIds.length > 0 ? { cancelledDrafts: draftIds.length } : {}),
      },
      ipAddress: args.meta.ipAddress ?? null,
      userAgent: args.meta.userAgent ?? null,
    });
  }

  /**
   * Lo mismo que impide borrar a un inquilino: contratos vivos, reservas y deuda
   * (salvo que se confirme). Devuelve sus borradores, que se cancelan antes.
   */
  private async assertCanAnonymize(args: {
    tenantId: string;
    customerId: string;
    requestId?: string;
    confirmDebt?: boolean;
  }): Promise<string[]> {
    if (args.requestId !== undefined && !UUID_RE.test(args.requestId)) {
      throw new BadRequestException({
        code: 'invalid_request_id',
        message: 'La solicitud indicada no es válida.',
      });
    }
    return this.prisma.withTenant(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: args.customerId },
        select: { id: true, email: true },
      });
      if (!customer) {
        throw new NotFoundException({
          code: 'customer_not_found',
          message: 'El inquilino no existe.',
        });
      }
      if (args.requestId) {
        const request = await tx.dataSubjectRequest.findFirst({
          where: { id: args.requestId },
          select: { customerId: true, email: true },
        });
        if (!request) {
          throw new NotFoundException({
            code: 'request_not_found',
            message: 'Solicitud no encontrada.',
          });
        }
        const same = request.customerId
          ? request.customerId === args.customerId
          : !!customer.email && request.email.toLowerCase() === customer.email.toLowerCase();
        if (!same) {
          throw new BadRequestException({
            code: 'request_customer_mismatch',
            message: 'La solicitud es de otra persona.',
          });
        }
      }
      const live = await tx.contract.count({
        where: {
          customerId: args.customerId,
          status: { in: ['active', 'ending'] },
          deletedAt: null,
        },
      });
      if (live > 0) {
        throw new BadRequestException({
          code: 'has_active_contract',
          message: 'No se puede anonimizar un cliente con contratos activos',
        });
      }
      const reservations = await tx.reservation.count({
        where: { customerId: args.customerId, status: { in: ['pending', 'confirmed'] } },
      });
      if (reservations > 0) {
        throw new ConflictException({
          code: 'customer_has_reservations',
          message: 'Tiene una reserva en curso: cancélala antes de anonimizarlo.',
        });
      }
      const debt = await tx.invoice.aggregate({
        where: {
          customerId: args.customerId,
          status: { in: ['issued', 'overdue'] },
          deletedAt: null,
        },
        _sum: { total: true, amountPaid: true },
      });
      const pending = subtractAmounts(
        Number(debt._sum.total ?? 0),
        Number(debt._sum.amountPaid ?? 0),
      );
      if (pending > 0 && !args.confirmDebt) {
        throw new ConflictException({
          code: 'customer_has_debt',
          message: 'Tiene facturas pendientes de cobro.',
          details: { amount: pending },
        });
      }
      const drafts = await tx.contract.findMany({
        where: { customerId: args.customerId, status: 'draft', deletedAt: null },
        select: { id: true },
      });
      return drafts.map((d) => d.id);
    }, args.tenantId);
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

/**
 * Conversaciones del chat de la web de un inquilino: las de sus contratos, las
 * de su ficha de contacto y las de cualquier contacto con su email.
 */
function webChatConversationsOf(
  customerId: string,
  email: string | null,
): Prisma.WebChatConversationWhereInput {
  return {
    OR: [
      { contract: { is: { customerId } } },
      { lead: { is: { convertedCustomerId: customerId } } },
      ...(email
        ? [{ lead: { is: { email: { equals: email, mode: 'insensitive' as const } } } }]
        : []),
    ],
  };
}
