import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as forge from 'node-forge';

import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import type { TenantAeatCredential } from '@storageos/database';

export type AeatEnvironment = 'sandbox' | 'production';

/**
 * Metadatos publicos de la credencial (sin secretos). Lo que devuelven los
 * endpoints `/billing/aeat-credentials/me` y `POST .../aeat-credentials`.
 */
export type TenantAeatCredentialMetadata = Omit<
  TenantAeatCredential,
  'certP12Encrypted' | 'certPasswordEncrypted'
>;

interface UploadArgs {
  tenantId: string;
  userId: string;
  p12Buffer: Buffer;
  password: string;
  environment: AeatEnvironment;
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
   * NIF, cifra payload + password y hace upsert (UNIQUE por tenant_id).
   */
  async upload(args: UploadArgs): Promise<TenantAeatCredentialMetadata> {
    const { tenantId, userId, p12Buffer, password, environment } = args;

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
    const issuerCnField = cert.issuer.getField('CN');
    const issuer = (issuerCnField?.value as string | undefined) ?? 'UNKNOWN';

    // 6. Cifrar p12 (base64) y password.
    // CryptoService solo acepta strings; codificamos a base64 y al
    // descifrar volvemos a Buffer.
    const p12B64 = p12Buffer.toString('base64');
    const certP12Encrypted = Buffer.from(this.crypto.encryptString(p12B64), 'utf8');
    const certPasswordEncrypted = this.crypto.encryptString(password);

    // 7. Upsert por UNIQUE tenant_id. Si ya existe (revoked o no), la
    // reemplazamos: para esta fase mantenemos una sola fila activa.
    const record = await this.prisma.withTenant(
      (tx) =>
        tx.tenantAeatCredential.upsert({
          where: { tenantId },
          create: {
            tenantId,
            certP12Encrypted,
            certPasswordEncrypted,
            certCommonName: commonName,
            certNif: nif,
            certIssuer: issuer,
            certValidFrom: validFrom,
            certValidTo: validTo,
            environment,
            uploadedById: userId,
          },
          update: {
            certP12Encrypted,
            certPasswordEncrypted,
            certCommonName: commonName,
            certNif: nif,
            certIssuer: issuer,
            certValidFrom: validFrom,
            certValidTo: validTo,
            environment,
            uploadedById: userId,
            uploadedAt: new Date(),
            // Limpia revocacion previa si la hubo (el upload reemplaza).
            revokedAt: null,
            revokedReason: null,
          },
        }),
      tenantId,
    );

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
      },
    });

    return this.toMetadata(record);
  }

  /**
   * Desencripta la credencial activa del tenant (sin `revokedAt`). Uso
   * interno del cliente AEAT al firmar/enviar; nunca se expone por HTTP.
   */
  async getDecrypted(tenantId: string): Promise<DecryptedCredential | null> {
    const record = await this.prisma.withTenant(
      (tx) =>
        tx.tenantAeatCredential.findFirst({
          where: { tenantId, revokedAt: null },
        }),
      tenantId,
    );
    if (!record) return null;

    const p12B64 = this.crypto.decryptString(Buffer.from(record.certP12Encrypted).toString('utf8'));
    const p12Buffer = Buffer.from(p12B64, 'base64');
    const password = this.crypto.decryptString(record.certPasswordEncrypted);

    return { p12Buffer, password, record };
  }

  /** Metadatos publicos para UI. Devuelve null si no hay credencial activa. */
  async getMetadata(tenantId: string): Promise<TenantAeatCredentialMetadata | null> {
    const record = await this.prisma.withTenant(
      (tx) =>
        tx.tenantAeatCredential.findFirst({
          where: { tenantId, revokedAt: null },
        }),
      tenantId,
    );
    if (!record) return null;
    return this.toMetadata(record);
  }

  /** Marca como revocada la credencial activa. Idempotente: si no hay, devuelve false. */
  async revoke(tenantId: string, userId: string, reason: string): Promise<boolean> {
    const record = await this.prisma.withTenant(
      (tx) =>
        tx.tenantAeatCredential.findFirst({
          where: { tenantId, revokedAt: null },
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

  private toMetadata(record: TenantAeatCredential): TenantAeatCredentialMetadata {
    // Stripping de los campos sensibles.
    const { certP12Encrypted: _p12, certPasswordEncrypted: _pw, ...rest } = record;
    return rest;
  }
}
