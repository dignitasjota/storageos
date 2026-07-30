/**
 * Calculadora de espacio: estima los m² que necesita el visitante según los
 * objetos que va a guardar, y recomienda el trastero que le encaja. Los m² por
 * objeto son «huella equivalente» aproximada considerando un apilado razonable
 * (~2,3 m de altura útil). Son orientativos — la web lo advierte.
 */

export interface StorageItem {
  key: string;
  label: string;
  /** m² equivalentes que ocupa una unidad de este objeto (con apilado). */
  m2: number;
  category: StorageItemCategory;
}

export type StorageItemCategory = 'muebles' | 'electrodomesticos' | 'cajas' | 'otros';

export const STORAGE_ITEM_CATEGORY_LABELS: Record<StorageItemCategory, string> = {
  muebles: 'Muebles',
  electrodomesticos: 'Electrodomésticos',
  cajas: 'Cajas y enseres',
  otros: 'Otros',
};

/** Catálogo curado de objetos comunes con su huella equivalente en m². */
export const STORAGE_ITEMS: StorageItem[] = [
  // Muebles
  { key: 'sofa_2', label: 'Sofá 2 plazas', m2: 1.0, category: 'muebles' },
  { key: 'sofa_3', label: 'Sofá 3 plazas', m2: 1.5, category: 'muebles' },
  { key: 'cama_ind', label: 'Cama individual', m2: 0.8, category: 'muebles' },
  { key: 'cama_doble', label: 'Cama doble', m2: 1.2, category: 'muebles' },
  { key: 'colchon', label: 'Colchón', m2: 0.5, category: 'muebles' },
  { key: 'armario', label: 'Armario', m2: 1.2, category: 'muebles' },
  { key: 'comoda', label: 'Cómoda / cajonera', m2: 0.5, category: 'muebles' },
  { key: 'mesa', label: 'Mesa de comedor', m2: 0.8, category: 'muebles' },
  { key: 'silla', label: 'Silla', m2: 0.15, category: 'muebles' },
  { key: 'estanteria', label: 'Estantería', m2: 0.5, category: 'muebles' },
  { key: 'escritorio', label: 'Escritorio', m2: 0.6, category: 'muebles' },
  // Electrodomésticos
  { key: 'nevera', label: 'Nevera', m2: 0.5, category: 'electrodomesticos' },
  { key: 'lavadora', label: 'Lavadora / secadora', m2: 0.4, category: 'electrodomesticos' },
  { key: 'tv', label: 'Televisión', m2: 0.2, category: 'electrodomesticos' },
  { key: 'microondas', label: 'Microondas / pequeño', m2: 0.15, category: 'electrodomesticos' },
  // Cajas
  { key: 'caja_p', label: 'Caja pequeña', m2: 0.06, category: 'cajas' },
  { key: 'caja_m', label: 'Caja mediana', m2: 0.1, category: 'cajas' },
  { key: 'caja_g', label: 'Caja grande', m2: 0.15, category: 'cajas' },
  { key: 'maleta', label: 'Maleta', m2: 0.15, category: 'cajas' },
  // Otros
  { key: 'bici', label: 'Bicicleta', m2: 0.6, category: 'otros' },
  { key: 'moto', label: 'Moto', m2: 1.5, category: 'otros' },
  { key: 'electrodomestico_grande', label: 'Electrodoméstico grande', m2: 0.5, category: 'otros' },
  { key: 'cuadro', label: 'Cuadro / espejo', m2: 0.1, category: 'otros' },
  { key: 'herramientas', label: 'Caja de herramientas', m2: 0.15, category: 'otros' },
];

const ITEM_BY_KEY = new Map(STORAGE_ITEMS.map((i) => [i.key, i]));

/**
 * Suma los m² de una selección `{ key: cantidad }`, con un 15% de margen de
 * maniobra (pasillo/holgura), redondeado a 1 decimal. Mínimo 0.
 */
export function computeStorageM2(selection: Record<string, number>): number {
  let total = 0;
  for (const [key, qty] of Object.entries(selection)) {
    const item = ITEM_BY_KEY.get(key);
    if (!item || qty <= 0) continue;
    total += item.m2 * qty;
  }
  if (total <= 0) return 0;
  return Math.round(total * 1.15 * 10) / 10;
}

/** Tipo de trastero (nombre + m² + precio) candidato para la recomendación. */
export interface RecommendableUnit {
  name: string;
  areaM2: number | null;
  priceMonthly: number;
  available: number;
}

/**
 * Recomienda el trastero más ajustado: el disponible más pequeño cuyo área
 * cubre los m² necesarios; si ninguno llega, el más grande disponible. Ignora
 * los tipos sin área. Devuelve null si no hay candidatos.
 */
export function recommendStorageUnit<T extends RecommendableUnit>(
  m2Needed: number,
  units: T[],
): T | null {
  const withArea = units
    .filter((u) => u.available > 0 && u.areaM2 != null && u.areaM2 > 0)
    .sort((a, b) => (a.areaM2 as number) - (b.areaM2 as number));
  if (withArea.length === 0) return null;
  const fits = withArea.find((u) => (u.areaM2 as number) >= m2Needed);
  return fits ?? withArea[withArea.length - 1]!;
}
