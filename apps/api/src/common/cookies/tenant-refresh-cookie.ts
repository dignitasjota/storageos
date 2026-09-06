import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie';

import type { Env } from '../../config/env.schema';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

/**
 * Cookie de refresh del TENANT (auth normal, no super admin) — compartida
 * literalmente igual por `AuthController`, `TwoFactorController` e
 * `InvitationsController` (los 3 flujos que pueden acabar en login: login
 * directo, challenge 2FA, aceptar invitación). Antes cada uno reimplementaba
 * `setRefreshCookie` a mano con el mismo cuerpo.
 */
export const TENANT_REFRESH_COOKIE_NAME = 'refresh_token';
// Path raiz: necesario para que el middleware del frontend (otro origen en
// dev: localhost:3000) pueda leer la presencia de la cookie y proteger las
// rutas autenticadas.
export const TENANT_REFRESH_COOKIE_PATH = '/';

export function setTenantRefreshCookie(
  res: Response,
  config: ConfigService<Env, true>,
  token: string,
): void {
  setRefreshCookie(res, token, {
    name: TENANT_REFRESH_COOKIE_NAME,
    path: TENANT_REFRESH_COOKIE_PATH,
    domain: config.get('COOKIE_DOMAIN', { infer: true }),
    secure: config.get('COOKIE_SECURE', { infer: true }),
    sameSite: config.get('COOKIE_SAMESITE', { infer: true }),
    maxAgeSeconds: config.get('JWT_REFRESH_TTL_SECONDS', { infer: true }),
  });
}

export function readTenantRefreshCookie(req: Request): string | undefined {
  return readRefreshCookie(req, TENANT_REFRESH_COOKIE_NAME);
}

export function clearTenantRefreshCookie(res: Response, config: ConfigService<Env, true>): void {
  clearRefreshCookie(res, {
    name: TENANT_REFRESH_COOKIE_NAME,
    path: TENANT_REFRESH_COOKIE_PATH,
    domain: config.get('COOKIE_DOMAIN', { infer: true }),
  });
}
