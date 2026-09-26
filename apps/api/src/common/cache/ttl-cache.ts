/**
 * Caché en memoria con TTL para agregaciones caras de solo lectura (paneles del
 * super admin). Es por proceso: con varias réplicas cada una guarda su copia,
 * lo que basta para cortar el coste de refrescos repetidos (los paneles
 * re-consultan cada 30-60 s). Las peticiones concurrentes a la misma clave
 * comparten la misma promesa; un fallo no se cachea.
 *
 * En `NODE_ENV=test` el TTL por defecto es 0 (sin caché) para que los e2e que
 * mutan datos y vuelven a leer vean el cambio al instante.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number = process.env.NODE_ENV === 'test' ? 0 : 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > t) return hit.value;

    const value = load();
    this.entries.set(key, { expiresAt: t + this.ttlMs, value });
    value.catch(() => {
      // No cachear errores: la siguiente petición reintenta.
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    // Poda perezosa de entradas caducadas (las claves son pocas: argumentos de periodo).
    if (this.entries.size > 50) {
      for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
