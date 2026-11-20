import { settingsChanges } from '../settings-audit';

describe('settingsChanges', () => {
  it('solo lleva lo que cambia, con el valor anterior y el nuevo', () => {
    expect(
      settingsChanges({ enabled: false, terminal: '1' }, { enabled: true, terminal: '1' }),
    ).toEqual({ enabled: { from: false, to: true } });
  });

  it('nombra los secretos reescritos sin su valor', () => {
    const c = settingsChanges(null, { enabled: true }, { secretKey: 'abc', other: undefined });
    expect(c).toEqual({ enabled: { from: null, to: true }, secretsChanged: ['secretKey'] });
    expect(JSON.stringify(c)).not.toContain('abc');
  });
});
