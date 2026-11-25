import { SEO_PERIODS } from '@storageos/shared';

/** Periodo del resumen: 7, 28 o 90 días (28 por defecto). */
export function parseSeoDays(value: string | undefined): number {
  const n = Number(value);
  return (SEO_PERIODS as readonly number[]).includes(n) ? n : 28;
}
