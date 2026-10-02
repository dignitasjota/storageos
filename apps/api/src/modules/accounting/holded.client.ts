/**
 * Cliente HTTP de la API v2 de Holded (https://api.holded.com/api/v2,
 * `Authorization: Bearer`). Una instancia por tenant (cada uno con su clave).
 * No es un provider de Nest.
 *
 * La v1 (`/api/invoicing/v1`, cabecera `key`) está obsoleta desde junio de 2026
 * y las claves nuevas (`pat_…`) solo autentican contra la v2.
 *
 * Referencia: https://api.holded.com/openapi/api2.json
 */
const DEFAULT_BASE = 'https://api.holded.com/api/v2';

/** Base de la API: configurable solo para los tests (Holded simulado en local). */
export function holdedApiBase(): string {
  return process.env.HOLDED_API_BASE || DEFAULT_BASE;
}

export interface HoldedContactInput {
  name: string;
  /** NIF/CIF del contacto. */
  code?: string;
  email?: string;
  isPerson: boolean;
}

export interface HoldedLine {
  name: string;
  units: number;
  /** Precio unitario sin impuestos. */
  price: number;
  /** Claves de impuesto de Holded (p. ej. `s_iva_21`). */
  taxes: string[];
}

export interface HoldedDocumentInput {
  contactId: string;
  /** YYYY-MM-DD. */
  date: string;
  dueDate?: string | null;
  /** Serie de numeración (debe estar excluida de Veri*Factu). */
  seriesId: string;
  /** Texto impreso en el documento (lleva el número legal de TrasterOS). */
  description: string;
  notes?: string;
  lines: HoldedLine[];
}

export interface HoldedSeries {
  id: string;
  name: string;
  format: string;
  verifactuExcluded: boolean;
}

export interface HoldedTax {
  key: string;
  amount: number;
}

