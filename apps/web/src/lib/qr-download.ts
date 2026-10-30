/** Descarga como PNG el QR dibujado en el `<canvas id={canvasId}>` (para imprimirlo). */
export function downloadQrPng(canvasId: string, name: string): void {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas) return;
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `qr-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
  a.click();
}
