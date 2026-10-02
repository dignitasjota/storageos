/** Construye una línea N43 de 80 chars desde tramos [pos1, texto]. */
export function n43Line(segments: [number, string][]): string {
  const buf = ' '.repeat(80).split('');
  for (const [pos, text] of segments) {
    for (let i = 0; i < text.length; i++) buf[pos - 1 + i] = text[i]!;
  }
  return buf.join('');
}

export function buildN43(
  creditAmount: string,
  reference: string,
  debitAmount = '00000000005000',
): string {
  const header = n43Line([
    [1, '11'],
    [3, '2100'],
    [7, '0418'],
    [11, '0200051332'],
    [21, '260601'],
    [27, '260630'],
    [33, '2'],
    [34, '00000000100000'],
    [48, '978'],
  ]);
  const credit = n43Line([
    [1, '22'],
    [7, '260615'],
    [13, '260615'],
    [24, '2'],
    [25, creditAmount],
    [61, reference],
  ]);
  const debit = n43Line([
    [1, '22'],
    [7, '260616'],
    [13, '260616'],
    [24, '1'],
    [25, debitAmount],
  ]);
  const footer = n43Line([
    [1, '33'],
    [49, '2'],
    [50, '00000000107100'],
  ]);
  const eof = n43Line([[1, '88']]);
  return [header, credit, debit, footer, eof].join('\n');
}
