import request from 'supertest';

import { extractToken, waitForEmail } from './mailpit';
import { uniqueTestIds } from './tenant-fixtures';

import type { INestApplication } from '@nestjs/common';

export interface VerifiedUser {
  slug: string;
  email: string;
  password: string;
  userId: string;
  tenantId: string;
  accessToken: string;
  refreshCookie: string;
}

/**
 * Helper para los tests e2e que necesitan un usuario ya verificado: hace
 * `register` + lee el email de verificacion de Mailpit + lo consume. Tras
 * la verificacion, la respuesta del API trae access token y cookie refresh.
 */
export async function registerVerifiedUser(
  app: INestApplication,
  prefix: string,
  overrides: Partial<{ password: string; tenantName: string; fullName: string }> = {},
): Promise<VerifiedUser> {
  const ids = uniqueTestIds(prefix);
  const password = overrides.password ?? 'Secret123';

  const reg = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      tenantName: overrides.tenantName ?? `Test ${prefix}`,
      tenantSlug: ids.slug,
      fullName: overrides.fullName ?? 'Test User',
      email: ids.email,
      password,
      acceptTerms: true,
    });
  if (reg.status !== 201) {
    throw new Error(`register fallo con HTTP ${reg.status}: ${JSON.stringify(reg.body)}`);
  }

  const mail = await waitForEmail(ids.email, { subjectIncludes: 'Verifica' });
  const token = extractToken(mail.Text, '/verify-email');

  const verified = await request(app.getHttpServer()).post('/auth/verify-email').send({ token });
  if (verified.status !== 200) {
    throw new Error(`verify-email fallo con HTTP ${verified.status}`);
  }

  const setCookie = verified.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookie = cookies.find((c) => c?.startsWith('refresh_token=')) ?? '';

  return {
    slug: ids.slug,
    email: ids.email,
    password,
    userId: verified.body.user.id as string,
    tenantId: verified.body.tenant.id as string,
    accessToken: verified.body.accessToken as string,
    refreshCookie: cookie,
  };
}
