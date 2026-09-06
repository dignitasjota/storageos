import type { Request, Response } from 'express';

/**
 * Mecánica compartida de la cookie de refresh (auth de tenant y de super
 * admin usan la MISMA forma — httpOnly + secure/sameSite/domain/path/maxAge
 * configurables — pero con nombre, path y política sameSite propios). Antes
 * cada uno de los 4 controllers (`AuthController`, `TwoFactorController`,
 * `InvitationsController`, `SuperAdminAuthController`) reimplementaba
 * `setRefreshCookie`/`readRefreshCookie`/`clearRefreshCookie` a mano; esto
 * centraliza el `res.cookie(...)`/`res.clearCookie(...)` para que un cambio
 * de mecánica (p. ej. un atributo nuevo) no haya que repetirlo 4 veces.
 */
export interface RefreshCookieOptions {
  name: string;
  path: string;
  domain?: string | undefined;
  secure: boolean;
  sameSite: boolean | 'lax' | 'strict' | 'none';
  maxAgeSeconds: number;
}

export function setRefreshCookie(res: Response, token: string, opts: RefreshCookieOptions): void {
  res.cookie(opts.name, token, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: opts.sameSite,
    domain: opts.domain,
    path: opts.path,
    maxAge: opts.maxAgeSeconds * 1000,
  });
}

export function readRefreshCookie(req: Request, name: string): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[name];
}

export function clearRefreshCookie(
  res: Response,
  opts: Pick<RefreshCookieOptions, 'name' | 'path' | 'domain'>,
): void {
  res.clearCookie(opts.name, { domain: opts.domain, path: opts.path });
}
