import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { TokensService } from '../tokens.service';

import type { Env } from '../../../config/env.schema';

const TEST_SECRET = 'unit-test-secret-must-be-at-least-32-chars-long-abcdef';
const ACCESS_TTL = 60;

function createService(secret = TEST_SECRET, ttl = ACCESS_TTL): TokensService {
  const jwt = new JwtService({});
  const config = {
    get: (key: string) => {
      if (key === 'JWT_ACCESS_SECRET') return secret;
      if (key === 'JWT_ACCESS_TTL_SECONDS') return ttl;
      throw new Error(`Unexpected config key in test: ${key}`);
    },
  } as unknown as ConfigService<Env, true>;
  return new TokensService(jwt, config);
}

describe('TokensService', () => {
  describe('access JWT', () => {
    it('signAccess + verifyAccess round-trip devuelve los claims firmados', async () => {
      const svc = createService();
      const { token, expiresIn } = await svc.signAccess({
        sub: 'user-1',
        tenantId: 'tenant-1',
        role: 'owner',
      });
      expect(typeof token).toBe('string');
      expect(expiresIn).toBe(ACCESS_TTL);

      const decoded = await svc.verifyAccess(token);
      expect(decoded.sub).toBe('user-1');
      expect(decoded.tenantId).toBe('tenant-1');
      expect(decoded.role).toBe('owner');
      expect(decoded.exp).toBeGreaterThan(decoded.iat);
    });

    it('verifyAccess rechaza un token firmado con secret distinto', async () => {
      const a = createService('secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const b = createService('secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      const { token } = await a.signAccess({ sub: 'u', tenantId: 't', role: 'staff' });
      await expect(b.verifyAccess(token)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('verifyAccess rechaza un token expirado', async () => {
      const svc = createService(TEST_SECRET, -10);
      const { token } = await svc.signAccess({ sub: 'u', tenantId: 't', role: 'staff' });
      await expect(svc.verifyAccess(token)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('verifyAccess rechaza un token con formato invalido', async () => {
      const svc = createService();
      await expect(svc.verifyAccess('not-a-jwt')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('refresh token (opaco)', () => {
    it('generateRefreshSecret produce secret base64url y hash distintos', async () => {
      const svc = createService();
      const { secret, secretHash } = await svc.generateRefreshSecret();
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes -> 43 chars base64url sin padding.
      expect(secret.length).toBeGreaterThanOrEqual(40);
      expect(secretHash).not.toBe(secret);
      expect(secretHash.startsWith('$argon2id$')).toBe(true);
    });

    it('verifyRefreshSecret acepta el secret correcto y rechaza el incorrecto', async () => {
      const svc = createService();
      const { secret, secretHash } = await svc.generateRefreshSecret();
      expect(await svc.verifyRefreshSecret(secret, secretHash)).toBe(true);
      expect(await svc.verifyRefreshSecret('wrong-secret', secretHash)).toBe(false);
    });

    it('verifyRefreshSecret devuelve false ante un hash corrupto en vez de lanzar', async () => {
      const svc = createService();
      expect(await svc.verifyRefreshSecret('secret', 'not-a-hash')).toBe(false);
    });

    it('formatRefreshToken / parseRefreshToken son inversos', () => {
      const svc = createService();
      const tenantId = '019e3d20-aaaa-7c2f-bf37-6511065b9fc5';
      const sessionId = '019e3d20-bbbb-7c2f-bf37-6511065b9fc5';
      const secret = 'aBcD1234base64urltoken';
      const token = svc.formatRefreshToken(tenantId, sessionId, secret);
      expect(token).toBe(`${tenantId}.${sessionId}.${secret}`);

      const parsed = svc.parseRefreshToken(token);
      expect(parsed).not.toBeNull();
      expect(parsed?.tenantId).toBe(tenantId);
      expect(parsed?.sessionId).toBe(sessionId);
      expect(parsed?.secret).toBe(secret);
    });

    it('parseRefreshToken devuelve null ante formatos invalidos', () => {
      const svc = createService();
      expect(svc.parseRefreshToken('no-dots')).toBeNull();
      expect(svc.parseRefreshToken('only.one-dot')).toBeNull();
      expect(svc.parseRefreshToken('too.many.dots.here')).toBeNull();
      expect(svc.parseRefreshToken('.empty.prefix')).toBeNull();
      expect(svc.parseRefreshToken('empty..middle')).toBeNull();
      expect(svc.parseRefreshToken('trailing.empty.')).toBeNull();
      expect(svc.parseRefreshToken('')).toBeNull();
    });
  });
});
