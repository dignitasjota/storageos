import request from 'supertest';

import type { INestApplication } from '@nestjs/common';

/**
 * Huella de las Condiciones Generales de Contratación vigentes para un enlace
 * de firma: hay que enviarla al firmar (la casilla obligatoria antes de pagar).
 */
export async function generalTermsHash(app: INestApplication, token: string): Promise<string> {
  const res = await request(app.getHttpServer()).get(`/public/move-in/sign/${token}`);
  return res.body.generalTerms.hash as string;
}
