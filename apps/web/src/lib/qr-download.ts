/** Descarga como PNG el QR dibujado en el `<canvas id={canvasId}>` (para imprimirlo). */
export function downloadQrPng(canvasId: string, name: string): void {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas) return;
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `qr-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
  a.click();
}

/** Descarga como SVG (vectorial: se amplía sin perder calidad) el QR del `<svg id={svgId}>`. */
export function downloadQrSvg(svgId: string, name: string): void {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `qr-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
