import { describe, expect, it } from 'vitest';

import { suggestEmailFix } from './email-typo';

describe('suggestEmailFix', () => {
  it('corrige los errores habituales al escribir el dominio', () => {
    expect(suggestEmailFix('ana@gmial.com')).toBe('ana@gmail.com');
    expect(suggestEmailFix('ana@gamil.com')).toBe('ana@gmail.com');
    expect(suggestEmailFix('ana@gmai.com')).toBe('ana@gmail.com');
    expect(suggestEmailFix('ana@gmail.co')).toBe('ana@gmail.com');
    expect(suggestEmailFix('ana@gmail.con')).toBe('ana@gmail.com');
    expect(suggestEmailFix('ana@gmail.es')).toBe('ana@gmail.com');
    expect(suggestEmailFix('ana@gmail')).toBe('ana@gmail.com');
    expect(suggestEmailFix('ana@gmailcom')).toBe('ana@gmail.com');
    expect(suggestEmailFix('Ana@GMIAL.COM ')).toBe('ana@gmail.com');
    expect(suggestEmailFix('ana@hotmial.com')).toBe('ana@hotmail.com');
    expect(suggestEmailFix('ana@hotmal.es')).toBe('ana@hotmail.es');
    expect(suggestEmailFix('ana@hotmail.ess')).toBe('ana@hotmail.es');
    expect(suggestEmailFix('ana@outlok.com')).toBe('ana@outlook.com');
    expect(suggestEmailFix('ana@yaho.es')).toBe('ana@yahoo.es');
    expect(suggestEmailFix('ana@icloud.co')).toBe('ana@icloud.com');
  });

  it('no toca los dominios buenos ni los de empresa', () => {
    expect(suggestEmailFix('ana@gmail.com')).toBeNull();
    expect(suggestEmailFix('ana@hotmail.es')).toBeNull();
    expect(suggestEmailFix('ana@outlook.es')).toBeNull();
    expect(suggestEmailFix('ana@me.com')).toBeNull();
    expect(suggestEmailFix('ana@mail.com')).toBeNull();
    expect(suggestEmailFix('ana@email.com')).toBeNull();
    expect(suggestEmailFix('ana@guardalobox.es')).toBeNull();
    expect(suggestEmailFix('ana@lives.com')).toBeNull();
    expect(suggestEmailFix('ana@empresa.com')).toBeNull();
  });

  it('no sugiere nada sin dominio', () => {
    expect(suggestEmailFix('ana')).toBeNull();
    expect(suggestEmailFix('ana@')).toBeNull();
    expect(suggestEmailFix('@gmial.com')).toBeNull();
  });
});
