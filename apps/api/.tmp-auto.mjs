import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const p = await browser.newPage();
await p.setViewport({ width: 1280, height: 1000 });
const set = async (sel, v) =>
  p.evaluate(
    (sel, v) => {
      const el = document.querySelector(sel);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    sel,
    v,
  );
try {
  await p.goto('http://localhost:3000/login', { waitUntil: 'networkidle2', timeout: 90000 });
  await set('input[name="tenantSlug"]', 'demo-storage');
  await set('input[name="email"]', 'jota@storageos.local');
  await set('input[name="password"]', 'Jota69');
  await p.evaluate(() =>
    document
      .querySelector('button[type="submit"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  await p.waitForFunction(() => location.pathname !== '/login', { timeout: 60000 });
  await p.goto('http://localhost:3000/settings/saas-billing', {
    waitUntil: 'networkidle2',
    timeout: 90000,
  });
  await p.waitForFunction(() => document.body.innerText.includes('Cobro automático con tarjeta'), {
    timeout: 60000,
  });
  await p.evaluate(() => window.scrollTo(0, 380));
  await new Promise((r) => setTimeout(r, 500));
  await p.screenshot({
    path: '/private/tmp/claude-501/-Users-jota-Desarrollos-storageos/9b2c99f2-98a4-40d8-8970-c2c3fdcd5b6c/scratchpad/tenant-auto.png',
  });
  console.log('ok');
} catch (e) {
  console.log('FALLO', e.message.split('\n')[0]);
  await p.screenshot({
    path: '/private/tmp/claude-501/-Users-jota-Desarrollos-storageos/9b2c99f2-98a4-40d8-8970-c2c3fdcd5b6c/scratchpad/auto-fail.png',
  });
}
await browser.close();
