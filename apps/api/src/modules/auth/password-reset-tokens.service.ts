import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { PasswordResetToken } from '@storageos/database';

const TOKEN_BYTES = 32;
const TTL_MINUTES = 60;

export interface IssueArgs {
  tenantId: string;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface IssuedToken {
  plaintext: string;
  record: PasswordResetToken;
}

/**
 * CRUD de tokens de reset de password. Misma logica que
 * `VerificationTokensService` pero con TTL mas corto (1h) y metadatos
 * extra (IP, user-agent) para auditoria.
 */
@Injectable()
export class PasswordResetTokensService {
  constructor(private readonly admin: PrismaAdminService) {}

  async issue(args: IssueArgs): Promise<IssuedToken> {
    await this.admin.passwordResetToken.updateMany({
      where: { userId: args.userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    const secret = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = await argonHash(secret);
    const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

    const record = await this.admin.passwordResetToken.create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId,
        tokenHash,
        expiresAt,
        requestedIp: args.ipAddress ?? null,
        requestedUserAgent: args.userAgent ?? null,
      },
    });

    return { plaintext: `${record.id}.${secret}`, record };
  }

  async consume(plaintext: string): Promise<PasswordResetToken | null> {
    const parsed = parseToken(plaintext);
    if (!parsed) return null;

    const record = await this.admin.passwordResetToken.findUnique({
      where: { id: parsed.id },
    });
    if (!record) return null;
    if (record.usedAt !== null) return null;
    if (record.expiresAt.getTime() <= Date.now()) return null;

    const matches = await safeVerify(record.tokenHash, parsed.secret);
    if (!matches) return null;

    const result = await this.admin.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (result.count === 0) return null;
    return record;
  }
}

function parseToken(plaintext: string): { id: string; secret: string } | null {
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
