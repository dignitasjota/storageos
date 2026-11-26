import { posix } from 'node:path';

import JSZip from 'jszip';

/** Espacio de nombres de las hojas de cálculo de OpenXML. */
const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const PREFIXED_NS_RE =
  /\sxmlns:x="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/;
const DEFAULT_NS_RE = /<[^!?][^>]*\sxmlns="/;
const BOM_RE = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/**
 * Los Excel que genera el OpenXML SDK (como los maestros de SEO) escriben los
 * elementos con el prefijo `x:` (`<x:workbook>`, `<x:sheetData>`…) y los
 * destinos de las relaciones como rutas absolutas (`/xl/worksheets/sheet1.xml`).
 * Los dos son válidos, pero exceljs no los entiende: busca las etiquetas sin
 * prefijo y resuelve los destinos como rutas relativas. Aquí se reescribe el
 * paquete a la forma habitual: sin el prefijo (el espacio de nombres pasa a
 * ser el de por defecto) y con los destinos relativos a la parte que los usa.
 *
 * Devuelve el paquete normalizado, o `null` si no hacía falta tocar nada.
 */
export async function normalizeOpenXmlPackage(buffer: Buffer): Promise<Buffer | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return null;
  }
  let changed = false;
  for (const file of Object.values(zip.files)) {
    if (file.dir || !/\.(xml|rels)$/i.test(file.name)) continue;
    const original = await file.async('string');
    let text = original.replace(BOM_RE, '');
    if (/\.rels$/i.test(file.name)) {
      text = relativizeTargets(file.name, text);
    } else if (PREFIXED_NS_RE.test(text) && !DEFAULT_NS_RE.test(text)) {
      text = text
        .replace(/<(\/?)x:/g, '<$1')
        .replace(new RegExp(PREFIXED_NS_RE.source, 'g'), ` xmlns="${SPREADSHEET_NS}"`);
    }
    if (text !== original) {
      zip.file(file.name, text);
      changed = true;
    }
  }
  if (!changed) return null;
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * `xl/_rels/workbook.xml.rels` describe las relaciones de `xl/workbook.xml`:
 * un destino absoluto `/xl/styles.xml` pasa a `styles.xml`; en
 * `xl/worksheets/_rels/sheet1.xml.rels`, `/xl/tables/table1.xml` pasa a
 * `../tables/table1.xml`. Los destinos externos (enlaces) no se tocan.
 */
function relativizeTargets(relsPath: string, text: string): string {
  const source = relsPath.replace(/(^|\/)_rels\/([^/]+)\.rels$/i, '$1$2');
  const base = posix.dirname(source);
  return text.replace(
    /(<Relationship\b[^>]*?\bTarget=")\/([^"]*)"/g,
    (_m, head: string, target) => {
      const rel = posix.relative(base === '.' ? '' : base, target as string);
      return `${head}${rel}"`;
    },
  );
}
