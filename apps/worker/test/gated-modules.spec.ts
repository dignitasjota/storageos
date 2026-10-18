import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Los crons y processors de BullMQ del API se registran solo con
 * `WORKERS_ENABLED_IN_API` y en producción el API lo tiene apagado: si el
 * worker no importa el módulo, esas tareas NO corren nunca (le pasó al cron
 * que retira los descuentos de retención). Cada módulo con ese flag tiene que
 * estar en `WorkerModule`.
 */
const MODULES_DIR = join(__dirname, '../../api/src/modules');

function moduleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return moduleFiles(path);
    return name.endsWith('.module.ts') ? [path] : [];
  });
}

describe('WorkerModule', () => {
  it('importa todos los módulos del API con crons o processors gateados', () => {
    const worker = readFileSync(join(__dirname, '../src/worker.module.ts'), 'utf8');
    const missing = moduleFiles(MODULES_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes('WORKERS_ENABLED_IN_API'))
      .map((file) => /export class (\w+)/.exec(readFileSync(file, 'utf8'))?.[1])
      .filter((name): name is string => !!name && !new RegExp(`\\b${name}\\b`).test(worker));
    expect(missing).toEqual([]);
  });
});
