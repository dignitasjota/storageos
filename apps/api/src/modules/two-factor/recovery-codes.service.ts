import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { PrismaAdminService } from '../database/prisma-admin.service';

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_CODE_BLOCK = 4;
const RECOVERY_CODE_BLOCKS = 2;

function generateSinglePlaintext(): string {
  const blocks: string[] = [];
  for (let b = 0; b < RECOVERY_CODE_BLOCKS; b++) {
    const buf = randomBytes(RECOVERY_CODE_BLOCK);
    let block = '';
    for (let i = 0; i < RECOVERY_CODE_BLOCK; i++) {
      block += RECOVERY_CODE_CHARS[buf[i]! % RECOVERY_CODE_CHARS.length];
    }
    blocks.push(block);
  }
  return blocks.join('-');
}

function normalize(code: string): string {
  return code.replace(/[\s-]+/g, '').toUpperCase();
}

/**
 * Codigos de recuperacion para 2FA. Se generan 10 al activar 2FA, se
 * devuelven en plaintext **una sola vez** y se persisten hashed con argon2id.
 *
 * Cada codigo es single-use: al consumirlo, marcamos `used_at` con un
 * `updateMany` que solo afecta filas con `used_at IS NULL` y el hash que
 * matcheo. La verificacion es lineal sobre los codigos no consumidos.
 */
@Injectable()
export class RecoveryCodesService {
  constructor(private readonly admin: PrismaAdminService) {}

  /**
   * Genera 10 codigos plaintext, persiste los hashes y elimina cualquier
   * codigo previo del user (regenerar invalida los anteriores). Devuelve
   * los plaintext para mostrar al user UNA VEZ.
   */
  async issueForUser(tenantId: string, userId: string): Promise<string[]> {
    const plaintexts: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const plain = generateSinglePlaintext();
      plaintexts.push(plain);
      const h = await argonHash(normalize(plain));
      hashes.push(h);
    }

    await this.admin.$transaction([
      this.admin.recoveryCode.deleteMany({ where: { userId } }),
      this.admin.recoveryCode.createMany({
        data: hashes.map((codeHash) => ({ tenantId, userId, codeHash })),
      }),
    ]);

    return plaintexts;
  }

  /** Borra todos los codigos del user (al desactivar 2FA). */
  async clearForUser(userId: string): Promise<void> {
    await this.admin.recoveryCode.deleteMany({ where: { userId } });
  }

  /**
   * Intenta consumir un codigo de recuperacion. Devuelve `true` si el codigo
   * existia, no estaba usado y se ha marcado como consumido en esta llamada.
   */
  async consume(userId: string, plaintext: string): Promise<boolean> {
    const normalized = normalize(plaintext);
    const candidates = await this.admin.recoveryCode.findMany({
      where: { userId, usedAt: null },
    });
    for (const candidate of candidates) {
      let matches = false;
      try {
        matches = await argonVerify(candidate.codeHash, normalized);
      } catch {
        matches = false;
      }
      if (!matches) continue;
      // Marca atomico: solo consume si seguimos no usados (otro request
      // concurrente podria ganar la carrera).
      const result = await this.admin.recoveryCode.updateMany({
        where: { id: candidate.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (result.count === 1) return true;
    }
    return false;
  }

  /** Conteo de codigos sin usar (para mostrar al user en /settings/security). */
  async remainingForUser(userId: string): Promise<number> {
    return this.admin.recoveryCode.count({ where: { userId, usedAt: null } });
  }
}
