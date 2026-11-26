import { Injectable } from '@nestjs/common';
import {
  SEO_PROVIDER_LABELS,
  SEO_SISTRIX_DATA_TYPES,
  type SeoProviderKey,
  type SeoSistrixDataType,
  type SeoSyncKind,
} from '@storageos/shared';

import { SeoGscSyncService, type SeoSyncActor } from '../seo-gsc-sync.service';
import { SistrixApiClient } from '../sistrix/sistrix-api.client';
import { type SeoPool, SistrixConnectionsService } from '../sistrix/sistrix-connections.service';
import { SistrixDataError } from '../sistrix/sistrix-errors';
import { SistrixMcpClient } from '../sistrix/sistrix-mcp.client';
import {
  type SistrixOutcome,
  type SistrixQuery,
  normalizeSistrix,
  parseMcpResult,
  toApiCall,
  toMcpCall,
} from '../sistrix/sistrix-normalizer';

/**
 * Arquitectura de proveedores de SEO Avanzado. Cada proveedor declara qué
 * tipos de dato sabe dar; el enrutador (`seo-provider-router.ts`) elige uno
 * por proyecto y tipo de dato. Cada dato guardado lleva la clave del
 * proveedor (`gsc`, `sistrix_mcp`, `sistrix_api`, `manual_import`) y la fecha
 * en que se obtuvo.
 */
export type SeoDataKind = 'gsc_performance' | SeoSistrixDataType;

export interface SeoDataProvider {
  readonly key: SeoProviderKey;
  readonly label: string;
  readonly capabilities: readonly SeoDataKind[];
}

/** Proveedor que responde consultas sueltas (SISTRIX por MCP o API). */
export interface SeoQueryProvider extends SeoDataProvider {
  supportsQuery(q: SistrixQuery): boolean;
  query(pool: SeoPool, q: SistrixQuery): Promise<SeoQueryResult>;
}

export interface SeoQueryResult {
  outcome: SistrixOutcome;
  credits: number;
  /** Herramienta del MCP o método de la API, y argumentos (sin secretos). */
  tool: string;
  view: string | null;
  args: Record<string, unknown>;
}

/** Proveedor con su propia descarga por tandas (Search Console). */
export interface SeoSyncProvider extends SeoDataProvider {
  enqueue(domainId: string, kind: SeoSyncKind, actor: SeoSyncActor): Promise<string>;
}

/** Search Console: envuelve la descarga de la PR 1 sin cambiarla. */
@Injectable()
export class GscSeoProvider implements SeoSyncProvider {
  readonly key = 'gsc' as const;
  readonly label = SEO_PROVIDER_LABELS.gsc;
  readonly capabilities = ['gsc_performance'] as const;

  constructor(private readonly gsc: SeoGscSyncService) {}

  enqueue(domainId: string, kind: SeoSyncKind, actor: SeoSyncActor): Promise<string> {
    return this.gsc.enqueue(domainId, kind, actor);
  }
}

/** SISTRIX por MCP con la cuenta de la plataforma (solo el fondo de la plataforma). */
@Injectable()
export class SistrixMcpProvider implements SeoQueryProvider {
  readonly key = 'sistrix_mcp' as const;
  readonly label = SEO_PROVIDER_LABELS.sistrix_mcp;
  readonly capabilities = SEO_SISTRIX_DATA_TYPES;

  constructor(private readonly mcp: SistrixMcpClient) {}

  supportsQuery(): boolean {
    return true;
  }

  async query(_pool: SeoPool, q: SistrixQuery): Promise<SeoQueryResult> {
    const call = toMcpCall(q);
    const raw = await this.mcp.callTool(call.tool, call.args);
    return {
      outcome: normalizeSistrix(q.op, parseMcpResult(raw)),
      credits: 0,
      tool: call.tool,
      view: typeof call.args.view === 'string' ? call.args.view : null,
      args: call.args,
    };
  }
}

/** SISTRIX por la API clásica (clave de la plataforma o del tenant; gasta créditos). */
@Injectable()
export class SistrixApiProvider implements SeoQueryProvider {
  readonly key = 'sistrix_api' as const;
  readonly label = SEO_PROVIDER_LABELS.sistrix_api;
  readonly capabilities = SEO_SISTRIX_DATA_TYPES.filter((t) => t !== 'ai_visibility');

  constructor(
    private readonly api: SistrixApiClient,
    private readonly connections: SistrixConnectionsService,
  ) {}

  supportsQuery(q: SistrixQuery): boolean {
    return toApiCall(q) !== null;
  }

  async query(pool: SeoPool, q: SistrixQuery): Promise<SeoQueryResult> {
    const call = toApiCall(q);
    if (!call)
      throw new SistrixDataError('Este dato no se puede pedir por la API', 'not_supported');
    const conn = await this.connections.find(pool, 'sistrix_api');
    const key = this.connections.apiKeyOf(conn);
    if (!conn || !key) throw new SistrixDataError('No hay clave de API de SISTRIX', 'no_key');
    const res = await this.api.call(key, call.method, call.params);
    await this.connections.addSpent(conn.id, res.credits);
    return {
      outcome: normalizeSistrix(q.op, res.payload),
      credits: res.credits,
      tool: call.method,
      view: null,
      // La clave nunca va en el registro.
      args: { ...call.params },
    };
  }
}

/** Lo subido a mano (Excel de Search Console, CSV de SISTRIX): solo origen del dato. */
@Injectable()
export class ManualImportProvider implements SeoDataProvider {
  readonly key = 'manual_import' as const;
  readonly label = SEO_PROVIDER_LABELS.manual_import;
  readonly capabilities = ['gsc_performance', 'domain_keywords', 'serp', 'competitors'] as const;
}

/** Registro de proveedores: por clave y por tipo de dato. */
@Injectable()
export class SeoProviderRegistry {
  private readonly providers: SeoDataProvider[];

  constructor(
    readonly gsc: GscSeoProvider,
    readonly sistrixMcp: SistrixMcpProvider,
    readonly sistrixApi: SistrixApiProvider,
    readonly manualImport: ManualImportProvider,
  ) {
    this.providers = [gsc, sistrixMcp, sistrixApi, manualImport];
  }

  all(): readonly SeoDataProvider[] {
    return this.providers;
  }

  get(key: SeoProviderKey): SeoDataProvider | undefined {
    return this.providers.find((p) => p.key === key);
  }

  query(key: 'sistrix_mcp' | 'sistrix_api'): SeoQueryProvider {
    return key === 'sistrix_mcp' ? this.sistrixMcp : this.sistrixApi;
  }

  forKind(kind: SeoDataKind): SeoDataProvider[] {
    return this.providers.filter((p) => (p.capabilities as readonly string[]).includes(kind));
  }
}
