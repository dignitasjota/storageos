import { describe, expect, it } from 'vitest';

import { CAMPAIGN_TEMPLATE_VARIABLES, templateTextProblems } from './index';

const customers = CAMPAIGN_TEMPLATE_VARIABLES.customers;

describe('templateTextProblems', () => {
  it('acepta texto sin variables y variables permitidas', () => {
    expect(templateTextProblems('Hola, ¿qué tal?', customers)).toEqual([]);
    expect(
      templateTextProblems('Hola {{customer.firstName}} de {{ tenant.name }}', customers),
    ).toEqual([]);
    expect(templateTextProblems('{{{customer.firstName}}}', customers)).toEqual([]);
  });

  it('detecta una variable sin cerrar', () => {
    const p = templateTextProblems('Hola {{customer.firstName', customers);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('sin cerrar');
    expect(templateTextProblems('Hola {{customer {{tenant.name}}', customers)[0]).toContain(
      'sin cerrar',
    );
  });

  it('detecta variables que no existen o son de otra audiencia', () => {
    const p = templateTextProblems('Cupón {{coupon.code}} para {{lead.firstName}}', customers);
    expect(p[0]).toContain('{{coupon.code}}');
    expect(p[0]).toContain('{{lead.firstName}}');
  });

  it('rechaza bloques y ayudantes', () => {
    expect(templateTextProblems('{{#if x}}a{{/if}}', customers)[0]).toContain('variables simples');
    expect(templateTextProblems('{{formatDate customer.firstName}}', customers)[0]).toContain(
      'variables simples',
    );
  });
});
