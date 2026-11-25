import { describe, expect, it } from 'vitest';

import {
  BulkAdminFollowupsSchema,
  addDaysToDay,
  followupTab,
  opportunityOfferStatus,
  retentionPlaybookEmail,
  suggestNextFollowupDay,
  trialConversion,
  trialProgress,
} from './tenant-ops';

const NOW = new Date('2026-11-25T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('seguimientos', () => {
  it('cada seguimiento cae en su pestaña', () => {
    const today = '2026-11-25';
    expect(followupTab({ status: 'done', dueDate: '2026-11-01' }, today)).toBe('done');
    expect(followupTab({ status: 'pending', dueDate: '2026-11-24' }, today)).toBe('overdue');
    expect(followupTab({ status: 'pending', dueDate: today }, today)).toBe('today');
    expect(followupTab({ status: 'pending', dueDate: '2026-11-26' }, today)).toBe('upcoming');
  });

  it('propone el siguiente seguimiento a una o dos semanas', () => {
    expect(addDaysToDay('2026-12-30', 3)).toBe('2027-01-02');
    expect(suggestNextFollowupDay('2026-11-25', '2026-11-25')).toBe('2026-12-02');
    expect(suggestNextFollowupDay('2026-11-25', '2026-11-01')).toBe('2026-12-09');
  });

  it('el lote pide días al posponer y responsable al reasignar', () => {
    const item = { kind: 'tenant' as const, id: '00000000-0000-4000-8000-000000000001' };
    expect(BulkAdminFollowupsSchema.safeParse({ items: [item], action: 'postpone' }).success).toBe(
      false,
    );
    expect(BulkAdminFollowupsSchema.safeParse({ items: [item], action: 'assign' }).success).toBe(
      false,
    );
    expect(
      BulkAdminFollowupsSchema.safeParse({ items: [item], action: 'assign', assignedToId: null })
        .success,
    ).toBe(true);
  });
});

describe('trials', () => {
  it('cuenta lo que le falta de la puesta en marcha', () => {
    const p = trialProgress({
      facility: true,
      units: true,
      customers: false,
      contract: false,
      company: true,
      payment: false,
    });
    expect(p).toEqual({
      done: 3,
      total: 6,
      missing: ['Inquilinos', 'Primer contrato', 'Forma de cobro'],
    });
  });

  it('la probabilidad de pagar se explica', () => {
    const base = { progressDone: 2, progressTotal: 6, activeContracts: 0, invoices: 0, now: NOW };
    expect(trialConversion({ ...base, lastActivityAt: null }).level).toBe('low');
    expect(
      trialConversion({ ...base, activeContracts: 3, lastActivityAt: daysAgo(1) }),
    ).toMatchObject({ level: 'high' });
    expect(trialConversion({ ...base, invoices: 2, lastActivityAt: daysAgo(20) }).level).toBe(
      'medium',
    );
    expect(trialConversion({ ...base, lastActivityAt: daysAgo(30) }).reason).toContain('30 días');
    expect(trialConversion({ ...base, progressDone: 5, lastActivityAt: daysAgo(2) }).level).toBe(
      'medium',
    );
    expect(trialConversion({ ...base, progressDone: 1, lastActivityAt: daysAgo(2) }).level).toBe(
      'low',
    );
  });
});

describe('en riesgo', () => {
  it('el correo del playbook depende del motivo', () => {
    const args = { webBaseUrl: 'https://x.test' };
    expect(retentionPlaybookEmail('past_due', args).subject).toContain('cobrar');
    expect(retentionPlaybookEmail('trial_expired', args).body).toContain('solo lectura');
    expect(retentionPlaybookEmail('inactive', args).body).not.toContain('descuento');
    expect(retentionPlaybookEmail(undefined, args).body).toContain('descuento');
    const withMsg = retentionPlaybookEmail('trial_expiring', { ...args, message: 'Hola Ana' });
    expect(withMsg.body.split('\n').slice(0, 3)).toEqual(['Hola,', '', 'Hola Ana']);
  });
});

describe('oportunidades', () => {
  it('estado de la última propuesta', () => {
    const base = { sentAt: daysAgo(3), hasAddon: false, trialing: false, now: NOW };
    expect(opportunityOfferStatus(base)).toBe('sent');
    expect(opportunityOfferStatus({ ...base, sentAt: daysAgo(20) })).toBe('no_response');
    expect(opportunityOfferStatus({ ...base, trialing: true })).toBe('trialing');
    expect(opportunityOfferStatus({ ...base, hasAddon: true, trialing: true })).toBe('won');
  });
});
