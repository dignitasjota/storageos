/**
 * Detecta un dominio de correo mal escrito (`ana@gmial.com`, `@gmail.co`,
 * `@hotmial.es`) y propone el bueno. Solo para los proveedores habituales en
 * España: un dominio de empresa no se toca. Es una sugerencia; el que escribe
 * decide.
 */

/** Proveedores y sus terminaciones válidas (la primera es la que se propone). */
const PROVIDERS: Record<string, readonly string[]> = {
  gmail: ['com'],
  googlemail: ['com'],
  hotmail: ['com', 'es', 'fr', 'it', 'de', 'co.uk'],
  outlook: ['com', 'es', 'fr', 'it', 'de'],
  live: ['com', 'es', 'fr', 'it'],
  msn: ['com'],
  yahoo: ['com', 'es', 'fr', 'it', 'de', 'co.uk'],
  ymail: ['com'],
  icloud: ['com'],
  me: ['com'],
  mac: ['com'],
  protonmail: ['com', 'ch'],
  proton: ['me'],
  gmx: ['com', 'es', 'de', 'net'],
  aol: ['com'],
  telefonica: ['net'],
  movistar: ['es'],
  terra: ['es', 'com'],
};

/** Dominios reales que se parecen a uno de la lista y no son un error. */
const OTHER_REAL_DOMAINS = new Set(['mail.com', 'email.com', 'gmx.net', 'live.co.uk']);

/** Distancia de edición contando el intercambio de dos letras como un cambio. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

function isKnownDomain(domain: string): boolean {
  if (OTHER_REAL_DOMAINS.has(domain)) return true;
  const dot = domain.indexOf('.');
  if (dot < 0) return false;
  const tlds = PROVIDERS[domain.slice(0, dot)];
  return !!tlds && tlds.includes(domain.slice(dot + 1));
}

/** Proveedor al que se parece el nombre (antes del primer punto), o null. */
function closestProvider(name: string): string | null {
  if (PROVIDERS[name]) return name;
  // Los proveedores de nombre corto (me, mac, msn, aol, gmx, live) solo si
  // coinciden: «lives» o «gmz» son de otro.
  if (name.length < 4) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const provider of Object.keys(PROVIDERS)) {
    if (provider.length < 5) continue;
    const max = provider.length >= 7 ? 2 : 1;
    const dist = editDistance(name, provider);
    if (dist <= max && dist < bestDistance) {
      best = provider;
      bestDistance = dist;
    }
  }
  return best;
}

/** Terminación válida más parecida a la escrita (o la habitual del proveedor). */
function closestTld(tld: string, allowed: readonly string[]): string {
  if (allowed.includes(tld)) return tld;
  let best = allowed[0]!;
  let bestDistance = Infinity;
  for (const option of allowed) {
    const dist = editDistance(tld, option);
    if (dist < bestDistance) {
      best = option;
      bestDistance = dist;
    }
  }
  return bestDistance <= 2 ? best : allowed[0]!;
}

/**
 * Email corregido si el dominio parece un error al escribir uno conocido;
 * null si está bien, si no es de un proveedor conocido o si aún no tiene «@».
 */
export function suggestEmailFix(email: string): string | null {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).replace(/\.+$/, '');
  if (!domain || isKnownDomain(domain)) return null;

  let fixed: string | null = null;
  const dot = domain.indexOf('.');
  if (dot < 0) {
    // Sin punto: «gmail» o «gmailcom».
    const provider = closestProvider(domain);
    if (provider) {
      fixed = `${provider}.${PROVIDERS[provider]![0]}`;
    } else {
      for (const [name, tlds] of Object.entries(PROVIDERS)) {
        const tld = tlds.find((t) => domain === `${name}${t.replace('.', '')}`);
        if (tld) {
          fixed = `${name}.${tld}`;
          break;
        }
      }
    }
  } else {
    const provider = closestProvider(domain.slice(0, dot));
    if (provider) fixed = `${provider}.${closestTld(domain.slice(dot + 1), PROVIDERS[provider]!)}`;
  }
  if (!fixed || fixed === domain) return null;
  return `${local}@${fixed}`;
}
