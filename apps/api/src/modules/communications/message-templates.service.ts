import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../auth/audit.service';
import { PrismaService } from '../database/prisma.service';

import { BUILTIN_TEMPLATES } from './builtin-templates';
import { renderTemplate } from './template-engine';

import type { RequestMeta } from '../auth/auth.service';
import type { MessageTemplate, Prisma } from '@storageos/database';
import type {
  CreateMessageTemplateInput,
  MessageTemplateDto,
  PreviewMessageTemplateInput,
  UpdateMessageTemplateInput,
} from '@storageos/shared';

@Injectable()
export class MessageTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<MessageTemplateDto[]> {
    const rows = await this.prisma.withTenant(
      (tx) =>
        tx.messageTemplate.findMany({
          where: { deletedAt: null },
          orderBy: [{ kind: 'asc' }, { name: 'asc' }],
        }),
      tenantId,
    );
    return rows.map((r) => this.toDto(r));
  }

  async detail(tenantId: string, id: string): Promise<MessageTemplateDto> {
    const row = await this.findOrThrow(tenantId, id);
    return this.toDto(row);
  }

  async create(args: {
    tenantId: string;
    userId: string;
    input: CreateMessageTemplateInput;
    meta: RequestMeta;
  }): Promise<MessageTemplateDto> {
    try {
      const created = await this.prisma.withTenant(
        (tx) =>
          tx.messageTemplate.create({
            data: {
              tenantId: args.tenantId,
              code: args.input.code,
              kind: args.input.kind,
              channel: args.input.channel,
              name: args.input.name,
              subject: args.input.subject ?? null,
              bodyText: args.input.bodyText,
              bodyHtml: args.input.bodyHtml ?? null,
              locale: args.input.locale,
              variables: args.input.variables,
              whatsappTemplateName: args.input.whatsappTemplateName?.trim() || null,
              whatsappTemplateLanguage: args.input.whatsappTemplateLanguage?.trim() || null,
              whatsappTemplateVariables: args.input.whatsappTemplateVariables,
              metadata: args.input.metadata as Prisma.InputJsonValue,
            },
          }),
        args.tenantId,
      );
      await this.audit.write({
        action: 'message_template.created',
        tenantId: args.tenantId,
        userId: args.userId,
        entityType: 'message_template',
        entityId: created.id,
        ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
        ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
        changes: { code: created.code },
      });
      return this.toDto(created);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'message_template_code_taken',
          message: 'Ya existe una plantilla con ese codigo',
        });
      }
      throw err;
    }
  }

  async update(args: {
    tenantId: string;
    userId: string;
    id: string;
    input: UpdateMessageTemplateInput;
    meta: RequestMeta;
  }): Promise<MessageTemplateDto> {
    const existing = await this.findOrThrow(args.tenantId, args.id);
    if (existing.kind === 'system') {
      throw new ConflictException({
        code: 'message_template_system_readonly',
        message: 'Las plantillas del sistema no son editables',
      });
    }
    const data: Prisma.MessageTemplateUncheckedUpdateInput = {};
    if (args.input.name !== undefined) data.name = args.input.name;
    if (args.input.subject !== undefined) data.subject = args.input.subject || null;
    if (args.input.bodyText !== undefined) data.bodyText = args.input.bodyText;
    if (args.input.bodyHtml !== undefined) data.bodyHtml = args.input.bodyHtml || null;
    if (args.input.locale !== undefined) data.locale = args.input.locale;
    if (args.input.variables !== undefined) data.variables = args.input.variables;
    if (args.input.whatsappTemplateName !== undefined)
      data.whatsappTemplateName = args.input.whatsappTemplateName || null;
    if (args.input.whatsappTemplateLanguage !== undefined)
      data.whatsappTemplateLanguage = args.input.whatsappTemplateLanguage || null;
    if (args.input.whatsappTemplateVariables !== undefined)
      data.whatsappTemplateVariables = args.input.whatsappTemplateVariables;
    if (args.input.metadata !== undefined)
      data.metadata = args.input.metadata as Prisma.InputJsonValue;
    if (args.input.isActive !== undefined) data.isActive = args.input.isActive;
    const updated = await this.prisma.withTenant(
      (tx) => tx.messageTemplate.update({ where: { id: args.id }, data }),
      args.tenantId,
    );
    await this.audit.write({
      action: 'message_template.updated',
      tenantId: args.tenantId,
      userId: args.userId,
      entityType: 'message_template',
      entityId: args.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return this.toDto(updated);
  }

  async remove(args: {
    tenantId: string;
    userId: string;
    id: string;
    meta: RequestMeta;
  }): Promise<void> {
    const existing = await this.findOrThrow(args.tenantId, args.id);
    if (existing.kind === 'system') {
      throw new ConflictException({
        code: 'message_template_system_readonly',
        message: 'Las plantillas del sistema no son editables',
      });
    }
    await this.prisma.withTenant(
      (tx) =>
        tx.messageTemplate.update({
          where: { id: args.id },
          data: { deletedAt: new Date() },
        }),
      args.tenantId,
    );
    await this.audit.write({
      action: 'message_template.deleted',
      tenantId: args.tenantId,
      userId: args.userId,
      entityType: 'message_template',
      entityId: args.id,
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
  }

  preview(input: PreviewMessageTemplateInput): {
    subject: string;
    bodyText: string;
    bodyHtml: string;
  } {
    const scope = input.variables;
    return {
      subject: renderTemplate(input.subject ?? '', scope),
      bodyText: renderTemplate(input.bodyText ?? '', scope),
      bodyHtml: renderTemplate(input.bodyHtml ?? '', scope),
    };
  }

  /**
   * Siembra las plantillas built-in para un tenant nuevo. Idempotente:
   * usa UPSERT por (tenantId, code).
   */
  async seedBuiltins(tenantId: string): Promise<void> {
    await this.prisma.withTenant(
      (tx) =>
        Promise.all(
          BUILTIN_TEMPLATES.map((b) =>
            tx.messageTemplate.upsert({
              where: { tenantId_code: { tenantId, code: b.code } },
              update: {},
              create: {
                tenantId,
                code: b.code,
                kind: b.kind,
                channel: b.channel,
                name: b.name,
                subject: b.subject,
                bodyText: b.bodyText,
                bodyHtml: b.bodyHtml,
                locale: b.locale,
                variables: b.variables,
                metadata: b.trigger ? { trigger: b.trigger } : {},
              },
            }),
          ),
        ),
      tenantId,
    );
  }

  /** Busca por (tenantId, code). Necesario para automations. */
  async findByCode(tenantId: string, code: string): Promise<MessageTemplate | null> {
    return this.prisma.withTenant(
      (tx) => tx.messageTemplate.findFirst({ where: { code, deletedAt: null } }),
      tenantId,
    );
  }

  /** Busca por id (validando tenant via RLS). */
  async findById(tenantId: string, id: string): Promise<MessageTemplate | null> {
    return this.prisma.withTenant(
      (tx) => tx.messageTemplate.findFirst({ where: { id, deletedAt: null } }),
      tenantId,
    );
  }

  private async findOrThrow(tenantId: string, id: string): Promise<MessageTemplate> {
    const row = await this.prisma.withTenant(
      (tx) => tx.messageTemplate.findFirst({ where: { id, deletedAt: null } }),
      tenantId,
    );
    if (!row) {
      throw new NotFoundException({
        code: 'message_template_not_found',
        message: 'Plantilla no encontrada',
      });
    }
    return row;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    );
  }

  private toDto(t: MessageTemplate): MessageTemplateDto {
    return {
      id: t.id,
      code: t.code,
      kind: t.kind,
      channel: t.channel,
      name: t.name,
      subject: t.subject,
      bodyText: t.bodyText,
      bodyHtml: t.bodyHtml,
      locale: t.locale,
      isActive: t.isActive,
      variables: t.variables,
      whatsappTemplateName: t.whatsappTemplateName,
      whatsappTemplateLanguage: t.whatsappTemplateLanguage,
      whatsappTemplateVariables: t.whatsappTemplateVariables,
      metadata: (t.metadata ?? {}) as Record<string, unknown>,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }
}
