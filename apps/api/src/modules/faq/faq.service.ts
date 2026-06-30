import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';

import type { CreateFaqEntryInput, FaqEntryDto, UpdateFaqEntryInput } from '@storageos/shared';

type FaqRow = {
  id: string;
  question: string;
  answer: string;
  position: number;
  isPublished: boolean;
  createdAt: Date;
};

function toDto(row: FaqRow): FaqEntryDto {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    position: row.position,
    isPublished: row.isPublished,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Centro de ayuda: preguntas frecuentes por tenant. El staff las gestiona; el
 * inquilino ve las publicadas en su portal. RLS vía `withTenant` (sirve a ambos
 * lados pasando el `tenantId`).
 */
@Injectable()
export class FaqService {
  constructor(private readonly prisma: PrismaService) {}

  /** Todas las entradas (staff), ordenadas. */
  async list(tenantId: string): Promise<FaqEntryDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.faqEntry.findMany({
          where: { tenantId },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
      tenantId,
    );
    return rows.map(toDto);
  }

  /** Solo las publicadas (portal del inquilino). */
  async listPublished(tenantId: string): Promise<FaqEntryDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.faqEntry.findMany({
          where: { tenantId, isPublished: true },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
      tenantId,
    );
    return rows.map(toDto);
  }

  async create(tenantId: string, input: CreateFaqEntryInput): Promise<FaqEntryDto> {
    const created = await this.prisma.withTenant(
      (tx) =>
        tx.faqEntry.create({
          data: {
            tenantId,
            question: input.question,
            answer: input.answer,
            position: input.position ?? 0,
            isPublished: input.isPublished ?? true,
          },
        }),
      tenantId,
    );
    return toDto(created);
  }

  async update(tenantId: string, id: string, input: UpdateFaqEntryInput): Promise<FaqEntryDto> {
    await this.findOrThrow(tenantId, id);
    const updated = await this.prisma.withTenant(
      (tx) =>
        tx.faqEntry.update({
          where: { id },
          data: {
            ...(input.question !== undefined ? { question: input.question } : {}),
            ...(input.answer !== undefined ? { answer: input.answer } : {}),
            ...(input.position !== undefined ? { position: input.position } : {}),
            ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
          },
        }),
      tenantId,
    );
    return toDto(updated);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOrThrow(tenantId, id);
    await this.prisma.withTenant((tx) => tx.faqEntry.delete({ where: { id } }), tenantId);
  }

  private async findOrThrow(tenantId: string, id: string): Promise<void> {
    const row = await this.prisma.withTenant(
      (tx) => tx.faqEntry.findFirst({ where: { id, tenantId }, select: { id: true } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'faq_entry_not_found',
        message: 'Entrada no encontrada',
      });
    }
  }
}
