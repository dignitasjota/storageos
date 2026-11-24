/**
 * Lee un fichero de importación del navegador: un CSV como texto o un Excel
 * (.xlsx/.xls) en base64, que el API convierte a CSV.
 */
export function readImportFile(file: File): Promise<{ content: string; format: 'csv' | 'xlsx' }> {
  const isXlsx = /\.xlsx?$/i.test(file.name);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      if (isXlsx) {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        resolve({ content: btoa(bin), format: 'xlsx' });
      } else {
        resolve({ content: String(reader.result ?? ''), format: 'csv' });
      }
    };
    if (isXlsx) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}
