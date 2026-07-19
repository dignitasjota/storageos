import { startBridge } from './bridge';
import { loadConfig } from './config';

/**
 * Entry point del **TrasterOS Bridge**: agente ligero que corre en la LAN del
 * local (Raspberry / mini-PC), se suscribe a los eventos en tiempo real de los
 * equipos Dahua y los reenvía —con su snapshot— al webhook de ingesta de
 * TrasterOS. Resuelve el problema del NAT: la nube no alcanza los equipos, pero
 * el bridge sí, y empuja hacia fuera.
 */
function main(): void {
  const config = loadConfig();
  console.info(`[bridge] arrancando · ${config.devices.length} equipo(s) → ${config.webhookUrl}`);
  const { stop } = startBridge(config);

  const shutdown = (signal: string): void => {
    console.info(`[bridge] ${signal} recibido, cerrando…`);
    stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
