import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { PortalService } from '../portal.service';

import type { Env } from '../../../config/env.schema';
import type { AuditService } from '../../auth/audit.service';
import type { ContractsService } from '../../contracts/contracts.service';
import type { PrismaAdminService } from '../../database/prisma-admin.service';
import type { EmailService } from '../../email/email.service';
import type { FilesService } from '../../files/files.service';
import type { GoCardlessMandatesService } from '../../payments/gocardless/gocardless-mandates.service';
import type { PaymentMethodsService } from '../../payments/payment-methods.service';
import type { PaymentsService } from '../../payments/payments.service';
import type { ProductSalesService } from '../../products/product-sales.service';
import type { ProductsService } from '../../products/products.service';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';

const TENANT = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const CUSTOMER = '019e3d20-bbbb-7c2f-bf37-6511065b9fc5';
const USER = '019e3d20-cccc-7c2f-bf37-6511065b9fc5';

const PORTAL_SECRET = 'portal-secret-0123456789-0123456789-0123456789';
const PENDING_2FA_SECRET = '2fa-pending-secret-0123456789-0123456789-012';

/** Redis falso: almacén en memoria con la semántica SET EX / GETDEL usada. */
function buildFakeRedis(): {
  store: Map<string, string>;
  set: jest.Mock;
  getdel: jest.Mock;
} {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    getdel: jest.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
  };
}

function buildAdmin(): {
  customer: { findFirst: jest.Mock; findUniqueOrThrow: jest.Mock };
  tenant: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
} {
  return {
    customer: {
      findFirst: jest.fn().mockResolvedValue({ id: CUSTOMER }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: CUSTOMER,
        customerType: 'individual',
        firstName: 'Puri',
        lastName: 'García',
        companyName: null,
        email: 'puri@e2e.local',
      }),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: TENANT, name: 'Trasteros', deletedAt: null }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: TENANT,
        name: 'Trasteros SL',
        slug: 'trasteros',
        portalBrandColor: null,
        portalLogoUrl: null,
      }),
    },
  };
}

function buildService(opts: { portalSecret?: string | undefined } = {}) {
  const redis = buildFakeRedis();
  const admin = buildAdmin();
  const audit = jest.fn().mockResolvedValue(undefined);
  const emailSend = jest.fn().mockResolvedValue(undefined);
  const configValues: Record<string, string | undefined> = {
    PORTAL_JWT_SECRET: opts.portalSecret,
    JWT_2FA_PENDING_SECRET: PENDING_2FA_SECRET,
    WEB_BASE_URL: 'https://app.example',
  };
  const config = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService<Env, true>;
  const jwt = new JwtService({});

  const service = new PortalService(
    admin as unknown as PrismaAdminService,
    { send: emailSend } as unknown as EmailService,
    jwt,
    config,
    {} as PaymentMethodsService,
    {} as PaymentsService,
    {} as GoCardlessMandatesService,
    {} as FilesService,
    {} as ContractsService,
    {} as ProductsService,
    {} as ProductSalesService,
    { write: audit } as unknown as AuditService,
    { client: Promise.resolve(redis) } as unknown as Queue,
  );
  return { service, redis, admin, audit, emailSend, jwt };
}

