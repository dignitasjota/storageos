import { afterAll, describe, expect, it } from 'vitest';

import { createPrismaClient } from '../src/prisma-client';

const prisma = createPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function v7(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT uuid_generate_v7()::text AS id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('uuid_generate_v7 devolvio fila vacia');
  return id;
}

describe('uuid_generate_v7()', () => {
  it('genera un UUID con version 7 y variant RFC4122', async () => {
    const id = await v7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('produce UUIDs estrictamente crecientes entre milisegundos distintos', async () => {
    // UUID v7 garantiza orden cronologico entre llamadas en milisegundos
    // diferentes. Dentro del mismo ms, los 74 bits aleatorios pueden romper
    // el orden -- eso es spec-conforme. Validamos solo lo primero.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await v7());
      await sleep(5);
    }
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('el prefijo de timestamp (12 hex) es no decreciente en una rafaga', async () => {
    // En una unica query con generate_series, todos los UUIDs comparten o
    // casi-comparten el ms; el prefijo de timestamp debe ser no decreciente.
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT uuid_generate_v7()::text AS id
      FROM generate_series(1, 50)
    `;
    const prefixes = rows.map((r) => r.id.replace(/-/g, '').slice(0, 12));
    for (let i = 1; i < prefixes.length; i++) {
      const prev = prefixes[i - 1] ?? '';
      const curr = prefixes[i] ?? '';
      expect(curr >= prev).toBe(true);
    }
  });
});
