import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema';

/**
 * Firmas de "magic bytes" de los tipos MIME que aceptan las subidas
 * presignadas de este proyecto. Las URLs PUT firmadas NO protegen el
 * `Content-Type` (solo firman `host`; verificado empíricamente contra el SDK
 * de S3/MinIO — es una limitación conocida de `@aws-sdk/s3-request-presigner`,
 * no un descuido nuestro) — cualquiera con la URL puede subir bytes con un
 * `Content-Type` distinto al declarado al pedirla. `assertObjectMimeType`
 * comprueba los bytes REALES tras la subida, antes de que el "register"
 * correspondiente persista la key en BD.
 */
const MAGIC_BYTE_CHECKS: Record<string, (buf: Buffer) => boolean> = {
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) =>
    b.length >= 12 &&
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP',
  'application/pdf': (b) => b.length >= 4 && b.subarray(0, 4).toString('ascii') === '%PDF',
};

interface PresignArgs {
  bucket: 'plans' | 'uploads' | 'invoices' | 'reports' | 'public';
  key: string;
  contentType: string;
  contentLengthRange?: { min: number; max: number };
  /** TTL del uploadUrl en segundos. */
  expiresIn?: number;
}

/**
 * Cliente S3 compatible apuntando a MinIO. Genera URLs firmadas PUT para
 * que el frontend suba archivos directamente al storage sin pasar por la
 * API (ahorra ancho de banda + memoria del backend).
 *
 * Las claves se forman como `<tenantId>/<facilityId>/<floorId>-<uuid>.<ext>`
 * — incluyen el tenant para defensa en profundidad: incluso si alguien
 * acertara una key de otro tenant, las URLs firmadas son distintas.
 */
