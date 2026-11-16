import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  PAYMENT_DEADLINE_MAX_DAYS,
  type ExtendPaymentDeadlineInput,
  type ExtendPaymentDeadlineResultDto,
} from '@storageos/shared';

import { assertFacilityAllowed, type FacilityScope } from '../../common/facility-scope';
import { formatDateLong, zonedNextDayStart } from '../../common/format';
import { paymentDeadlineMax } from '../../common/payment-deadline';
import { AuditService } from '../auth/audit.service';
import { PrismaAdminService } from '../database/prisma-admin.service';

import { BookingRecoveryService } from './booking-recovery.service';

import type { RequestMeta } from '../auth/auth.service';
import type { Prisma } from '@storageos/database';

const DAY_MS = 86_400_000;
const SIGNING_LINK_MIN_MS = 7 * DAY_MS;

/**
 * Ampliar el plazo para firmar y pagar de un contrato con trastero retenido
 * (reserva online o contrato enviado por enlace). Mientras dura, el trastero
 * sigue reservado y la reserva no se cancela.
 */
@Injectable()
export class PaymentDeadlineService {
  private readonly logger = new Logger(PaymentDeadlineService.name);

  constructor(
    private readonly admin: PrismaAdminService,
    private readonly audit: AuditService,
    private readonly recovery: BookingRecoveryService,
  ) {}

  async extend(args: {
    tenantId: string;
    userId: string;
    contractId: string;
    input: ExtendPaymentDeadlineInput;
    scope: FacilityScope;
    meta: RequestMeta;
  }): Promise<ExtendPaymentDeadlineResultDto> {
    const contract = await this.admin.contract.findFirst({
      where: { id: args.contractId, tenantId: args.tenantId, deletedAt: null },
      select: {
        id: true,
        status: true,
        createdAt: true,
        signedAt: true,
        firstPaymentDeadline: true,
        signingTokenHash: true,
        signingTokenExpiresAt: true,
        unit: { select: { facilityId: true, facility: { select: { timezone: true } } } },
      },
    });
    if (!contract) {
      throw new NotFoundException({
        code: 'contract_not_found',
        message: 'Contrato no encontrado',
      });
    }
    assertFacilityAllowed(args.scope, contract.unit.facilityId);
    if (!contract.firstPaymentDeadline) {
      throw new ConflictException({
        code: 'no_payment_deadline',
        message: 'Este contrato no tiene plazo para firmar y pagar: no caduca.',
      });
    }
    if (contract.status !== 'draft' && contract.status !== 'active') {
      throw new ConflictException({
        code: 'payment_deadline_closed',
        message: 'Este contrato ya no está pendiente de firma ni de pago.',
      });
    }
    const paid = await this.admin.invoice.findFirst({
      where: {
        tenantId: args.tenantId,
        contractId: contract.id,
        kind: 'invoice',
        status: 'paid',
      },
      select: { id: true },
    });
    if (paid) {
      throw new ConflictException({
        code: 'already_paid',
        message: 'El primer pago ya está hecho: la reserva no caduca.',
      });
    }

    const now = Date.now();
    const current = contract.firstPaymentDeadline;
    const timeZone = contract.unit.facility.timezone ?? 'Europe/Madrid';
    const next = args.input.days
      ? new Date(Math.max(current.getTime(), now) + args.input.days * DAY_MS)
      : // Hasta una fecha: al final de ese día en la hora del local.
        new Date(zonedNextDayStart(args.input.until!, timeZone).getTime() - 60_000);
    const max = paymentDeadlineMax(contract);
    if (next.getTime() <= Math.max(current.getTime(), now)) {
      throw new BadRequestException({
        code: 'deadline_not_later',
        message: `La fecha nueva tiene que ser posterior al plazo actual (${formatDateLong(current, timeZone)}).`,
      });
    }
    if (next.getTime() > max.getTime()) {
      throw new BadRequestException({
        code: 'deadline_too_far',
        message: `Como mucho hasta el ${formatDateLong(max, timeZone)} (${PAYMENT_DEADLINE_MAX_DAYS} días desde la reserva).`,
      });
    }

    const reason = args.input.reason?.trim() || null;
    await this.admin.$transaction([
      this.admin.contract.update({
        where: { id: contract.id },
        data: { firstPaymentDeadline: next },
      }),
      this.admin.contractEvent.create({
        data: {
          tenantId: args.tenantId,
          contractId: contract.id,
          eventType: 'note_added',
          payload: {
            event: 'payment_deadline_extended',
            from: current.toISOString(),
            to: next.toISOString(),
            ...(reason ? { reason } : {}),
          } as Prisma.InputJsonValue,
          createdByUserId: args.userId,
        },
      }),
    ]);

    let notified = false;
    if (args.input.notifyCustomer) {
      notified = await this.recovery
        .sendHoldEmail(args.tenantId, contract.id, 'extended')
        .catch((err: unknown) => {
          this.logger.warn(
            `[deadline] no se pudo avisar del contrato ${contract.id}: ${(err as Error).message}`,
          );
          return false;
        });
    }
    // El enlace de la firma (para firmar o, ya firmado, para completar el pago)
    // tiene que valer hasta el plazo nuevo.
    const link = await this.admin.contract.findUnique({
      where: { id: contract.id },
      select: { signingTokenHash: true, signingTokenExpiresAt: true },
    });
    if (link?.signingTokenHash) {
      const until = Math.max(
        link.signingTokenExpiresAt?.getTime() ?? 0,
        next.getTime(),
        notified ? now + SIGNING_LINK_MIN_MS : 0,
      );
      await this.admin.contract.update({
        where: { id: contract.id },
        data: { signingTokenExpiresAt: new Date(until) },
      });
    }

    await this.audit.write({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'contract.payment_deadline_extended',
      entityType: 'Contract',
      entityId: contract.id,
      changes: {
        from: current.toISOString(),
        to: next.toISOString(),
        notified,
        ...(reason ? { reason } : {}),
      },
      ...(args.meta.ipAddress ? { ipAddress: args.meta.ipAddress } : {}),
      ...(args.meta.userAgent ? { userAgent: args.meta.userAgent } : {}),
    });
    return { paymentDeadline: next.toISOString(), notified };
  }
}
