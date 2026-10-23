type PuppeteerModule = typeof import('puppeteer');

/**
 * Puppeteer 25 solo se publica como ESM. Con `module: commonjs`, TypeScript
 * convierte `await import('puppeteer')` en `require()`, que Node 20 no admite
 * para ESM (fallaban todos los PDF). `new Function` conserva el `import()` nativo.
 */
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<PuppeteerModule>;

export async function loadPuppeteer(): Promise<PuppeteerModule['default']> {
  return (await nativeImport('puppeteer')).default;
}
