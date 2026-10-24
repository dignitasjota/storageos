import type { Request } from 'express';

/**
 * ¿La petición viene de la app instalada en el móvil? La web lo indica con la
 * cabecera `X-App-Mode: installed` (solo cuando corre como app de pantalla de
 * inicio). Sirve para dar una sesión larga: no es un control de seguridad (es
 * como «mantener la sesión iniciada»).
 */
export function isInstalledAppRequest(req: Request): boolean {
  return (req.header('x-app-mode') ?? '').toLowerCase() === 'installed';
}
