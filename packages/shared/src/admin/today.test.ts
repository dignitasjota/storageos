import { describe, expect, it } from 'vitest';

import {
  isTicketUrgent,
  adminTodaySectionLabel,
  adminTodayUrgentCounts,
  adminTodayVisitSummary,
  pluralEs,
} from './today';

import type { AdminTodayUrgencySource, AdminTodayVisitSnapshotItem } from './today';

const empty: AdminTodayUrgencySource = {
  pendingApprovals: [],
  addonCharges: [],
  pastDue: [],
  manualRenewalsDue: [],
  followupsDue: [],
  openTickets: [],
  expiringOverrides: [],
  newLeads: [],
  assignedLeads: [],
  paymentFailures: [],
  leadFollowupsDue: [],
  domainsReady: [],
  rgpdOverdue: [],
  aeatIssues: [],
  certificatesExpiring: [],
  holdedReview: [],
  devicesOffline: [],
  overdueCrons: [],
  failedWebhooks: [],
  failedJobs: 0,
};

const lead = (assignedToId: string | null) =>
  ({
    id: 'l',
    name: 'Lead',
    email: null,
    source: 'web_contact',
    waitingHours: 1,
    assignedToId,
    assignedToName: null,
  }) as AdminTodayUrgencySource['newLeads'][number];

describe('urgentes de «Hoy»', () => {
  it('cuadran por pestaña y en total', () => {
    const counts = adminTodayUrgentCounts({
      ...empty,
      manualRenewalsDue: [
        { tenantId: 'a', tenantName: 'A', currentPeriodEnd: '', daysLeft: 0 },
        { tenantId: 'b', tenantName: 'B', currentPeriodEnd: '', daysLeft: 5 },
      ],
      devicesOffline: [{ tenantId: 'a', tenantName: 'A', count: 2 }],
      failedJobs: 7,
    });
    expect(counts).toEqual({ business: 1, ops: 2, total: 3 });
  });

  it('un lead asignado a un comercial no es urgente', () => {
    const counts = adminTodayUrgentCounts({ ...empty, newLeads: [lead(null), lead('x')] });
    expect(counts.total).toBe(1);
  });

  it('un lead asignado sin atender solo es urgente en «Lo mío»', () => {
    const d = { ...empty, assignedLeads: [lead('me')] };
    expect(adminTodayUrgentCounts(d).total).toBe(0);
    expect(adminTodayUrgentCounts(d, { mine: true }).total).toBe(1);
  });

  it('solo cuentan los tickets que vencen en menos de 2 h o ya vencieron', () => {
    const ticket = (dueInHours: number) =>
      ({ id: String(dueInHours), dueInHours }) as AdminTodayUrgencySource['openTickets'][number];
    const counts = adminTodayUrgentCounts({
      ...empty,
      openTickets: [ticket(-3), ticket(1.5), ticket(10)],
    });
    expect(counts.business).toBe(2);
  });

  it('pone nombre a las secciones y plural a los números', () => {
    expect(adminTodaySectionLabel('openTickets')).toBe('tickets de soporte');
    expect(adminTodaySectionLabel('otra')).toBe('otra');
    expect(pluralEs(1, 'acción urgente', 'acciones urgentes')).toBe('1 acción urgente');
    expect(pluralEs(29, 'acción urgente', 'acciones urgentes')).toBe('29 acciones urgentes');
  });
});

describe('tickets urgentes', () => {
  it('un ticket de prioridad urgente lo es siempre; el resto, por su plazo', () => {
    expect(isTicketUrgent({ priority: 'urgent', dueInHours: 2 })).toBe(true);
    expect(isTicketUrgent({ priority: 'high', dueInHours: 8 })).toBe(false);
    expect(isTicketUrgent({ priority: 'high', dueInHours: 1.5 })).toBe(true);
    expect(isTicketUrgent({ priority: 'normal', dueInHours: -3 })).toBe(true);
  });
});

describe('resumen desde la última visita', () => {
  const item = (key: string, reappeared = false): AdminTodayVisitSnapshotItem => ({
    key,
    section: 'openTickets',
    label: key,
    href: '/admin/today',
    reappeared,
  });
  const now = new Date('2026-11-21T10:00:00Z');

  it('separa lo nuevo, lo resuelto y lo que ha empeorado', () => {
    const summary = adminTodayVisitSummary(
      { seenAt: new Date('2026-11-21T06:00:00Z'), items: [item('a'), item('b'), item('c')] },
      [item('a'), item('d'), item('e', true)],
      new Set(['c']),
      now,
    );
    expect(summary.show).toBe(true);
    expect(summary.newItems.map((i) => i.key)).toEqual(['d']);
    // «c» está apartado: no se da por resuelto.
    expect(summary.resolvedItems.map((i) => i.key)).toEqual(['b']);
    expect(summary.worseItems.map((i) => i.key)).toEqual(['e']);
  });

  it('no sale si la última visita fue hace menos de una hora o es la primera', () => {
    const recent = adminTodayVisitSummary(
      { seenAt: new Date('2026-11-21T09:30:00Z'), items: [] },
      [item('a')],
      new Set(),
      now,
    );
    expect(recent.show).toBe(false);
    expect(adminTodayVisitSummary(null, [item('a')], new Set(), now).show).toBe(false);
  });
});
