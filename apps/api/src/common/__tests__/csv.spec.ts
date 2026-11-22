import { csvCell, csvLineCell, neutralizeCsvText } from '../csv';

describe('celdas CSV sin fórmulas', () => {
  it('pone un apóstrofo delante de lo que Excel tomaría por una fórmula', () => {
    expect(neutralizeCsvText('=1+1')).toBe("'=1+1");
    expect(neutralizeCsvText('+34 600 000 000')).toBe("'+34 600 000 000");
    expect(neutralizeCsvText('-HOLA')).toBe("'-HOLA");
    expect(neutralizeCsvText('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeCsvText('\t=1')).toBe("'\t=1");
    expect(neutralizeCsvText('\r=1')).toBe("'\r=1");
  });

  it('deja los números (también los negativos) y el texto normal', () => {
    expect(neutralizeCsvText('-12,50')).toBe('-12,50');
    expect(neutralizeCsvText('+3')).toBe('+3');
    expect(neutralizeCsvText('Trasteros García')).toBe('Trasteros García');
    expect(csvCell(-12.5)).toBe('-12,5');
    expect(csvCell(null)).toBe('');
  });

  it('escapa comillas y separadores después de neutralizar', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('uno; dos')).toBe('"uno; dos"');
    expect(csvLineCell('a\n=b')).toBe('a =b');
    expect(csvLineCell('=a\nb')).toBe("'=a b");
  });
});
