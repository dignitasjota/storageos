import { FilesService } from '../files.service';

import type { ConfigService } from '@nestjs/config';

/** Config como en producción: MinIO interno en Docker y URL pública por el proxy. */
function makeService(publicUrl: string): FilesService {
  const values: Record<string, unknown> = {
    MINIO_ENDPOINT: 'minio',
    MINIO_PORT: 9000,
    MINIO_USE_SSL: false,
    MINIO_ACCESS_KEY: 'key',
    MINIO_SECRET_KEY: 'secret',
    MINIO_PUBLIC_URL: publicUrl,
    MINIO_BUCKET_UPLOADS: 'storageos-uploads',
    MINIO_BUCKET_INVOICES: 'storageos-invoices',
    MINIO_BUCKET_PLANS: 'storageos-plans',
    MINIO_BUCKET_REPORTS: 'storageos-reports',
    MINIO_BUCKET_PUBLIC: 'storageos-public',
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService<never, true>;
  return new FilesService(config as never);
}

describe('FilesService — URLs firmadas para el navegador', () => {
  it('firma la subida con la URL pública, no con el host interno de Docker', async () => {
    const files = makeService('https://files.trasteros.pro/');
    const { uploadUrl } = await files.getPresignedPutUrl({
      bucket: 'plans',
      key: 't/f/floors/x.png',
      contentType: 'image/png',
    });
    expect(
      uploadUrl.startsWith('https://files.trasteros.pro/storageos-plans/t/f/floors/x.png?'),
    ).toBe(true);
    expect(uploadUrl).not.toContain('minio:9000');
    expect(uploadUrl).toContain('X-Amz-Signature=');
  });

  it('firma también las descargas de buckets privados con la URL pública', async () => {
    const files = makeService('https://files.trasteros.pro');
    const url = await files.getPresignedGetUrl('invoices', 'a/b.pdf');
    expect(url.startsWith('https://files.trasteros.pro/storageos-invoices/a/b.pdf?')).toBe(true);
    expect(files.buildPublicUrl('public', 'x.jpg')).toBe(
      'https://files.trasteros.pro/storageos-public/x.jpg',
    );
  });
});
