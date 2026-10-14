import { describe, expect, it } from 'vitest';

import { templateParamCount, whatsappAssistantNotice } from './index';

describe('templateParamCount', () => {
  it('cuenta la variable más alta', () => {
    expect(templateParamCount('Hola {{1}}, tu enlace: {{2}}')).toBe(2);
    expect(templateParamCount('Sin variables')).toBe(0);
    expect(templateParamCount('{{ 1 }} y otra vez {{1}}')).toBe(1);
  });
});

describe('whatsappAssistantNotice', () => {
  it('enlaza la política solo si la hay', () => {
    expect(whatsappAssistantNotice(null)).not.toContain('http');
    expect(whatsappAssistantNotice('https://a.es/privacidad')).toContain('https://a.es/privacidad');
  });
});
