import { describe, expect, it } from 'vitest';

import { auditEntityHref } from './links';

const ID = '0190a7d2-1b2c-7d3e-8f40-123456789abc';

describe('auditEntityHref', () => {
  it('enlaza a la ficha del elemento', () => {
    expect(auditEntityHref('Customer', ID)).toBe(`/customers/${ID}`);
    expect(auditEntityHref('invoice', ID)).toBe(`/invoices/${ID}`);
    expect(auditEntityHref('Lead', ID)).toBe(`/leads?lead=${ID}`);
    expect(auditEntityHref('DelinquencyCase', ID)).toBe(`/collections/${ID}`);
  });

  it('las fichas sin id no enlazan', () => {
    expect(auditEntityHref('Contract', null)).toBeNull();
    expect(auditEntityHref('Unit', 'no-es-un-id')).toBeNull();
  });

  it('lo que no tiene ficha va a su página o no enlaza', () => {
    expect(auditEntityHref('User', ID)).toBe('/settings/users');
    expect(auditEntityHref('Tenant', ID)).toBeNull();
    expect(auditEntityHref('Session', null)).toBeNull();
  });
});
