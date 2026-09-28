import { AiToolsService } from '../ai-tools.service';

import type { PrismaService } from '../../database/prisma.service';

describe('AiToolsService — permisos', () => {
  // `prisma` no debe tocarse: las denegaciones se resuelven antes de consultar.
  const prisma = {
    withTenant: jest.fn(() => {
      throw new Error('no debería consultar la BD');
    }),
  } as unknown as PrismaService;
  const tools = new AiToolsService(prisma, {} as never);

  it('solo ofrece al modelo las herramientas que el rol permite', () => {
    const names = tools
      .definitions({ permissions: ['units:read', 'customers:read'] })
      .map((d) => d.name);
    expect(names).toEqual([
      'get_occupancy',
      'search_customers',
      'get_customer_summary',
      'get_unit_availability',
    ]);
  });

  it('sin permisos relevantes no ofrece ninguna herramienta', () => {
    expect(tools.definitions({ permissions: ['templates:read'] })).toEqual([]);
  });

  it('rechaza ejecutar una herramienta no permitida o inventada sin consultar la BD', async () => {
    const ctx = { tenantId: 't', permissions: ['units:read'] as const, facilityScope: null };
    const denied = JSON.parse(
      await tools.execute(
        { ...ctx, permissions: [...ctx.permissions] },
        'list_overdue_invoices',
        {},
      ),
    );
    expect(denied.error).toMatch(/no disponible/);
    const unknown = JSON.parse(
      await tools.execute({ ...ctx, permissions: [...ctx.permissions] }, 'drop_database', {}),
    );
    expect(unknown.error).toMatch(/no disponible/);
  });
});
