import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { verify as argonVerify } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient } from '../src/prisma-client';

/**
 * Tests del CLI `seed-superadmin.ts`. Comprueban idempotencia y que la
 * flag `--reset-password` se respeta. Se ejecuta el script real via `tsx`
 * y verificamos los efectos en BD con Prisma admin.
 */

const SEED_PATH = resolve(__dirname, '..', 'prisma', 'seed-superadmin.ts');
const PKG_ROOT = resolve(__dirname, '..');
const TEST_EMAIL = 'seed-superadmin-test@storageos.local';

const prisma = createPrismaClient();

function runSeed(args: string[]): { stdout: string; stderr: string } {
  // tsx via package local: usamos `node` + `--import tsx` no esta disponible
  // en todas las versiones; mas robusto invocar el binario `tsx` del workspace.
  const tsxBin = resolve(PKG_ROOT, 'node_modules', '.bin', 'tsx');
  try {
    const stdout = execFileSync(tsxBin, [SEED_PATH, ...args], {
      cwd: PKG_ROOT,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message: string };
    throw new Error(
      `seed-superadmin fallo: ${e.message}\nstdout=${String(e.stdout ?? '')}\nstderr=${String(e.stderr ?? '')}`,
    );
  }
}

async function cleanup(): Promise<void> {
  await prisma.superAdmin.deleteMany({ where: { email: TEST_EMAIL } });
}

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('seed-superadmin CLI', () => {
  it('crea un super admin nuevo cuando no existe', async () => {
    runSeed(['--email', TEST_EMAIL, '--password', 'StrongPass!23', '--name', 'Seed Test']);
    const record = await prisma.superAdmin.findUnique({ where: { email: TEST_EMAIL } });
    expect(record).not.toBeNull();
    expect(record?.fullName).toBe('Seed Test');
    expect(record?.role).toBe('superadmin');
    const ok = await argonVerify(record!.passwordHash, 'StrongPass!23');
    expect(ok).toBe(true);
  });

  it('es idempotente: segunda ejecucion sin --reset-password no cambia el password', async () => {
    // Estado: creado en el test anterior con StrongPass!23.
    const before = await prisma.superAdmin.findUnique({ where: { email: TEST_EMAIL } });
    expect(before).not.toBeNull();
    const originalHash = before!.passwordHash;
    const originalId = before!.id;

    runSeed([
      '--email',
      TEST_EMAIL,
      '--password',
      'OtroPasswordDistinto!99',
      '--name',
      'Seed Test Renamed',
    ]);

    const after = await prisma.superAdmin.findUnique({ where: { email: TEST_EMAIL } });
    expect(after).not.toBeNull();
    // El id es el mismo (no se ha creado uno nuevo).
    expect(after?.id).toBe(originalId);
    // El password NO ha cambiado: sigue siendo el original.
    expect(after?.passwordHash).toBe(originalHash);
    const stillOriginal = await argonVerify(after!.passwordHash, 'StrongPass!23');
    expect(stillOriginal).toBe(true);
    // El fullName si se ha actualizado.
    expect(after?.fullName).toBe('Seed Test Renamed');
  });

  it('con --reset-password sustituye el password manteniendo el id', async () => {
    const before = await prisma.superAdmin.findUnique({ where: { email: TEST_EMAIL } });
    expect(before).not.toBeNull();
    const originalId = before!.id;

    runSeed(['--email', TEST_EMAIL, '--password', 'PasswordReseteado!42', '--reset-password']);

    const after = await prisma.superAdmin.findUnique({ where: { email: TEST_EMAIL } });
    expect(after?.id).toBe(originalId);
    const newOk = await argonVerify(after!.passwordHash, 'PasswordReseteado!42');
    expect(newOk).toBe(true);
    const oldOk = await argonVerify(after!.passwordHash, 'StrongPass!23');
    expect(oldOk).toBe(false);
  });

  it('respeta --role support', async () => {
    runSeed(['--email', TEST_EMAIL, '--password', 'PasswordReseteado!42', '--role', 'support']);
    const after = await prisma.superAdmin.findUnique({ where: { email: TEST_EMAIL } });
    expect(after?.role).toBe('support');
  });
});
