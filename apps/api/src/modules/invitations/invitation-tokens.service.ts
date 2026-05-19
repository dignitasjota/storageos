import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { PrismaAdminService } from '../database/prisma-admin.service';

import type { Invitation } from '@storageos/database';

const TOKEN_BYTES = 32;
const TTL_DAYS = 7;

export interface IssuedToken {
  /** Plaintext `<id>.<secret>` que va al email. */
  plaintext: string;
  record: Invitation;
}

/**
 * Genera y consume tokens de invitacion. Comparte el patron con
 * `VerificationTokensService` / `PasswordResetTokensService`: plaintext de
 * la forma `<id>.<secret>`, hash argon2id, single-use atomico.
 */
@Injectable()
export class InvitationTokensService {
  constructor(private readonly admin: PrismaAdminService) {}

  buildExpiry(): Date {
    return new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
  }

  async hashSecret(): Promise<{ secret: string; tokenHash: string }> {
    const secret = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = await argonHash(secret);
    return { secret, tokenHash };
  }

  formatPlaintext(id: string, secret: string): string {
    return `${id}.${secret}`;
  }

  parse(plaintext: string): { id: string; secret: string } | null {
    const idx = plaintext.indexOf('.');
    if (idx <= 0 || idx === plaintext.length - 1) return null;
    return { id: plaintext.slice(0, idx), secret: plaintext.slice(idx + 1) };
  }

  /**
   * Busca y valida un token. Devuelve la invitacion si esta pendiente,
   * o `null` si no existe / esta usada / revocada / expirada / no
   * coincide el secret.
   */
  async lookup(plaintext: string): Promise<Invitation | null> {
    const parsed = this.parse(plaintext);
    if (!parsed) return null;

    const record = await this.admin.invitation.findUnique({ where: { id: parsed.id } });
    if (!record) return null;
    if (record.acceptedAt !== null) return null;
    if (record.revokedAt !== null) return null;
    if (record.expiresAt.getTime() <= Date.now()) return null;

    let matches = false;
    try {
      matches = await argonVerify(record.tokenHash, parsed.secret);
    } catch {
      matches = false;
    }
    return matches ? record : null;
  }

  /**
   * Marca como aceptada solo si esta pendiente. Devuelve true si la
   * actualizacion afecto exactamente 1 fila (garantia single-use atomica).
   */
  async markAccepted(id: string): Promise<boolean> {
    const result = await this.admin.invitation.updateMany({
      where: { id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    return result.count === 1;
  }
}
