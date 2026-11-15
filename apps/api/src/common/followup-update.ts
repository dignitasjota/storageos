import { BadRequestException } from '@nestjs/common';

import type { Prisma } from '@storageos/database';
import type { UpdateFollowupInput } from '@storageos/shared';

/**
 * Lo que cambia en un seguimiento (de un contacto o de un inquilino): hecho con
 * su resultado, reabierto, pospuesto, editado o con otro responsable.
 */
export function followupUpdateData(input: UpdateFollowupInput, now = new Date()) {
  return {
    ...(input.status === 'done'
      ? { status: 'done', completedAt: now, outcome: input.outcome?.trim() || null }
      : input.status === 'pending'
        ? { status: 'pending', completedAt: null, outcome: null }
        : input.outcome !== undefined
          ? { outcome: input.outcome.trim() || null }
          : {}),
    ...(input.dueDate ? { dueDate: new Date(input.dueDate) } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
    ...(input.assignedToUserId !== undefined ? { assignedToUserId: input.assignedToUserId } : {}),
  };
}

/** El responsable tiene que ser una persona activa del equipo. */
export async function assertTeamMember(
  tx: Prisma.TransactionClient,
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  const user = await tx.user.findFirst({
    where: { id: userId, isActive: true },
    select: { id: true },
  });
  if (!user) {
    throw new BadRequestException({
      code: 'user_not_found',
      message: 'Esa persona no está en tu equipo',
    });
  }
}
