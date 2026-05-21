/**
 * Whitelist autoritativa de scopes para API keys (Sub-bloque 15A.3).
 *
 * Mantener sincronizado con `packages/shared/src/integrations/schemas.ts`
 * (`ApiKeyScopes`). Cualquier scope que se aplique con `@RequireScope` debe
 * estar listado aqui, y la creacion de API keys validara que los scopes
 * pedidos por el body pertenecen a esta lista.
 *
 * El valor especial `'*'` (wildcard) se usa internamente cuando una API key
 * se crea sin scopes explicitos para mantener compatibilidad con
 * integraciones existentes (Fase 14A.3). NO debe aparecer en
 * `API_KEY_SCOPES` ni ofrecerse al cliente desde la UI: solo el backend lo
 * normaliza al persistir.
 */
export const API_KEY_SCOPES = [
  'invoices:read',
  'invoices:write',
  'contracts:read',
  'customers:read',
  'webhooks:trigger',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Wildcard interno: bypasea cualquier check de scope. */
export const API_KEY_WILDCARD_SCOPE = '*';

export function isKnownApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}
