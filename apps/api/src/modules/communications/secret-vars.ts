/**
 * Valores sensibles dentro de un envío (p. ej. el PIN de acceso). El correo
 * tiene que llevarlos, pero el historial de Comunicaciones no: cualquier
 * usuario del panel con permiso de lectura lo ve.
 *
 * Al encolar, cada valor sensible se sustituye por una marca antes de
 * renderizar; el cuerpo guardado lleva la marca y el valor real va cifrado
 * aparte. Al enviar se pone el valor real; al mostrarlo, `••••`.
 */

export const SECRET_MASK = '••••';
const MARKER_RE = /\[\[SECRET-\d+\]\]/g;

const marker = (i: number): string => `[[SECRET-${i}]]`;

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    if (!next || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

/**
 * Separa los valores sensibles de las variables.
 * - `forRender`: variables con una marca en lugar de cada valor sensible.
 * - `forStorage`: variables con `••••` (lo que se guarda en la fila).
 * - `secrets`: marca → valor real (a cifrar), o null si no había ninguno.
 */
export function extractSecrets(
  variables: Record<string, unknown>,
  paths: string[],
): {
  forRender: Record<string, unknown>;
  forStorage: Record<string, unknown>;
  secrets: Record<string, string> | null;
} {
  const forRender = structuredClone(variables);
  const forStorage = structuredClone(variables);
  const secrets: Record<string, string> = {};
  paths.forEach((path, i) => {
    const value = getPath(variables, path);
    if (value === undefined || value === null || value === '') return;
    const m = marker(i);
    secrets[m] = String(value);
    setPath(forRender, path, m);
    setPath(forStorage, path, SECRET_MASK);
  });
  return { forRender, forStorage, secrets: Object.keys(secrets).length > 0 ? secrets : null };
}

/** Pone los valores reales en lugar de las marcas (solo al enviar). */
export function fillSecrets(text: string, secrets: Record<string, string>): string {
  return text.replace(MARKER_RE, (m) => secrets[m] ?? SECRET_MASK);
}

/** Tapa las marcas para mostrar el envío (historial, API). */
export function maskSecrets(text: string): string {
  return text.replace(MARKER_RE, SECRET_MASK);
}