describe('PortalService', () => {
  // ======================= magic link generado por el staff ================

  it('createMagicLinkForCustomer genera URL, guarda single-use en Redis (TTL 7d) y audita', async () => {
    const { service, redis, audit } = buildService();

    const { url, expiresAt } = await service.createMagicLinkForCustomer(TENANT, CUSTOMER, USER, {
      ipAddress: '1.2.3.4',
      userAgent: 'jest',
    });

    expect(url).toMatch(/^https:\/\/app\.example\/portal\/consume\?token=[a-f0-9]{32}\.[\w-]+$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    // Guardado con TTL de 7 días (el staff lo reparte a mano).
    const [, , exFlag, ttl] = redis.set.mock.calls[0] as [string, string, string, number];
    expect(exFlag).toBe('EX');
    expect(ttl).toBe(7 * 24 * 60 * 60);
    // Audita el hecho SIN incluir el token/secreto.
    const entry = audit.mock.calls[0]![0];
    expect(entry.action).toBe('portal.magic_link_generated');
    expect(JSON.stringify(entry.changes)).not.toContain(url.split('token=')[1]);
  });

  it('createMagicLinkForCustomer con cliente inexistente da 404 y no guarda nada', async () => {
    const { service, redis, admin } = buildService();
    admin.customer.findFirst.mockResolvedValue(null);

    await expect(
      service.createMagicLinkForCustomer(TENANT, CUSTOMER, USER, {
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(redis.set).not.toHaveBeenCalled();
  });

  // ========================== consumo del magic link =======================

  it('consumeMagicLink hace el round-trip completo y es SINGLE-USE', async () => {
    const { service } = buildService({ portalSecret: PORTAL_SECRET });
    const { url } = await service.createMagicLinkForCustomer(TENANT, CUSTOMER, USER, {
      ipAddress: null,
      userAgent: null,
    });
    const token = url.split('token=')[1]!;

    const session = await service.consumeMagicLink(token);
    expect(session.customerId).toBe(CUSTOMER);
    expect(session.customerName).toBe('Puri García');
    expect(session.tenantSlug).toBe('trasteros');
    // El accessToken de la sesión es verificable por el propio service.
    const verified = await service.verifyPortalToken(session.accessToken);
    expect(verified).toEqual({ customerId: CUSTOMER, tenantId: TENANT });

    // Replay: el GETDEL ya se llevó la entrada → caducado.
    await expect(service.consumeMagicLink(token)).rejects.toMatchObject({
      response: { code: 'portal_token_expired' },
    });
  });

  it('consumeMagicLink rechaza formato inválido sin tocar Redis', async () => {
    const { service, redis } = buildService();
    await expect(service.consumeMagicLink('no-es-un-token!')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(redis.getdel).not.toHaveBeenCalled();
  });

  it('consumeMagicLink rechaza un secreto que no casa con el hash', async () => {
    const { service } = buildService();
    const { url } = await service.createMagicLinkForCustomer(TENANT, CUSTOMER, USER, {
      ipAddress: null,
      userAgent: null,
    });
    const tokenId = url.split('token=')[1]!.split('.')[0]!;

    await expect(
      service.consumeMagicLink(`${tokenId}.secreto-falso-inventado`),
    ).rejects.toMatchObject({ response: { code: 'portal_token_invalid' } });
  });

  // ==================== secret dedicado del portal (auditoría) =============

  it('con PORTAL_JWT_SECRET definido, un token firmado con el secret de 2FA NO vale', async () => {
    const { service, jwt } = buildService({ portalSecret: PORTAL_SECRET });
    // Un token con claims correctos pero firmado con el OTRO secret (la mezcla
    // de propósitos que la auditoría pedía separar).
    const forged = await jwt.signAsync(
      { customerId: CUSTOMER, tenantId: TENANT, purpose: 'portal' },
      { secret: PENDING_2FA_SECRET, expiresIn: 3600 },
    );
    await expect(service.verifyPortalToken(forged)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('sin PORTAL_JWT_SECRET cae al secret de 2FA pending (compatibilidad)', async () => {
    const { service, jwt } = buildService({ portalSecret: undefined });
    const legacy = await jwt.signAsync(
      { customerId: CUSTOMER, tenantId: TENANT, purpose: 'portal' },
      { secret: PENDING_2FA_SECRET, expiresIn: 3600 },
    );
    await expect(service.verifyPortalToken(legacy)).resolves.toEqual({
      customerId: CUSTOMER,
      tenantId: TENANT,
    });
  });

  it('verifyPortalToken rechaza purpose distinto y tokens expirados', async () => {
    const { service, jwt } = buildService({ portalSecret: PORTAL_SECRET });
    const wrongPurpose = await jwt.signAsync(
      { customerId: CUSTOMER, tenantId: TENANT, purpose: '2fa-pending' },
      { secret: PORTAL_SECRET, expiresIn: 3600 },
    );
    await expect(service.verifyPortalToken(wrongPurpose)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    const expired = await jwt.signAsync(
      { customerId: CUSTOMER, tenantId: TENANT, purpose: 'portal' },
      { secret: PORTAL_SECRET, expiresIn: -10 },
    );
    await expect(service.verifyPortalToken(expired)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // ===================== anti-enumeración del magic link ===================

  it('requestMagicLink es silencioso si el tenant o el email no existen (no filtra)', async () => {
    const { service, admin, emailSend, redis } = buildService();

    // Tenant inexistente.
    admin.tenant.findUnique.mockResolvedValue(null);
    await expect(
      service.requestMagicLink({ tenantSlug: 'ghost', email: 'x@y.z' }),
    ).resolves.toBeUndefined();

    // Tenant OK pero email sin customer.
    admin.tenant.findUnique.mockResolvedValue({ id: TENANT, name: 'T', deletedAt: null });
    admin.customer.findFirst.mockResolvedValue(null);
    await expect(
      service.requestMagicLink({ tenantSlug: 'trasteros', email: 'nadie@y.z' }),
    ).resolves.toBeUndefined();

    expect(emailSend).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
