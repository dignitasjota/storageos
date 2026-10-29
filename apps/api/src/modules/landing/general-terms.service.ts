import { createHash } from 'node:crypto';

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@storageos/database';

import { PrismaAdminService } from '../database/prisma-admin.service';

import { WebLegalService } from './web-legal.service';

import type {
  GeneralTermsToAcceptDto,
  LegalDocAcceptanceDto,
  LegalDocVersionDto,
} from '@storageos/shared';

const DOC = 'condiciones-contratacion' as const;

/**
 * Condiciones Generales de Contratación que el inquilino acepta antes de pagar.
 * Cada texto aceptado se guarda como una versión inmutable (número + huella):
 * si el negocio cambia sus condiciones, las aceptaciones anteriores siguen
 * apuntando al texto que se aceptó.
 */
@Injectable()
export class GeneralTermsService {
  constructor(
    private readonly admin: PrismaAdminService,
    private readonly legal: WebLegalService,
  ) {}

  /** Texto vigente con su huella. */
  async current(tenantId: string) {
    const doc = await this.legal.effectiveDoc(tenantId, DOC);
    return { ...doc, hash: createHash('sha256').update(doc.markdown, 'utf8').digest('hex') };
  }

  /** Lo que ve el inquilino junto a la casilla. */
  async toAccept(tenantId: string, contractId: string): Promise<GeneralTermsToAcceptDto> {
    const [cur, accepted] = await Promise.all([
      this.current(tenantId),
      this.admin.legalDocAcceptance.count({ where: { tenantId, contractId } }),
    ]);
    return { title: cur.title, url: cur.url, hash: cur.hash, accepted: accepted > 0 };
  }

  async isAccepted(tenantId: string, contractId: string): Promise<boolean> {
    return (await this.admin.legalDocAcceptance.count({ where: { tenantId, contractId } })) > 0;
  }

  /** 409 si el texto cambió desde que el inquilino lo vio. */
  async assertCurrent(tenantId: string, hash: string): Promise<void> {
    const cur = await this.current(tenantId);
    if (cur.hash !== hash) {
      throw new ConflictException({
        code: 'general_terms_changed',
        message:
          'Las condiciones generales de contratación han cambiado. Vuelve a leerlas y acéptalas de nuevo.',
      });
    }
  }

