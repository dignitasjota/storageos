const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

/**
 * Redimensiona/comprime una imagen EN EL NAVEGADOR antes de subirla. La
 * subida de imágenes va por PUT firmado directo a MinIO (sin pasar por la
 * API, ver `uploadFacilityImage`) y `next.config.mjs` sirve las imágenes
 * `unoptimized` (el dominio de MinIO varía por despliegue) — sin procesado
 * ni en la subida ni al servir, una foto de cámara de varios MB se serviría
 * tal cual en una miniatura de 300-400px. Esta es la única palanca posible
 * sin cambiar esa arquitectura.
 *
 * Recomprime siempre a JPEG (mejor ratio para fotografías; PNG/WebP de
 * entrada también se convierten). Si algo falla (navegador sin soporte,
 * SVG, etc.) o el resultado no mejora, devuelve el fichero original — nunca
 * bloquea la subida.
 */
export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    const name = `${file.name.replace(/\.\w+$/, '')}.jpg`;
    return new File([blob], name, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
