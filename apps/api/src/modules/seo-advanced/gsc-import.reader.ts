import { GscImportError, type SeoImportFormat, type SeoImportSheet } from '@storageos/shared';
import JSZip from 'jszip';
import Papa from 'papaparse';

import { xlsxSheets } from '../imports/import-engine';

/** CSV como mucho dentro del zip y tamaño total descomprimido (contra los zip «bomba»). */
const MAX_ZIP_ENTRIES = 20;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

/** ¿Ocupa demasiado el .zip (o el .xlsx) una vez descomprimido? Se mira antes de leerlo. */
export async function zipTooLarge(buffer: Buffer): Promise<boolean> {
  const zip = await JSZip.loadAsync(buffer).catch(() => null);
  if (!zip) return false;
  const total = Object.values(zip.files)
    .filter((f) => !f.dir)
    .reduce(
      (n, f) =>
        n +
        ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
      0,
    );
  return total > MAX_UNCOMPRESSED_BYTES;
}

/** BOM del UTF-8 (con el código: el lint no admite el carácter suelto). */
const BOM_RE = new RegExp(`^${String.fromCharCode(0xfeff)}`);

const isZip = (b: Buffer) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/**
 * Lee el fichero que exporta Search Console: el `.xlsx` (un libro con una hoja
 * por pestaña) o el `.zip` con un CSV por pestaña. Se mira el contenido, no la
 * extensión: los dos son zip por dentro y el `.xlsx` lleva `xl/workbook.xml`.
 */
export async function readGscExport(
  buffer: Buffer,
): Promise<{ format: SeoImportFormat; sheets: SeoImportSheet[] }> {
  if (!isZip(buffer)) {
    throw new GscImportError(
      'Sube el fichero tal como lo exporta Search Console: el Excel (.xlsx) o el .zip de CSV.',
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new GscImportError('El fichero está dañado o no es un Excel ni un .zip.');
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const uncompressed = entries.reduce(
    (n, f) =>
      n +
      ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
    0,
  );
  if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
    throw new GscImportError('El fichero ocupa demasiado descomprimido.');
  }
  if (zip.file('xl/workbook.xml')) {
    try {
      return { format: 'xlsx', sheets: await xlsxSheets(buffer) };
    } catch {
      throw new GscImportError(
        'No se ha podido leer el Excel. Vuelve a exportarlo de Search Console.',
      );
    }
  }
  const csvs = entries.filter(
    (f) => /\.csv$/i.test(f.name) && !f.name.startsWith('__MACOSX/') && !/(^|\/)\./.test(f.name),
  );
  if (csvs.length === 0) {
    throw new GscImportError('El .zip no trae ningún CSV de Search Console.');
  }
  if (csvs.length > MAX_ZIP_ENTRIES) {
    throw new GscImportError('El .zip trae demasiados ficheros.');
  }
  const sheets: SeoImportSheet[] = [];
  for (const f of csvs) {
    const text = (await f.async('string')).replace(BOM_RE, '');
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
    sheets.push({
      name: f.name.replace(/^.*\//, ''),
      rows: parsed.data.map((r) => r.map((c) => String(c ?? '').trim())),
    });
  }
  return { format: 'zip', sheets };
}
