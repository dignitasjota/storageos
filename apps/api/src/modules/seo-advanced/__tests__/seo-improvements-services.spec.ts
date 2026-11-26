import { SeoAutoStartService } from '../improvements/seo-auto-start.service';
import { SeoSistrixService } from '../sistrix/seo-sistrix.service';
import { SistrixConnectionsService } from '../sistrix/sistrix-connections.service';

describe('Arranque automático de un tenant', () => {
  const make = (over: { crawls?: number; settings?: unknown; crawlThrows?: boolean } = {}) => {
    const admin = {
      seoProject: {
        findFirst: jest.fn().mockResolvedValue({ id: 'p1', crawlSettings: over.settings ?? {} }),
        update: jest.fn().mockResolvedValue({}),
      },
      seoCrawl: { count: jest.fn().mockResolvedValue(over.crawls ?? 0) },
    };
    const crawler = {
      start: over.crawlThrows
        ? jest.fn().mockRejectedValue(new Error('sin dominio'))
        : jest.fn().mockResolvedValue({
            alreadyRunning: false,
            crawl: { startUrl: 'https://negocio.es/' },
          }),
    };
    const pagespeed = { run: jest.fn().mockResolvedValue([]) };
    const svc = new SeoAutoStartService(admin as never, crawler as never, pagespeed as never);
    return { svc, admin, crawler, pagespeed };
  };

  it('lanza el rastreo, mide la portada y deja el rastreo mensual', async () => {
    const { svc, admin, crawler, pagespeed } = make();
    const res = await svc.start('t1', 'p1');
    expect(res).toEqual({ crawl: true, pagespeed: true, monthly: true });
    expect(crawler.start).toHaveBeenCalledWith(undefined, 'p1', {}, 'scheduled');
    expect(pagespeed.run).toHaveBeenCalledWith('t1', 'p1', { url: 'https://negocio.es/' }, {});
    expect(admin.seoProject.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { crawlSettings: { weeklyEnabled: true, intervalWeeks: 4 } },
    });
  });

  it('solo la primera vez: con un rastreo anterior no toca nada', async () => {
    const { svc, crawler, admin } = make({ crawls: 1 });
    expect(await svc.start('t1', 'p1')).toEqual({ crawl: false, pagespeed: false, monthly: false });
    expect(crawler.start).not.toHaveBeenCalled();
    expect(admin.seoProject.update).not.toHaveBeenCalled();
  });

  it('respeta lo que el tenant ya hubiera decidido y no rompe si algo falla', async () => {
    const decided = make({ settings: { weeklyEnabled: false } });
    expect((await decided.svc.start('t1', 'p1')).monthly).toBe(false);
    const broken = make({ crawlThrows: true });
    const res = await broken.svc.start('t1', 'p1');
    expect(res.crawl).toBe(false);
    expect(res.pagespeed).toBe(false);
    await expect(
      broken.svc.onConnected({ tenantId: 't1', projectId: 'p1' }),
    ).resolves.toBeUndefined();
  });
});

describe('Aviso al 80 % del presupuesto de la API de SISTRIX', () => {
  function make(conn: Record<string, unknown>) {
    const admin = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      seoProviderConnection: {
        findUnique: jest.fn().mockResolvedValue(conn),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      superAdminNotification: { create: jest.fn().mockResolvedValue({}) },
    };
    const notifications = { createForPermission: jest.fn().mockResolvedValue(undefined) };
    const alerts = { emailAdmins: jest.fn().mockResolvedValue(undefined) };
    const svc = new SistrixConnectionsService(
      admin as never,
      {} as never,
      alerts as never,
      notifications as never,
    );
    return { svc, admin, notifications };
  }

  it('avisa a la plataforma al pasar del 80 %', async () => {
    const { svc, admin, notifications } = make({
      id: 'c1',
      tenantId: null,
      provider: 'sistrix_api',
      weeklyBudget: 100,
      weekSpent: 80,
    });
    await svc.addSpent('c1', 5);
    expect(admin.superAdminNotification.create).toHaveBeenCalled();
    expect(notifications.createForPermission).not.toHaveBeenCalled();
  });

  it('a un tenant, a quien gestiona la configuración', async () => {
    const { svc, notifications } = make({
      id: 'c2',
      tenantId: 't1',
      provider: 'sistrix_api',
      weeklyBudget: 500,
      weekSpent: 450,
    });
    await svc.addSpent('c2', 10);
    expect(notifications.createForPermission).toHaveBeenCalledWith(
      't1',
      'settings:manage',
      expect.objectContaining({ type: 'seo.sistrix_budget' }),
    );
  });

  it('no avisa por debajo del 80 %, sin presupuesto ni dos veces la misma semana', async () => {
    const low = make({
      id: 'c',
      tenantId: null,
      provider: 'sistrix_api',
      weeklyBudget: 100,
      weekSpent: 79,
    });
    await low.svc.addSpent('c', 1);
    expect(low.admin.superAdminNotification.create).not.toHaveBeenCalled();
    const none = make({
      id: 'c',
      tenantId: null,
      provider: 'sistrix_api',
      weeklyBudget: 0,
      weekSpent: 50,
    });
    await none.svc.addSpent('c', 1);
    expect(none.admin.superAdminNotification.create).not.toHaveBeenCalled();
    const twice = make({
      id: 'c',
      tenantId: null,
      provider: 'sistrix_api',
      weeklyBudget: 100,
      weekSpent: 90,
    });
    twice.admin.seoProviderConnection.updateMany.mockResolvedValue({ count: 0 });
    await twice.svc.addSpent('c', 1);
    expect(twice.admin.superAdminNotification.create).not.toHaveBeenCalled();
  });
});