export class HoldedApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class HoldedClient {
  private taxesCache: HoldedTax[] | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly base: string = holdedApiBase(),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new HoldedApiError(
        `Holded: error de red (${err instanceof Error ? err.message : String(err)})`,
        0,
      );
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const j = json as { detail?: string; title?: string; message?: string };
      const info = j.detail ?? j.title ?? j.message ?? `HTTP ${res.status}`;
      const hint =
        res.status === 401
          ? ' (comprueba la API key: Holded solo acepta claves nuevas «pat_…» de la API v2)'
          : '';
      throw new HoldedApiError(`Holded: ${info}${hint}`, res.status);
    }
    return json as T;
  }

  /** Verifica la API key con una llamada ligera. Lanza si es inválida. */
  async testConnection(): Promise<void> {
    await this.request('GET', '/contacts?limit=1');
  }

  /** Series de numeración de un tipo de documento. */
  async listSeries(type: 'invoice' | 'creditnote'): Promise<HoldedSeries[]> {
    const r = await this.request<{
      items?: { id: string; name: string; format: string; verifactu_excluded?: boolean }[];
    }>('GET', `/numbering-series/${type}`);
    return (r.items ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      format: s.format,
      verifactuExcluded: s.verifactu_excluded === true,
    }));
  }

  /** Impuestos de la cuenta (para traducir un % de IVA a su clave). */
  async listTaxes(): Promise<HoldedTax[]> {
    if (this.taxesCache) return this.taxesCache;
    const r = await this.request<{ items?: { key: string; amount: unknown }[] }>('GET', '/taxes');
    this.taxesCache = (r.items ?? [])
      .filter((t) => typeof t.key === 'string')
      .map((t) => ({ key: t.key, amount: Number(t.amount) }));
    return this.taxesCache;
  }

  /**
   * Clave de IVA repercutido (`s_…`) para un porcentaje. Lanza si la cuenta no
   * tiene ninguna: sin clave, Holded aplicaría el IVA por defecto del contacto.
   */
  async taxKeyFor(rate: number): Promise<string> {
    const taxes = await this.listTaxes();
    const sales = taxes.filter((t) => t.key.startsWith('s_') && Math.abs(t.amount - rate) < 0.001);
    const pick =
      sales.find((t) => t.key.startsWith('s_iva')) ??
      sales.find((t) => !t.key.startsWith('s_rec')) ??
      sales[0];
    if (!pick) {
      throw new HoldedApiError(
        `Holded: no hay un impuesto de venta del ${rate} % en la cuenta (créalo en Holded)`,
        422,
      );
    }
    return pick.key;
  }

  /** Busca un contacto por NIF o email. Devuelve su id o null. */
  async findContact(code?: string, email?: string): Promise<string | null> {
    for (const [field, value] of [
      ['code', code],
      ['email', email],
    ] as const) {
      if (!value) continue;
      const r = await this.request<{ items?: { id: string }[] }>(
        'GET',
        `/contacts?${field}=${encodeURIComponent(value)}&limit=1`,
      );
      if (r.items?.[0]) return r.items[0].id;
    }
    return null;
  }

  /** Busca un contacto por nombre exacto (sin distinguir mayúsculas). */
  async findContactByName(name: string): Promise<string | null> {
    const r = await this.request<{ items?: { id: string; name: string }[] }>(
      'GET',
      `/contacts/search?name=${encodeURIComponent(name)}&limit=25`,
    );
    const match = (r.items ?? []).find((c) => c.name.toLowerCase() === name.toLowerCase());
    return match?.id ?? null;
  }

  async createContact(input: HoldedContactInput): Promise<string> {
    const r = await this.request<{ id: string }>('POST', '/contacts', {
      name: input.name,
      ...(input.code ? { code: input.code } : {}),
      ...(input.email ? { email: input.email } : {}),
      type: 'client',
      is_person: input.isPerson,
    });
    return r.id;
  }

  /**
   * Crea una factura (o rectificativa) en su serie, SIN aprobar. Devuelve su id.
   * Se aprueba aparte (`approveDocument`) para poder guardar el id antes: así un
   * fallo al aprobar no hace que se cree otra copia al reintentar.
   */
  async createDocument(
    kind: 'invoice' | 'creditnote',
    input: HoldedDocumentInput,
  ): Promise<string> {
    const items = input.lines.map((l) => ({
      name: l.name,
      units: l.units,
      price: l.price,
      taxes: l.taxes,
    }));
    const path = kind === 'invoice' ? '/invoices' : '/credit-notes';
    const r = await this.request<{ id: string }>('POST', path, {
      contact_id: input.contactId,
      date: input.date,
      ...(input.dueDate ? { due_date: input.dueDate } : {}),
      number_line_id: input.seriesId,
      description: input.description,
      ...(input.notes ? { notes: input.notes } : {}),
      tags: ['trasteros'],
      items,
    });
    return r.id;
  }

  /**
   * Aprueba el documento: genera los asientos contables. La serie está excluida
   * de Veri*Factu, así que aprobarlo no lo registra en la AEAT.
   */
  async approveDocument(kind: 'invoice' | 'creditnote', documentId: string): Promise<void> {
    const path = kind === 'invoice' ? '/invoices' : '/credit-notes';
    await this.request('POST', `${path}/${documentId}/approve`);
  }

  /** Registra un cobro de la factura. */
  async addInvoicePayment(
    invoiceId: string,
    input: { amount: number; date: string; description?: string },
  ): Promise<void> {
    await this.request('POST', `/invoices/${invoiceId}/payments`, {
      amount: input.amount.toFixed(2),
      date: input.date,
      ...(input.description ? { description: input.description } : {}),
    });
  }

  /** Cancela una factura (Holded responde 422 si ya está cobrada). */
  async cancelInvoice(invoiceId: string): Promise<void> {
    await this.request('POST', `/invoices/${invoiceId}/cancel`);
  }
}
