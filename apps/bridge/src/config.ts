import { readFileSync } from 'node:fs';

/**
 * Configuración del bridge on-site: qué equipos Dahua vigilar (en la LAN del
 * local) y a qué webhook de ingesta de TrasterOS reenviar los eventos. Se carga
 * de un JSON (`BRIDGE_CONFIG_PATH`, por defecto `./bridge.config.json`).
 */
export interface DeviceConfig {
  /** Nombre legible (solo para logs). */
  name: string;
  /** Base del equipo en la LAN, `http://<ip>`. */
  baseUrl: string;
  username: string;
  password: string;
  /** Códigos de evento a suscribir. Default `['All']`. */
  events?: string[];
  /** Naturaleza de los eventos de este equipo. Default `camera`. */
  kind?: 'camera' | 'alarm';
  /** Token de ingesta del `camera_device` correspondiente en TrasterOS. */
  ingestToken: string;
}

export interface BridgeConfig {
  /** URL del webhook de ingesta: `https://api.<dominio>/webhooks/cameras/events`. */
  webhookUrl: string;
  devices: DeviceConfig[];
  /** Reintento de reconexión (ms). Default 5000. */
  reconnectMs?: number;
}

export function loadConfig(path = process.env.BRIDGE_CONFIG_PATH ?? './bridge.config.json'): BridgeConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as BridgeConfig;
  if (!raw.webhookUrl) throw new Error('config: falta webhookUrl');
  if (!Array.isArray(raw.devices) || raw.devices.length === 0) {
    throw new Error('config: falta la lista de devices');
  }
  for (const d of raw.devices) {
    if (!d.baseUrl || !d.username || !d.password || !d.ingestToken) {
      throw new Error(`config: device "${d.name ?? '?'}" incompleto`);
    }
  }
  return raw;
}
