import { describe, expect, it } from 'vitest';

import { adminTodaySectionLabel, adminTodayUrgentCounts, pluralEs } from './today';

import type { AdminTodayUrgencySource } from './today';

const empty: AdminTodayUrgencySource = {
  pendingApprovals: [],
  addonCharges: [],
  pastDue: [],
  manualRenewalsDue: [],
  followupsDue: [],
  openTickets: [],
  expiringOverrides: [],
  newLeads: [],
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

  it('pone nombre a las secciones y plural a los números', () => {
    expect(adminTodaySectionLabel('openTickets')).toBe('tickets de soporte');
    expect(adminTodaySectionLabel('otra')).toBe('otra');
    expect(pluralEs(1, 'acción urgente', 'acciones urgentes')).toBe('1 acción urgente');
    expect(pluralEs(29, 'acción urgente', 'acciones urgentes')).toBe('29 acciones urgentes');
  });
});
