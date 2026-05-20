import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { SessionsService } from '../sessions.service';
import { TokensService } from '../tokens.service';

import type { Env } from '../../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import type { SecurityEventsService } from '../../security-events/security-events.service';
import type { Session } from '@storageos/database';

const TEST_JWT_SECRET = 'session-unit-test-secret-xxxxxxxxxxxxxxxxxxxxxx';
const REFRESH_TTL = 60;
const TENANT_A = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
const TENANT_B = '019e3d20-bbbb-7c2f-bf37-6511065b9fc5';
const USER_ID = '019e3d20-cccc-7c2f-bf37-6511065b9fc5';
const SESSION_ID = '019e3d20-dddd-7c2f-bf37-6511065b9fc5';

function buildConfig() {
  return {
    get: (key: string) => {
      if (key === 'JWT_ACCESS_SECRET') return TEST_JWT_SECRET;
      if (key === 'JWT_ACCESS_TTL_SECONDS') return 60;
      if (key === 'JWT_REFRESH_TTL_SECONDS') return REFRESH_TTL;
      throw new Error(`Unexpected config key: ${key}`);
    },
  } as unknown as ConfigService<Env, true>;
}

interface TxMock {
  session: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
}

function buildPrismaMock(tx: TxMock) {
  return {
    withTenant: jest
      .fn()
      .mockImplementation(async (fn: (tx: TxMock) => unknown, _tenantId: string) => fn(tx)),
  } as unknown as PrismaService;
}

