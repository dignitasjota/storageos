import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as forge from 'node-forge';

import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import {
  type AeatRepresentative,
  nifFromCertValue,
  resolveRepresentative,
} from './aeat-client/representative';

import type { TenantAeatCredential } from '@storageos/database';

export type AeatEnvironment = 'sandbox' | 'production';

/**
 * Metadatos publicos de la credencial (sin secretos). Lo que devuelven los
 * endpoints `/billing/aeat-credentials/me` y `POST .../aeat-credentials`.
 */
export type TenantAeatCredentialMetadata = Omit<
  TenantAeatCredential,
  'certP12Encrypted' | 'certPasswordEncrypted'
> & {
  /** Con quién se firman los envíos si el certificado no es del tenant. */
  representative: AeatRepresentative | null;
};

interface UploadArgs {
  tenantId: string;
  userId: string;
  p12Buffer: Buffer;
  password: string;
  environment: AeatEnvironment;
  /** Certificado de un propietario (plan Administrador); sin indicar, del tenant. */
  ownerId?: string | null;
}

interface DecryptedCredential {
  p12Buffer: Buffer;
  password: string;
  record: TenantAeatCredential;
}

/**
 * Extrae el NIF del subject del certificado X.509. La FNMT usa
 * `SERIALNUMBER=IDCES-12345678X` u OID `2.5.4.5` (serialNumber) y a veces
 * `2.5.4.97` (organizationIdentifier) para empresas. Probamos los campos
 * comunes y aplicamos regex sobre el valor para extraer el documento.
 *
 * Acepta:
 *   - DNI: 8 digitos + letra (12345678X)
 *   - NIE: letra inicial + 7 digitos + letra (X1234567L)
 *   - CIF: letra inicial + 8 digitos (A12345678) o letra + 7 + control
 */
