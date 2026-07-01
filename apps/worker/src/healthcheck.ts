/**
 * Healthcheck del contenedor del worker (docker `HEALTHCHECK`).
 *
 * El worker no expone HTTP, pero escribe `workers:heartbeat` en Redis cada
 * minuto (TTL 3 min, `WorkersHeartbeatCron`). Este script comprueba que el
 * latido existe: si el event loop del worker se cuelga (deadlock, Puppeteer…),
 * el latido caduca y el contenedor pasa a `unhealthy` — visible en Portainer
 * en vez de morir en silencio. Complementa a `GET /health/worker` del API.
 */
import IORedis from 'ioredis';

async function main(): Promise<void> {
  const redis = new IORedis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
    db: Number(process.env.REDIS_DB ?? 0),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
  });
  try {
    await redis.connect();
    const beat = await redis.get('workers:heartbeat');
    if (!beat) {
      console.error('healthcheck: sin heartbeat en Redis (worker colgado o recién arrancado)');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error(`healthcheck: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    redis.disconnect();
  }
}

void main();