function buildTx(): TxMock {
  return {
    session: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

function buildSession(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  return {
    id: SESSION_ID,
    tenantId: TENANT_A,
    userId: USER_ID,
    refreshTokenHash: 'placeholder-hash',
    userAgent: null,
    ipAddress: null,
    expiresAt: new Date(now.getTime() + REFRESH_TTL * 1000),
    lastUsedAt: now,
    revokedAt: null,
    revokedReason: null,
    rotatedFromId: null,
    createdAt: now,
    ...overrides,
  };
}

describe('SessionsService', () => {
  let tokens: TokensService;
  let tx: TxMock;
  let prisma: PrismaService;
  let securityEvents: SecurityEventsService;
  let svc: SessionsService;

  beforeEach(() => {
    tokens = new TokensService(new JwtService({}), buildConfig());
    tx = buildTx();
    prisma = buildPrismaMock(tx);
    securityEvents = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as SecurityEventsService;
    svc = new SessionsService(prisma, tokens, buildConfig(), securityEvents);
  });

  describe('createForLogin', () => {
    it('crea una sesion y devuelve el refresh con formato tenantId.sessionId.secret', async () => {
      tx.session.create.mockImplementation(async ({ data }) =>
        buildSession({
          tenantId: data.tenantId,
          userId: data.userId,
          refreshTokenHash: data.refreshTokenHash,
        }),
      );

      const result = await svc.createForLogin({
        tenantId: TENANT_A,
        userId: USER_ID,
        userAgent: 'jest',
        ipAddress: '127.0.0.1',
      });

      expect(tx.session.create).toHaveBeenCalledTimes(1);
      const createArgs = tx.session.create.mock.calls[0][0].data;
      expect(createArgs.tenantId).toBe(TENANT_A);
      expect(createArgs.userId).toBe(USER_ID);
      expect(createArgs.userAgent).toBe('jest');
      expect(createArgs.ipAddress).toBe('127.0.0.1');
      expect(typeof createArgs.refreshTokenHash).toBe('string');
      expect(createArgs.refreshTokenHash.startsWith('$argon2id$')).toBe(true);

      const parts = result.refreshToken.split('.');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe(TENANT_A);
      expect(parts[1]).toBe(SESSION_ID);
      expect(parts[2]?.length).toBeGreaterThan(40);
    });
  });

  describe('rotate', () => {
    it('rota correctamente: revoca la actual y crea otra con rotatedFromId', async () => {
      const { secret, secretHash } = await tokens.generateRefreshSecret();
      const session = buildSession({ refreshTokenHash: secretHash });
      tx.session.findUnique.mockResolvedValue(session);
      tx.session.update.mockResolvedValue({ ...session, revokedAt: new Date() });
      tx.session.create.mockImplementation(async ({ data }) =>
        buildSession({
          id: '019e3d20-eeee-7c2f-bf37-6511065b9fc5',
          refreshTokenHash: data.refreshTokenHash,
          rotatedFromId: data.rotatedFromId ?? null,
        }),
      );

      const refreshToken = tokens.formatRefreshToken(TENANT_A, SESSION_ID, secret);
      const result = await svc.rotate({ refreshToken });

      expect(tx.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SESSION_ID },
          data: expect.objectContaining({ revokedReason: 'rotated' }),
        }),
      );
      expect(tx.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ rotatedFromId: SESSION_ID, userId: USER_ID }),
        }),
      );
      expect(result.userId).toBe(USER_ID);
      expect(result.tenantId).toBe(TENANT_A);
      expect(result.refreshToken.split('.')).toHaveLength(3);
    });

    it('rechaza un refresh con secret incorrecto sin revocar nada', async () => {
      const { secretHash } = await tokens.generateRefreshSecret();
      const session = buildSession({ refreshTokenHash: secretHash });
      tx.session.findUnique.mockResolvedValue(session);

      const refreshToken = tokens.formatRefreshToken(TENANT_A, SESSION_ID, 'wrong-secret');
      await expect(svc.rotate({ refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tx.session.updateMany).not.toHaveBeenCalled();
      expect(tx.session.update).not.toHaveBeenCalled();
      expect(tx.session.create).not.toHaveBeenCalled();
    });

    it('revoca TODAS las sesiones del user si el refresh es de una sesion ya revocada (paranoid)', async () => {
      const { secret, secretHash } = await tokens.generateRefreshSecret();
      const session = buildSession({
        refreshTokenHash: secretHash,
        revokedAt: new Date(Date.now() - 1000),
        revokedReason: 'rotated',
      });
      tx.session.findUnique.mockResolvedValue(session);
      tx.session.updateMany.mockResolvedValue({ count: 3 });

      const refreshToken = tokens.formatRefreshToken(TENANT_A, SESSION_ID, secret);
      await expect(svc.rotate({ refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tx.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, revokedAt: null },
          data: expect.objectContaining({ revokedReason: 'refresh_reuse' }),
        }),
      );
      expect(tx.session.create).not.toHaveBeenCalled();
    });

    it('revoca TODAS si la sesion esta expirada', async () => {
      const { secret, secretHash } = await tokens.generateRefreshSecret();
      const session = buildSession({
        refreshTokenHash: secretHash,
        expiresAt: new Date(Date.now() - 60_000),
      });
      tx.session.findUnique.mockResolvedValue(session);
      tx.session.updateMany.mockResolvedValue({ count: 2 });

      const refreshToken = tokens.formatRefreshToken(TENANT_A, SESSION_ID, secret);
      await expect(svc.rotate({ refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tx.session.updateMany).toHaveBeenCalled();
    });

    it('rechaza si la sesion existe pero pertenece a otro tenant', async () => {
      const { secret, secretHash } = await tokens.generateRefreshSecret();
      const session = buildSession({ refreshTokenHash: secretHash, tenantId: TENANT_B });
      tx.session.findUnique.mockResolvedValue(session);

      const refreshToken = tokens.formatRefreshToken(TENANT_A, SESSION_ID, secret);
      await expect(svc.rotate({ refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tx.session.update).not.toHaveBeenCalled();
    });

    it('rechaza si el formato del refresh es invalido', async () => {
      await expect(svc.rotate({ refreshToken: 'no-dots' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(tx.session.findUnique).not.toHaveBeenCalled();
    });

    it('rechaza si la sesion no existe', async () => {
      tx.session.findUnique.mockResolvedValue(null);
      const refreshToken = tokens.formatRefreshToken(TENANT_A, SESSION_ID, 'doesnt-matter');
      await expect(svc.rotate({ refreshToken })).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('revoke', () => {
    it('marca la sesion solo si esta activa (revokedAt=null)', async () => {
      tx.session.updateMany.mockResolvedValue({ count: 1 });
      await svc.revoke({ tenantId: TENANT_A, sessionId: SESSION_ID });
      expect(tx.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SESSION_ID, revokedAt: null },
          data: expect.objectContaining({ revokedReason: 'logout' }),
        }),
      );
    });
  });

  describe('revokeAllForUser', () => {
    it('devuelve el numero de sesiones revocadas', async () => {
      tx.session.updateMany.mockResolvedValue({ count: 4 });
      const count = await svc.revokeAllForUser({ tenantId: TENANT_A, userId: USER_ID });
      expect(count).toBe(4);
      expect(tx.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER_ID, revokedAt: null },
          data: expect.objectContaining({ revokedReason: 'logout_all' }),
        }),
      );
    });
  });
});
