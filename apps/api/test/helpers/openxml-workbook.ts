import JSZip from 'jszip';

/** Una celda: texto, número o vacía (null o ''). */
export type OpenXmlCell = string | number | null;

export interface OpenXmlSheet {
  name: string;
  rows: OpenXmlCell[][];
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const BOM = String.fromCharCode(0xfeff);

const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function column(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Un .xlsx como los que escribe el OpenXML SDK (los maestros de SEO): todos
 * los elementos con el prefijo `x:`, los destinos de las relaciones como rutas
 * absolutas (`/xl/...`), el BOM en los `.rels` y una tabla por hoja. exceljs
 * no abre este formato sin normalizarlo.
 */
export async function buildOpenXmlWorkbook(sheets: OpenXmlSheet[]): Promise<Buffer> {
  const zip = new JSZip();
  const overrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" />',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" />',
  ];
  const wbRels: string[] = [
    `<Relationship Type="${REL_NS}/styles" Target="/xl/styles.xml" Id="Rstyles" />`,
  ];
  const sheetEls: string[] = [];
  sheets.forEach((sheet, i) => {
    const n = i + 1;
    const rid = `Rsheet${n}`;
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" />`,
      `<Override PartName="/xl/tables/table${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml" />`,
    );
    wbRels.push(
      `<Relationship Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet${n}.xml" Id="${rid}" />`,
    );
    sheetEls.push(
      `<x:sheet name="${esc(sheet.name)}" sheetId="${n}" r:id="${rid}" xmlns:r="${REL_NS}" />`,
    );
    const width = Math.max(1, ...sheet.rows.map((r) => r.length));
    const rowsXml = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            const ref = `${column(c)}${r + 1}`;
            if (value === null || value === '') return '';
            if (typeof value === 'number') {
              return `<x:c r="${ref}" t="n"><x:v>${value}</x:v></x:c>`;
            }
            return `<x:c r="${ref}" t="str"><x:v>${esc(value)}</x:v></x:c>`;
          })
          .join('');
        return `<x:row r="${r + 1}">${cells}</x:row>`;
      })
      .join('');
    zip.file(
      `xl/worksheets/sheet${n}.xml`,
      `<?xml version="1.0" encoding="utf-8"?><x:worksheet xmlns:x="${NS}"><x:sheetData>${rowsXml}</x:sheetData><x:tableParts count="1"><x:tablePart r:id="Rtable${n}" xmlns:r="${REL_NS}" /></x:tableParts></x:worksheet>`,
    );
    zip.file(
      `xl/worksheets/_rels/sheet${n}.xml.rels`,
      `${BOM}<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="${PKG_NS}"><Relationship Type="${REL_NS}/table" Target="/xl/tables/table${n}.xml" Id="Rtable${n}" /></Relationships>`,
    );
    const header = sheet.rows[0] ?? [];
    const cols = Array.from({ length: width }, (_, c) => {
      const name =
        header[c] === null || header[c] === undefined ? `Col${c + 1}` : String(header[c]);
      return `<x:tableColumn id="${c + 1}" name="${esc(name || `Col${c + 1}`)}" />`;
    }).join('');
    const lastRow = Math.max(2, sheet.rows.length);
    zip.file(
      `xl/tables/table${n}.xml`,
      `<?xml version="1.0" encoding="utf-8"?><x:table id="${n}" name="T${n}" displayName="T${n}" ref="A1:${column(width - 1)}${lastRow}" headerRowCount="1" totalsRowCount="0" totalsRowShown="0" xmlns:x="${NS}"><x:tableColumns count="${width}">${cols}</x:tableColumns><x:tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0" /></x:table>`,
    );
  });
  zip.file(
    '[Content_Types].xml',
    `${BOM}<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />${overrides.join('')}</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${BOM}<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="${PKG_NS}"><Relationship Type="${REL_NS}/officeDocument" Target="/xl/workbook.xml" Id="Rdoc" /></Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="utf-8"?><x:workbook xmlns:x="${NS}"><x:sheets>${sheetEls.join('')}</x:sheets></x:workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${BOM}<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="${PKG_NS}">${wbRels.join('')}</Relationships>`,
  );
  zip.file(
    'xl/styles.xml',
    `<?xml version="1.0" encoding="utf-8"?><x:styleSheet xmlns:x="${NS}"><x:fonts count="1"><x:font><x:sz val="11" /><x:name val="Calibri" /></x:font></x:fonts><x:fills count="1"><x:fill><x:patternFill patternType="none" /></x:fill></x:fills><x:borders count="1"><x:border /></x:borders><x:cellStyleXfs count="1"><x:xf numFmtId="0" fontId="0" fillId="0" borderId="0" /></x:cellStyleXfs><x:cellXfs count="1"><x:xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" /></x:cellXfs></x:styleSheet>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
