import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { EmailVerificationToken } from '@storageos/database';

const TOKEN_BYTES = 32;
const TTL_HOURS = 24;

export interface IssueArgs {
  tenantId: string;
  userId: string;
}

export interface IssuedToken {
  /** Token plaintext (`<id>.<secret>`) que va al email. */
  plaintext: string;
  record: EmailVerificationToken;
}

/**
 * CRUD de tokens de verificacion de email. Formato del plaintext igual que
 * en sessions: `<tokenId>.<secret>` para poder encontrar el registro sin
 * scan. Usa el cliente admin porque las verificaciones llegan sin tenant
 * context resuelto (el usuario aun no esta autenticado).
 */
@Injectable()
export class VerificationTokensService {
  constructor(private readonly admin: PrismaAdminService) {}

  async issue(args: IssueArgs): Promise<IssuedToken> {
    // Invalida tokens previos no usados del mismo user.
    await this.admin.emailVerificationToken.updateMany({
      where: { userId: args.userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    const secret = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = await argonHash(secret);
    const expiresAt = new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);

    const record = await this.admin.emailVerificationToken.create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId,
        tokenHash,
        expiresAt,
      },
    });

    return { plaintext: `${record.id}.${secret}`, record };
  }

  /**
   * Consume el token: lo localiza por id, verifica secret/expiracion, y lo
   * marca como usado. Devuelve el registro (o `null` si no es valido).
   * Idempotencia: si ya estaba usado, devuelve null.
   */
  async consume(plaintext: string): Promise<EmailVerificationToken | null> {
    const parsed = parseToken(plaintext);
    if (!parsed) return null;

    const record = await this.admin.emailVerificationToken.findUnique({
      where: { id: parsed.id },
    });
    if (!record) return null;
    if (record.usedAt !== null) return null;
    if (record.expiresAt.getTime() <= Date.now()) return null;

    const matches = await safeVerify(record.tokenHash, parsed.secret);
    if (!matches) return null;

    // Marcar como usado de forma atomica: si dos requests llegan a la vez,
    // updateMany con guard `usedAt: null` garantiza single-use.
    const result = await this.admin.emailVerificationToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (result.count === 0) return null;
    return record;
  }
}

export function parseToken(plaintext: string): { id: string; secret: string } | null {
  const idx = plaintext.indexOf('.');
  if (idx <= 0 || idx === plaintext.length - 1) return null;
  return { id: plaintext.slice(0, idx), secret: plaintext.slice(idx + 1) };
}

async function safeVerify(hash: string, secret: string): Promise<boolean> {
  try {
    return await argonVerify(hash, secret);
  } catch {
    return false;
  }
}