describe('Probar la API de SISTRIX con una consulta', () => {
  function make(conn: Record<string, unknown> | null, callResult?: unknown) {
    const admin = {
      seoApiSample: { create: jest.fn().mockResolvedValue({ id: 's1' }) },
      seoApiRequest: { create: jest.fn().mockResolvedValue({}) },
    };
    const connections = {
      find: jest.fn().mockResolvedValue(conn),
      apiKeyOf: jest.fn().mockReturnValue(conn ? 'secreto-123' : null),
      weekSpent: jest.fn().mockReturnValue(Number(conn?.weekSpent ?? 0)),
      addSpent: jest.fn().mockResolvedValue(undefined),
    };
    const api = {
      call: jest.fn().mockResolvedValue(
        callResult ?? {
          payload: { kind: 'payload', value: { x: 1 } },
          credits: 1,
          creditsKnown: true,
          raw: { answer: [{ x: 1 }], credits: [{ used: 1 }], eco: 'secreto-123' },
        },
      ),
    };
    const svc = new SeoSistrixService(
      {} as never,
      admin as never,
      connections as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      api as never,
    );
    return { svc, admin, connections, api };
  }
  const authorized = {
    id: 'c1',
    enabled: true,
    weeklyBudget: 100,
    weekSpent: 0,
    apiAuthorizedUntil: new Date(Date.now() + 3600_000),
  };

  it('sin autorización expresa no llama a SISTRIX', async () => {
    const { svc, api } = make({ ...authorized, apiAuthorizedUntil: null });
    await expect(svc.probeApi('sa1', { method: 'domain.kwcount.seo' })).rejects.toMatchObject({
      response: { code: 'sistrix_api_not_authorized' },
    });
    expect(api.call).not.toHaveBeenCalled();
  });

  it('si no cabe en el presupuesto, tampoco', async () => {
    const { svc, api } = make({ ...authorized, weekSpent: 97 });
    await expect(svc.probeApi('sa1', { method: 'keyword.seo.metrics' })).rejects.toMatchObject({
      response: { code: 'sistrix_api_budget' },
    });
    expect(api.call).not.toHaveBeenCalled();
  });

  it('con autorización: una llamada, anota el gasto y guarda la muestra sin la clave', async () => {
    const { svc, api, connections, admin } = make(authorized);
    const res = await svc.probeApi('sa1', {
      method: 'domain.kwcount.seo',
      domain: 'Trasteros.pro',
    });
    expect(api.call).toHaveBeenCalledTimes(1);
    expect(api.call).toHaveBeenCalledWith('secreto-123', 'domain.kwcount.seo', {
      domain: 'trasteros.pro',
      country: 'es',
    });
    expect(connections.addSpent).toHaveBeenCalledWith('c1', 1);
    expect(res).toMatchObject({ sampleId: 's1', credits: 1, creditsKnown: true, outcome: 'ok' });
    const saved = admin.seoApiSample.create.mock.calls[0][0].data;
    expect(JSON.stringify(saved.response)).not.toContain('secreto-123');
    expect(admin.seoApiRequest.create).toHaveBeenCalled();
  });

  it('una respuesta sin el gasto avisa de que es estimado', async () => {
    const { svc } = make(authorized, {
      payload: { kind: 'payload', value: [] },
      credits: 10,
      creditsKnown: false,
      raw: { answer: [] },
    });
    const res = await svc.probeApi('sa1', { method: 'keyword.seo' });
    expect(res.creditsKnown).toBe(false);
    expect(res.message).toContain('estimados');
  });
});
