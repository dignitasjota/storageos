import { describe, expect, it } from 'vitest';

import { VERIFACTU_SYSTEM } from './verifactu';
import {
  VERIFACTU_DECLARATIONS,
  VERIFACTU_DECLARATION_TITLE,
  verifactuDeclaration,
  verifactuDeclarationDate,
  verifactuDeclarationVersions,
} from './verifactu-declaration';

describe('declaración responsable (art. 15 de la Orden HAC/1177/2024)', () => {
  it('la versión en uso tiene su declaración firmada', () => {
    // Al subir VERIFACTU_SYSTEM.version hay que añadir su declaración.
    const doc = verifactuDeclaration();
    expect(doc).not.toBeNull();
    expect(doc!.version).toBe(VERIFACTU_SYSTEM.version);
    expect(doc!.current).toBe(true);
    expect(doc!.signedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('empieza por su título y lleva cada dato con su texto, en el orden del apartado 1', () => {
    const doc = verifactuDeclaration()!;
    expect(doc.title).toBe('DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN');
    expect(doc.title).toBe(VERIFACTU_DECLARATION_TITLE);
    expect(doc.items.map((i) => i.key)).toEqual(['a', 'b', 'c', 'd', 'f', 'h', 'i', 'j', 'k', 'l']);
    for (const item of doc.items) {
      expect(item.label.length).toBeGreaterThan(5);
      expect(item.value.length).toBeGreaterThan(0);
    }
    const byKey = Object.fromEntries(doc.items.map((i) => [i.key, i.value]));
    expect(byKey.a).toBe('TrasterOS');
    expect(byKey.b).toBe(VERIFACTU_SYSTEM.id);
    expect(byKey.h).toBe('Urbanbox Soluciones SL');
    expect(byKey.i).toBe('B05691886');
    expect(byKey.j).toContain('46920 Mislata');
    expect(byKey.k).toContain(`en la versión ${VERIFACTU_SYSTEM.version}`);
    expect(byKey.k).toContain('Real Decreto 1007/2023');
    expect(byKey.k).toContain('Orden HAC/1177/2024');
    expect(byKey.l).toMatch(/^Mislata \(España\), \d{1,2} de [a-z]+ de \d{4}$/);
    expect(doc.contact.map((c) => c.value)).toEqual([
      'info@trasteros.pro',
      'https://trasteros.pro',
    ]);
  });

  it('una versión sin declaración no tiene documento', () => {
    expect(verifactuDeclaration('0.9')).toBeNull();
  });

  it('las versiones, la más reciente primero, sin repetir', () => {
    const versions = verifactuDeclarationVersions().map((v) => v.version);
    expect(versions[0]).toBe(VERIFACTU_DECLARATIONS.at(-1)!.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('fecha en palabras sin depender de la configuración regional', () => {
    expect(verifactuDeclarationDate('2026-11-11')).toBe('11 de noviembre de 2026');
    expect(verifactuDeclarationDate('2027-01-01')).toBe('1 de enero de 2027');
  });
});
