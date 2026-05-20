import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';

/**
 * Crea o actualiza un super admin. Uso:
 *
 *   pnpm --filter @storageos/database seed:superadmin \
 *     -- --email admin@storageos.com --password 'StrongPassword!23' --name 'Admin'
 *
 * Idempotente: si el email ya existe, actualiza fullName y opcionalmente
 * el password si se pasa --reset-password. Sin esa flag, password se
 * preserva.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.password) {
    console.error(
      'Uso: pnpm --filter @storageos/database seed:superadmin -- --email <email> --password <pwd> [--name <name>] [--role superadmin|support] [--reset-password]',
    );
    process.exit(1);
  }
  const role = args.role === 'support' ? 'support' : 'superadmin';

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.superAdmin.findUnique({
      where: { email: args.email },
    });
    const passwordHash = await argonHash(args.password);
    if (existing) {
      const data: {
        fullName?: string;
        role: 'superadmin' | 'support';
        passwordHash?: string;
      } = { role };
      if (args.name) data.fullName = args.name;
      if (args.resetPassword) data.passwordHash = passwordHash;
      const updated = await prisma.superAdmin.update({
        where: { id: existing.id },
        data,
      });
      console.info(
        `[seed:superadmin] actualizado ${updated.email} (id=${updated.id})${
          args.resetPassword ? ' + password reseteado' : ''
        }`,
      );
    } else {
      const created = await prisma.superAdmin.create({
        data: {
          email: args.email,
          passwordHash,
          fullName: args.name ?? args.email,
          role,
        },
      });
      console.info(`[seed:superadmin] creado ${created.email} (id=${created.id}, role=${role})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

interface CliArgs {
  email?: string;
  password?: string;
  name?: string;
  role?: string;
  resetPassword: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { resetPassword: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--email') out.email = argv[++i];
    else if (arg === '--password') out.password = argv[++i];
    else if (arg === '--name') out.name = argv[++i];
    else if (arg === '--role') out.role = argv[++i];
    else if (arg === '--reset-password') out.resetPassword = true;
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
