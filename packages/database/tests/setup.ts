import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

// Cargar `.env` del paquete (DATABASE_URL y vars del seed) sin depender de
// dotenv. Disponible en Node 20.12+.
const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// URL para conectar como el rol restringido `storageos_app`. Si no se ha
// definido explicitamente, deducimos a partir de DATABASE_URL cambiando
// usuario/password.
if (!process.env.DATABASE_URL_APP && process.env.DATABASE_URL) {
  process.env.DATABASE_URL_APP = process.env.DATABASE_URL.replace(
    /:\/\/storageos:storageos@/,
    '://storageos_app:storageos-app@',
  );
}
