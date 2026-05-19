/**
 * Variables de entorno expuestas al cliente.
 *
 * En Next.js, solo las variables `NEXT_PUBLIC_*` llegan al bundle del
 * cliente. Las leemos aqui con validacion suave para detectar errores
 * temprano si alguien olvida configurar el `.env`.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

export const env = {
  apiUrl: required('NEXT_PUBLIC_API_URL', process.env.NEXT_PUBLIC_API_URL),
} as const;
