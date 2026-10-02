import { describe, expect, it } from 'vitest';

import { resolveUserEmailNotices } from './index';

describe('resolveUserEmailNotices', () => {
  it('propietarios y gestores reciben todo por defecto; el resto, nada', () => {
    expect(resolveUserEmailNotices({}, 'owner').new_lead).toBe(true);
    expect(resolveUserEmailNotices(null, 'manager').portal_incident).toBe(true);
    expect(resolveUserEmailNotices({}, 'staff').new_booking).toBe(false);
    expect(resolveUserEmailNotices({}, 'readonly').new_lead).toBe(false);
  });

  it('lo que el usuario cambia manda sobre el defecto de su rol', () => {
    const owner = resolveUserEmailNotices({ new_lead: false }, 'owner');
    expect(owner.new_lead).toBe(false);
    expect(owner.new_booking).toBe(true);
    const staff = resolveUserEmailNotices({ new_booking: true, x: 'basura' }, 'staff');
    expect(staff.new_booking).toBe(true);
    expect(staff.new_lead).toBe(false);
  });
});