function extractNifFromSubject(cert: forge.pki.Certificate): string | null {
  const candidates: Array<string | null | undefined> = [];

  // node-forge expone `cert.subject.attributes` con shape { name, shortName,
  // type (OID), value }. Buscamos por OID para evitar inconsistencias entre
  // shortName/name en distintas CAs.
  // OIDs:
  //   2.5.4.5  serialNumber (FNMT lo usa con prefijo IDCES-)
  //   2.5.4.97 organizationIdentifier (CIF en empresa)
  //   2.5.4.3  commonName (a veces lleva el NIF embebido en certs FNMT)
  const attrs = (
    cert.subject as unknown as {
      attributes: Array<{ type?: string; name?: string; shortName?: string; value?: unknown }>;
    }
  ).attributes;
  const TARGET_OIDS = new Set(['2.5.4.5', '2.5.4.97', '2.5.4.3']);
  for (const attr of attrs ?? []) {
    if (attr.type && TARGET_OIDS.has(attr.type) && typeof attr.value === 'string') {
      candidates.push(attr.value);
    }
  }

  // Doble cinturon: por shortName/name (algunos certs no exponen `type`).
  for (const fieldName of ['serialName', 'serialNumber', 'organizationIdentifier', 'CN']) {
    const f = cert.subject.getField(fieldName);
    if (f && typeof f.value === 'string') candidates.push(f.value);
  }

  // Acepta DNI (8d+letra), NIE (X/Y/Z + 7d + letra) o CIF (letra + 8d / letra + 7d + letra).
  const nifRegex = /([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z]|[A-Z]\d{8})/i;
  for (const raw of candidates) {
    if (!raw) continue;
    const match = raw.match(nifRegex);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

/** Valor de un atributo del subject por OID (o null). */
function subjectValue(cert: forge.pki.Certificate, oid: string): string | null {
  const attrs = (
    cert.subject as unknown as { attributes: Array<{ type?: string; value?: unknown }> }
  ).attributes;
  const found = (attrs ?? []).find((a) => a.type === oid && typeof a.value === 'string');
  return (found?.value as string | undefined) ?? null;
}

@Injectable()
export class TenantAeatCredentialsService {
  private readonly logger = new Logger(TenantAeatCredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sube y persiste un PKCS#12. Parsea con node-forge, valida vigencia y
   * NIF, cifra payload + password e inserta una fila nueva. Si ya había
   * una credencial activa, la revoca dentro de la misma transacción para
   * conservar trazabilidad de la rotación (Fase 11A.2).
   */
  async upload(args: UploadArgs): Promise<TenantAeatCredentialMetadata> {
    const { tenantId, userId, p12Buffer, password, environment } = args;
    const ownerId = args.ownerId ?? null;

    // 1. Parsear PKCS#12.
    let p12: forge.pkcs12.Pkcs12Pfx;
    try {
      const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
      p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
    } catch (err) {
      this.logger.warn(
        `Fallo al parsear PKCS#12 para tenant ${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException({
        code: 'invalid_certificate_password',
        message: 'Password incorrecto o PKCS#12 invalido.',
      });
    }

    // 2. Extraer primer certificado y clave privada.
    let cert: forge.pki.Certificate | null = null;
    let hasPrivateKey = false;
    for (const safeContent of p12.safeContents) {
      for (const safeBag of safeContent.safeBags) {
        if (safeBag.type === forge.pki.oids.certBag && safeBag.cert && !cert) {
          cert = safeBag.cert;
        }
        if (
          (safeBag.type === forge.pki.oids.keyBag ||
            safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag) &&
          safeBag.key
        ) {
          hasPrivateKey = true;
        }
      }
    }
    if (!cert) {
      throw new BadRequestException({
        code: 'certificate_missing',
        message: 'El PKCS#12 no contiene certificado X.509.',
      });
    }
    if (!hasPrivateKey) {
      throw new BadRequestException({
        code: 'certificate_missing_private_key',
        message: 'El PKCS#12 no contiene clave privada.',
      });
    }

    // 3. Vigencia.
    const validFrom = cert.validity.notBefore;
    const validTo = cert.validity.notAfter;
    if (validTo.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'certificate_expired',
        message: 'El certificado ha expirado.',
      });
    }

    // 4. NIF.
    const nif = extractNifFromSubject(cert);
    if (!nif) {
      throw new BadRequestException({
        code: 'certificate_missing_nif',
        message: 'No se ha podido extraer un NIF/CIF del subject del certificado.',
      });
    }

    // 5. CommonName e Issuer.
    const cnField = cert.subject.getField('CN');
    const commonName = (cnField?.value as string | undefined) ?? 'UNKNOWN';
    // Entidad del certificado (certificado de representante de una empresa):
    // si es otra (una gestoría), los envíos irán con <Representante>.
    const organizationNif = nifFromCertValue(subjectValue(cert, '2.5.4.97'));
    const organizationName = subjectValue(cert, '2.5.4.10');
    const issuerCnField = cert.issuer.getField('CN');
    const issuer = (issuerCnField?.value as string | undefined) ?? 'UNKNOWN';

    // 6. Cifrar p12 (base64) y password.
    // CryptoService solo acepta strings; codificamos a base64 y al
    // descifrar volvemos a Buffer.
    const p12B64 = p12Buffer.toString('base64');
    const certP12Encrypted = Buffer.from(this.crypto.encryptString(p12B64, tenantId), 'utf8');
    const certPasswordEncrypted = this.crypto.encryptString(password, tenantId);

    // 7. Inserta una fila nueva. Si había una credencial activa, se
    // revoca primero (`replaced_by_new_upload`) dentro de la misma
    // transacción de `withTenant`. Así conservamos el histórico.
    const record = await this.prisma.withTenant(async (tx) => {
      await tx.tenantAeatCredential.updateMany({
        where: { tenantId, ownerId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedReason: 'replaced_by_new_upload',
        },
      });
      return tx.tenantAeatCredential.create({
        data: {
          tenantId,
          ownerId,
          certP12Encrypted,
          certPasswordEncrypted,
          certCommonName: commonName,
          certNif: nif,
          certOrganizationNif: organizationNif,
          representativeName: organizationNif && organizationName ? organizationName : null,
          certIssuer: issuer,
          certValidFrom: validFrom,
          certValidTo: validTo,
          environment,
          uploadedById: userId,
        },
      });
    }, tenantId);

    await this.audit.write({
      tenantId,
      userId,
      action: 'billing.aeat_credential.uploaded',
      entityType: 'tenant_aeat_credential',
      entityId: record.id,
      changes: {
        environment,
        certCommonName: commonName,
        certNif: nif,
        certIssuer: issuer,
        certValidTo: validTo.toISOString(),
        ...(ownerId ? { ownerId } : {}),
      },
    });

    return this.toMetadata(record, await this.issuerTaxId(tenantId, ownerId));
  }

  /**
   * Desencripta la credencial activa del tenant (sin `revokedAt`). Uso
   * interno del cliente AEAT al firmar/enviar; nunca se expone por HTTP.
   */
  async getDecrypted(
    tenantId: string,
    ownerId: string | null = null,
  ): Promise<DecryptedCredential | null> {
    // El del propietario si lo subió; si no, el del tenant (que envía como
    // su representante).
    const record = await this.prisma.withTenant(
      async (tx) =>
        (ownerId
          ? await tx.tenantAeatCredential.findFirst({
              // Si el del propietario ha caducado se envía con el del tenant
              // (como al emitir, que da por bueno cualquiera de los dos).
              where: { tenantId, ownerId, revokedAt: null, certValidTo: { gt: new Date() } },
              orderBy: { uploadedAt: 'desc' },
            })
          : null) ??
        tx.tenantAeatCredential.findFirst({
          where: { tenantId, ownerId: null, revokedAt: null },
          orderBy: { uploadedAt: 'desc' },
        }),
      tenantId,
    );
    if (!record) return null;

    const p12B64 = this.crypto.decryptString(
      Buffer.from(record.certP12Encrypted).toString('utf8'),
      tenantId,
    );
    const p12Buffer = Buffer.from(p12B64, 'base64');
    const password = this.crypto.decryptString(record.certPasswordEncrypted, tenantId);

    return { p12Buffer, password, record };
  }

  /** Metadatos publicos para UI. Devuelve null si no hay credencial activa. */
  async getMetadata(
    tenantId: string,
    ownerId: string | null = null,
  ): Promise<TenantAeatCredentialMetadata | null> {
    const record = await this.prisma.withTenant(
      (tx) =>
        tx.tenantAeatCredential.findFirst({
          where: { tenantId, ownerId, revokedAt: null },
          orderBy: { uploadedAt: 'desc' },
        }),
      tenantId,
    );
    if (!record) return null;
    return this.toMetadata(record, await this.issuerTaxId(tenantId, ownerId));
  }

  /**
   * Histórico completo de credenciales del tenant (activas + revocadas),
   * ordenado por `uploadedAt` desc. Devuelve metadatos sin secretos.
   */
  async listHistory(tenantId: string): Promise<TenantAeatCredentialMetadata[]> {
    const records = await this.prisma.withTenant(
      (tx) =>
        tx.tenantAeatCredential.findMany({
          where: { tenantId, ownerId: null },
          orderBy: { uploadedAt: 'desc' },
        }),
      tenantId,
    );
    const taxId = await this.tenantTaxId(tenantId);
    return records.map((r) => this.toMetadata(r, taxId));
  }

  /** Marca como revocada la credencial activa. Idempotente: si no hay, devuelve false. */
  async revoke(
    tenantId: string,
    userId: string,
    reason: string,
    ownerId: string | null = null,
  ): Promise<boolean> {
    const record = await this.prisma.withTenant(
      (tx) =>
        tx.tenantAeatCredential.findFirst({
          where: { tenantId, ownerId, revokedAt: null },
          orderBy: { uploadedAt: 'desc' },
        }),
      tenantId,
    );
    if (!record) return false;
    await this.prisma.withTenant(
      (tx) =>
        tx.tenantAeatCredential.update({
          where: { id: record.id },
          data: { revokedAt: new Date(), revokedReason: reason },
        }),
      tenantId,
    );
    await this.audit.write({
      tenantId,
      userId,
      action: 'billing.aeat_credential.revoked',
      entityType: 'tenant_aeat_credential',
      entityId: record.id,
      changes: { reason },
    });
    return true;
  }

  /**
   * Nombre del representante (cuando el certificado no es del tenant). Vacío =
   * se deduce del certificado.
   */
  async setRepresentativeName(args: {
    tenantId: string;
    userId: string;
    name: string | null;
  }): Promise<TenantAeatCredentialMetadata> {
    const record = await this.prisma.withTenant(async (tx) => {
      const active = await tx.tenantAeatCredential.findFirst({
        where: { tenantId: args.tenantId, ownerId: null, revokedAt: null },
        orderBy: { uploadedAt: 'desc' },
      });
      if (!active) {
        throw new NotFoundException({
          code: 'no_active_credential',
          message: 'No hay un certificado activo',
        });
      }
      return tx.tenantAeatCredential.update({
        where: { id: active.id },
        data: { representativeName: args.name?.trim() || null },
      });
    }, args.tenantId);
    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'billing.aeat_credential.representative_changed',
      entityType: 'tenant_aeat_credential',
      entityId: record.id,
      changes: { representativeName: record.representativeName },
    });
    return this.toMetadata(record, await this.tenantTaxId(args.tenantId));
  }

  /** NIF del obligado del certificado: el propietario o el tenant. */
  private async issuerTaxId(tenantId: string, ownerId: string | null): Promise<string | null> {
    if (!ownerId) return this.tenantTaxId(tenantId);
    const owner = await this.prisma.withTenant(
      (tx) => tx.owner.findUnique({ where: { id: ownerId }, select: { taxId: true } }),
      tenantId,
    );
    return owner?.taxId ?? null;
  }

  private async tenantTaxId(tenantId: string): Promise<string | null> {
    const tenant = await this.prisma.withTenant(
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { taxId: true } }),
      tenantId,
    );
    return tenant?.taxId ?? null;
  }

  private toMetadata(
    record: TenantAeatCredential,
    tenantTaxId: string | null,
  ): TenantAeatCredentialMetadata {
    // Stripping de los campos sensibles.
    const { certP12Encrypted: _p12, certPasswordEncrypted: _pw, ...rest } = record;
    return { ...rest, representative: resolveRepresentative(tenantTaxId, record) };
  }
}
