import { env } from './env';

/** Dirección pública de la declaración responsable en trasteros.pro. */
export const DECLARATION_PATH = '/declaracion-responsable';

/** PDF de la declaración responsable (sin versión: la de la versión en uso). */
export function declarationPdfUrl(version?: string): string {
  const query = version ? `?version=${encodeURIComponent(version)}` : '';
  return `${env.apiUrl}/v1/public/verifactu/declaration/pdf${query}`;
}