@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger(FilesService.name);
  private readonly s3: S3Client;
  private readonly publicUrl: string;
  private readonly bucketMap: Record<PresignArgs['bucket'], string>;

  constructor(config: ConfigService<Env, true>) {
    const endpoint = `${config.get('MINIO_USE_SSL', { infer: true }) ? 'https' : 'http'}://${config.get('MINIO_ENDPOINT', { infer: true })}:${config.get('MINIO_PORT', { infer: true })}`;
    this.s3 = new S3Client({
      region: 'us-east-1', // MinIO ignora region pero el SDK la exige.
      endpoint,
      credentials: {
        accessKeyId: config.get('MINIO_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('MINIO_SECRET_KEY', { infer: true }),
      },
      forcePathStyle: true, // MinIO requiere path-style (no virtual-hosted).
    });
    this.publicUrl = config.get('MINIO_PUBLIC_URL', { infer: true });
    this.bucketMap = {
      uploads: config.get('MINIO_BUCKET_UPLOADS', { infer: true }),
      invoices: config.get('MINIO_BUCKET_INVOICES', { infer: true }),
      plans: config.get('MINIO_BUCKET_PLANS', { infer: true }),
      reports: config.get('MINIO_BUCKET_REPORTS', { infer: true }),
      public: config.get('MINIO_BUCKET_PUBLIC', { infer: true }),
    };
  }

  async onModuleInit(): Promise<void> {
    // Asegura que los buckets existen al arrancar. En dev el sidecar
    // `createbuckets` ya los crea; este check es idempotente.
    for (const bucket of Object.values(this.bucketMap)) {
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        try {
          await this.s3.send(new CreateBucketCommand({ Bucket: bucket }));
          this.logger.log(`Bucket ${bucket} creado`);
        } catch (err) {
          this.logger.warn(`No se pudo crear bucket ${bucket}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Comprobación de salud de MinIO/S3 (HeadBucket del bucket de uploads). */
  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucketMap.uploads }));
  }

  /** Genera una URL firmada PUT para subir directamente desde el navegador. */
  async getPresignedPutUrl(args: PresignArgs): Promise<{ uploadUrl: string; expiresIn: number }> {
    const expiresIn = args.expiresIn ?? 300;
    const cmd = new PutObjectCommand({
      Bucket: this.bucketMap[args.bucket],
      Key: args.key,
      ContentType: args.contentType,
      ...(args.contentLengthRange?.max
        ? { ContentLength: undefined } // se valida en el cliente; MinIO no soporta size en presign
        : {}),
    });
    const uploadUrl = await getSignedUrl(this.s3, cmd, { expiresIn });
    return { uploadUrl, expiresIn };
  }

  /** Devuelve la URL publica (no firmada) para servir el objeto. */
  buildPublicUrl(bucket: PresignArgs['bucket'], key: string): string {
    const bucketName = this.bucketMap[bucket];
    return `${this.publicUrl}/${bucketName}/${key}`;
  }

  /**
   * Dada una URL construida con `buildPublicUrl` sobre un bucket PRIVADO (p. ej.
   * el `signed_pdf_url` del contrato), devuelve una URL firmada GET temporal
   * para descargarla. `null` si la URL no corresponde a ese bucket.
   */
  async presignFromPublicUrl(
    bucket: PresignArgs['bucket'],
    publicUrl: string,
    expiresIn = 300,
  ): Promise<string | null> {
    const prefix = `${this.publicUrl}/${this.bucketMap[bucket]}/`;
    if (!publicUrl.startsWith(prefix)) return null;
    const key = publicUrl.slice(prefix.length);
    return this.getPresignedGetUrl(bucket, key, expiresIn);
  }

  /**
   * URL firmada GET para servir un objeto de un bucket PRIVADO (evidencia:
   * fotos de check-out, documentos…). TTL corto; el cliente la usa en un <img>.
   */
  async getPresignedGetUrl(
    bucket: PresignArgs['bucket'],
    key: string,
    expiresIn = 300,
  ): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucketMap[bucket], Key: key });
    return getSignedUrl(this.s3, cmd, { expiresIn });
  }

  /** Genera una key para una foto de inspección de contrato (check-in/check-out). */
  buildInspectionPhotoKey(
    tenantId: string,
    contractId: string,
    kind: string,
    mimeType: string,
  ): string {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    return `${tenantId}/contracts/${contractId}/${kind}/${randomUUID()}.${ext}`;
  }

  /**
   * Sube bytes al bucket desde el servidor (p. ej. el snapshot de un evento de
   * cámara recibido por la ingesta). Devuelve la key almacenada.
   */
  async putObject(args: {
    bucket: PresignArgs['bucket'];
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketMap[args.bucket],
        Key: args.key,
        Body: args.body,
        ContentType: args.contentType,
      }),
    );
    return args.key;
  }

  /** Descarga un objeto a memoria (bytes). Para procesar server-side (p. ej. foto facial). */
  async getObject(args: { bucket: PresignArgs['bucket']; key: string }): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucketMap[args.bucket], Key: args.key }),
    );
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  /**
   * Comprueba que el objeto YA SUBIDO (vía URL presignada) tiene bytes reales
   * de alguno de los `allowedMimeTypes` — defensa contra un `Content-Type`
   * declarado falso al pedir la URL (ver comentario de `MAGIC_BYTE_CHECKS`).
   * Se llama en cada endpoint "register" (el que persiste la key en BD),
   * DESPUÉS de la comprobación de prefijo y ANTES de guardar nada — así un
   * upload con contenido falseado nunca llega a activarse en la app, aunque
   * exista un instante como objeto huérfano en el bucket. Descarga solo los
   * primeros bytes (suficientes para cualquier firma soportada), no el
   * fichero completo. Lanza 400 `invalid_file_content` si no coincide con
   * ninguno.
   *
   * Si el objeto directamente NO EXISTE en el bucket (nunca se llegó a subir
   * nada a esa key — p. ej. el cliente pidió la URL pero abandonó antes de
   * subir), no es el escenario que esto defiende (no hay contenido falseado
   * que validar: sin bytes, no hay nada que servir tampoco) — se deja pasar
   * en vez de reventar con un error de S3 sin relación. El caso real que
   * cierra este check es "hay bytes, y no son del tipo que dicen ser".
   */
  async assertObjectMimeType(
    bucket: PresignArgs['bucket'],
    key: string,
    allowedMimeTypes: readonly string[],
  ): Promise<void> {
    let bytes: Buffer;
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucketMap[bucket], Key: key, Range: 'bytes=0-31' }),
      );
      bytes = Buffer.from(await res.Body!.transformToByteArray());
    } catch (err) {
      const code = (err as { name?: string })?.name;
      if (code === 'NoSuchKey' || code === 'NotFound') return;
      throw err;
    }
    const matches = allowedMimeTypes.some((mime) => MAGIC_BYTE_CHECKS[mime]?.(bytes));
    if (!matches) {
      throw new BadRequestException({
        code: 'invalid_file_content',
        message: 'El contenido del fichero no coincide con un tipo permitido',
      });
    }
  }

  /** Key para el snapshot de un evento de cámara (bucket privado `uploads`). */
  buildCameraSnapshotKey(tenantId: string, cameraDeviceId: string, mimeType: string): string {
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    return `${tenantId}/cameras/${cameraDeviceId}/${randomUUID()}.${ext}`;
  }

  /** Genera una key unica para un plano de planta. */
  buildFloorPlanKey(
    tenantId: string,
    facilityId: string,
    floorId: string,
    mimeType: string,
  ): string {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    return `${tenantId}/${facilityId}/floors/${floorId}-${randomUUID()}.${ext}`;
  }

  /** Genera una key unica para una imagen del local (landing pública). */
  buildFacilityImageKey(tenantId: string, facilityId: string, mimeType: string): string {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    return `${tenantId}/${facilityId}/images/${randomUUID()}.${ext}`;
  }

  /** Genera una key única para la portada de una entrada de blog (landing pública). */
  buildBlogCoverImageKey(tenantId: string, postId: string, mimeType: string): string {
    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    return `${tenantId}/blog/${postId}/${randomUUID()}.${ext}`;
  }

  /** Genera una key para documentos del cliente. */
  buildCustomerDocumentKey(
    tenantId: string,
    customerId: string,
    mimeType: string,
    originalName: string,
  ): string {
    const ext = this.extFromMime(mimeType, originalName);
    return `${tenantId}/customers/${customerId}/${randomUUID()}.${ext}`;
  }

  /** Genera una key para PDFs de contratos. */
  buildContractPdfKey(tenantId: string, contractId: string): string {
    return `${tenantId}/contracts/${contractId}-${randomUUID()}.pdf`;
  }

  private extFromMime(mimeType: string, fallbackName: string): string {
    switch (mimeType) {
      case 'image/png':
        return 'png';
      case 'image/jpeg':
        return 'jpg';
      case 'image/webp':
        return 'webp';
      case 'application/pdf':
        return 'pdf';
      default: {
        const dot = fallbackName.lastIndexOf('.');
        return dot >= 0 ? fallbackName.slice(dot + 1).toLowerCase() : 'bin';
      }
    }
  }
}
