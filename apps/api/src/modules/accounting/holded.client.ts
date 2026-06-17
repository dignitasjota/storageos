/**
 * Cliente HTTP de la API de Holded (facturación). Una instancia por tenant
 * (cada tenant usa su propia API key). No es un provider de Nest.
 *
 * Docs: https://developers.holded.com/reference — auth por header `key`.
 */
const DEFAULT_BASE = 'https://api.holded.com/api/invoicing/v1';

export interface HoldedContactInput {
  name: string;
  /** NIF/CIF del contacto (campo `code` en Holded). */
  code?: string;
  email?: string;
  isPerson: boolean;
}

export interface HoldedInvoiceItem {
  name: string;
  units: number;
  price: number;
  /** % de IVA (p. ej. 21). */
  tax: number;
}

export interface HoldedInvoiceInput {
  contactId: string;
  /** Fecha de emisión en segundos epoch. */
  date: number;
  items: HoldedInvoiceItem[];
  notes?: string;
}

interface HoldedContact {
  id: string;
  code?: string;
  email?: string;
}

export class HoldedClient {
  constructor(
    private readonly apiKey: string,
    private readonly base: string = DEFAULT_BASE,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          key: this.apiKey,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new Error(`Holded: error de red (${err instanceof Error ? err.message : String(err)})`);
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const info =
        (json as { info?: string; message?: string })?.info ??
        (json as { message?: string })?.message ??
        `HTTP ${res.status}`;
      throw new Error(`Holded: ${info}`);
    }
    // Holded devuelve { status: 0, info } en errores lógicos con HTTP 200.
    if (
      json &&
      typeof json === 'object' &&
      'status' in json &&
      (json as { status: number }).status === 0
    ) {
      throw new Error(`Holded: ${(json as { info?: string }).info ?? 'operación rechazada'}`);
    }
    return json as T;
  }

  /** Verifica la API key con una llamada ligera. Lanza si es inválida. */
  async testConnection(): Promise<void> {
    await this.request('GET', '/contacts?page=1');
  }

  /** Busca un contacto por NIF (code) o email. Devuelve su id o null. */
  async findContact(code?: string, email?: string): Promise<string | null> {
    if (!code && !email) return null;
    const list = await this.request<HoldedContact[]>('GET', '/contacts');
    const match = list.find(
      (c) =>
        (code && c.code && c.code.toUpperCase() === code.toUpperCase()) ||
        (email && c.email && c.email.toLowerCase() === email.toLowerCase()),
    );
    return match?.id ?? null;
  }

  async createContact(input: HoldedContactInput): Promise<string> {
    const r = await this.request<{ id: string }>('POST', '/contacts', {
      name: input.name,
      ...(input.code ? { code: input.code } : {}),
      ...(input.email ? { email: input.email } : {}),
      type: 'client',
      isperson: input.isPerson,
    });
    return r.id;
  }

  async createInvoice(input: HoldedInvoiceInput): Promise<string> {
    const r = await this.request<{ id: string }>('POST', '/documents/invoice', {
      contactId: input.contactId,
      date: input.date,
      items: input.items,
      ...(input.notes ? { notes: input.notes } : {}),
    });
    return r.id;
  }
}