  /** Guarda la aceptación de la versión vigente (crea la versión si es nueva). */
  async accept(args: {
    tenantId: string;
    customerId: string;
    contractId: string | null;
    hash: string;
    channel: 'remote' | 'in_person';
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<LegalDocAcceptanceDto> {
    const cur = await this.current(args.tenantId);
    if (cur.hash !== args.hash) {
      throw new ConflictException({
        code: 'general_terms_changed',
        message:
          'Las condiciones generales de contratación han cambiado. Vuelve a leerlas y acéptalas de nuevo.',
      });
    }
    const version = await this.ensureVersion(args.tenantId, cur);
    const row = await this.admin.legalDocAcceptance.create({
      data: {
        tenantId: args.tenantId,
        versionId: version.id,
        customerId: args.customerId,
        contractId: args.contractId,
        channel: args.channel,
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
      },
      include: { version: true },
    });
    return toAcceptanceDto(row);
  }

  /**
   * Acepta para un contrato si aún no lo estaban. Se llama ANTES de firmar: si
   * la firma falla después, el contrato sigue en borrador y al reintentar la
   * aceptación ya está hecha (y nunca queda un contrato firmado sin ella).
   */
  async acceptOnce(args: Parameters<GeneralTermsService['accept']>[0] & { contractId: string }) {
    if (await this.isAccepted(args.tenantId, args.contractId)) return;
    await this.accept(args);
  }

  /**
   * Contratos de esas facturas del inquilino cuyo primer pago está pendiente y
   * que aún no tienen las condiciones aceptadas (contrato firmado en el local
   * sin la casilla, en papel o antes de que existiera). Las facturas de un
   * contrato que ya pagó alguna no las piden.
   */
  async contractsNeedingAcceptance(
    tenantId: string,
    customerId: string,
    invoiceIds: string[],
  ): Promise<string[]> {
    if (invoiceIds.length === 0) return [];
    const invoices = await this.admin.invoice.findMany({
      where: { tenantId, customerId, id: { in: invoiceIds }, contractId: { not: null } },
      select: { contractId: true },
    });
    const ids = [...new Set(invoices.map((i) => i.contractId!))];
    if (ids.length === 0) return [];
    const [accepted, paid] = await Promise.all([
      this.admin.legalDocAcceptance.findMany({
        where: { tenantId, contractId: { in: ids } },
        select: { contractId: true },
        distinct: ['contractId'],
      }),
      this.admin.invoice.findMany({
        where: { tenantId, contractId: { in: ids }, kind: 'invoice', status: 'paid' },
        select: { contractId: true },
        distinct: ['contractId'],
      }),
    ]);
    const done = new Set([...accepted, ...paid].map((r) => r.contractId));
    return ids.filter((id) => !done.has(id));
  }

  /** El contrato es del inquilino (404 si no) y su primer pago pide aceptarlas. */
  async contractNeedsAcceptance(
    tenantId: string,
    customerId: string,
    contractId: string,
  ): Promise<boolean> {
    const contract = await this.admin.contract.findFirst({
      where: { id: contractId, tenantId, customerId, deletedAt: null },
      select: { invoices: { select: { id: true } } },
    });
    if (!contract) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    const pending = await this.contractsNeedingAcceptance(
      tenantId,
      customerId,
      contract.invoices.map((i) => i.id),
    );
    return pending.includes(contractId);
  }

  /** 409 `general_terms_required` si alguna de esas facturas las pide antes de pagar. */
  async assertAcceptedForInvoices(
    tenantId: string,
    customerId: string,
    invoiceIds: string[],
  ): Promise<void> {
    const pending = await this.contractsNeedingAcceptance(tenantId, customerId, invoiceIds);
    if (pending.length > 0) {
      throw new ConflictException({
        code: 'general_terms_required',
        message: 'Debes aceptar las condiciones generales de contratación antes de pagar',
        details: { contractIds: pending },
      });
    }
  }

  /** La versión de este texto (por su huella) o una nueva con el siguiente número. */
  private async ensureVersion(
    tenantId: string,
    cur: { title: string; markdown: string; hash: string },
  ) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await this.admin.legalDocVersion.findUnique({
        where: {
          tenantId_doc_contentHash: { tenantId, doc: DOC, contentHash: cur.hash },
        },
      });
      if (existing) return existing;
      const last = await this.admin.legalDocVersion.aggregate({
        where: { tenantId, doc: DOC },
        _max: { version: true },
      });
      try {
        return await this.admin.legalDocVersion.create({
          data: {
            tenantId,
            doc: DOC,
            version: (last._max.version ?? 0) + 1,
            title: cur.title,
            content: cur.markdown,
            contentHash: cur.hash,
          },
        });
      } catch (err) {
        // Otra aceptación creó la versión (o el número) a la vez: se reintenta.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw new ConflictException({ code: 'general_terms_busy', message: 'Inténtalo de nuevo' });
  }

  async listForContract(tenantId: string, contractId: string): Promise<LegalDocAcceptanceDto[]> {
    const rows = await this.admin.legalDocAcceptance.findMany({
      where: { tenantId, contractId },
      include: { version: true },
      orderBy: { acceptedAt: 'desc' },
    });
    return rows.map(toAcceptanceDto);
  }

  async listVersions(tenantId: string): Promise<LegalDocVersionDto[]> {
    const [rows, cur] = await Promise.all([
      this.admin.legalDocVersion.findMany({
        where: { tenantId, doc: DOC },
        include: { _count: { select: { acceptances: true } } },
        orderBy: { version: 'desc' },
      }),
      this.current(tenantId),
    ]);
    return rows.map((r) => toVersionDto(r, r._count.acceptances, r.contentHash === cur.hash));
  }

  async getVersion(tenantId: string, id: string): Promise<LegalDocVersionDto> {
    const r = await this.admin.legalDocVersion.findFirst({
      where: { id, tenantId },
      include: { _count: { select: { acceptances: true } } },
    });
    if (!r) throw new NotFoundException({ code: 'version_not_found', message: 'No encontrada' });
    const cur = await this.current(tenantId);
    return toVersionDto(r, r._count.acceptances, r.contentHash === cur.hash);
  }
}

type VersionRow = Prisma.LegalDocVersionGetPayload<object>;

function toVersionDto(r: VersionRow, acceptances: number, current: boolean): LegalDocVersionDto {
  return {
    id: r.id,
    doc: r.doc,
    version: r.version,
    title: r.title,
    content: r.content,
    contentHash: r.contentHash,
    createdAt: r.createdAt.toISOString(),
    acceptances,
    current,
  };
}

function toAcceptanceDto(
  r: Prisma.LegalDocAcceptanceGetPayload<{ include: { version: true } }>,
): LegalDocAcceptanceDto {
  return {
    id: r.id,
    versionId: r.versionId,
    version: r.version.version,
    title: r.version.title,
    contentHash: r.version.contentHash,
    channel: r.channel,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    acceptedAt: r.acceptedAt.toISOString(),
  };
}
