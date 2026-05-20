import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import { JOB_WEBHOOK_DELIVER, QUEUE_WEBHOOKS } from '../queues/queues.module';

import { buildWebhookSignature, WebhooksService, type DeliverJobData } from './webhooks.service';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Worker BullMQ que entrega un `WebhookDelivery` haciendo POST a la URL
 * configurada por el tenant. Si el endpoint responde 2xx, marca el
 * delivery como `success`. Si responde 4xx/5xx, timeout o error de red,
 * incrementa `attempts` y deja que BullMQ programe el reintento
 * exponencial (60s, 5min, 30min). Tras 3 intentos, marca `failed` y no
 * vuelve a reintentar.
 */
@Processor(QUEUE_WEBHOOKS, { concurrency: 5 })
export class WebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhooksProcessor.name);

  constructor(private readonly service: WebhooksService) {
    super();
  }

  async process(job: Job<DeliverJobData>): Promise<void> {
    if (job.name !== JOB_WEBHOOK_DELIVER) {
      this.logger.warn(`Job desconocido en ${QUEUE_WEBHOOKS}: ${job.name}`);
      return;
    }
    const { deliveryId } = job.data;
    // attemptsMade incluye el intento actual una vez completado el handler;
    // para los markers usamos el "intento numero N" 1-based.
    const attemptNumber = (job.attemptsMade ?? 0) + 1;

    const row = await this.service.findDeliveryForProcessing(deliveryId);
    if (!row) {
      this.logger.warn(`Delivery ${deliveryId} no encontrado, skip`);
      return;
    }
    if (row.status === 'success') {
      return;
    }
    const secret = this.service.decryptWebhookSecret(row.webhook.secret);
    // Recalcular la firma sobre el body que vamos a enviar AHORA. El
    // payload original viaja como JSONB y Postgres puede reordenar las
    // claves, por lo que `row.signature` calculado en dispatch puede ya no
    // coincidir con `JSON.stringify(row.payload)` actual. Para que el
    // receptor pueda validar el HMAC, firmamos lo que efectivamente
    // ponemos en el body de la peticion.
    const { header: signatureHeader, body } = buildWebhookSignature({
      secret,
      payload: row.payload,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(row.webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Storageos-Signature': signatureHeader,
          'X-Storageos-Event': row.eventType,
          'X-Storageos-Delivery': row.id,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const isFinal = attemptNumber >= MAX_ATTEMPTS;
      await this.service.markDeliveryAttempt({
        deliveryId,
        statusCode: null,
        errorMessage: msg,
        attempts: attemptNumber,
        isFinal,
        signature: signatureHeader,
      });
      if (!isFinal) throw err;
      return;
    }
    clearTimeout(timer);
    const text = await safeReadText(res);
    if (res.status >= 200 && res.status < 300) {
      await this.service.markDeliverySuccess({
        deliveryId,
        statusCode: res.status,
        responseBody: text,
        attempts: attemptNumber,
        signature: signatureHeader,
      });
      return;
    }
    const isFinal = attemptNumber >= MAX_ATTEMPTS;
    await this.service.markDeliveryAttempt({
      deliveryId,
      statusCode: res.status,
      errorMessage: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      attempts: attemptNumber,
      isFinal,
      signature: signatureHeader,
    });
    if (!isFinal) {
      // Throw para que BullMQ programe el siguiente intento con backoff
      // exponencial. La fila ya quedo persistida con status='pending' y
      // el attemptNumber actual.
      throw new Error(`HTTP ${res.status}`);
    }
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t ?? '';
  } catch {
    return '';
  }
}
