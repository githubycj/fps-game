// Temporary harness: render the baked terrain alone and shoot a few viewpoints.
import fs from 'node:fs';
import path from 'node:path';
import { startStaticServer } from './scripts/serve-dev.mjs';
import { launchBrowser } from './scripts/cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = process.env.Q || 'low';
const OUT = process.env.OUT || 'screenshots/terrain-check';
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer({ port: 0 });
const url = `http://127.0.0.1:${server.port}/.tmp-terrain-test.html?q=${Q}`;
console.log('[harness] url', url);

const browser = await launchBrowser({ width: 1600, height: 900 });
const { page } = browser;
try {
  await page.send('Page.navigate', { url });
  const ok = await page.waitFor('window.__ready === true', 30000);
  if (!ok) throw new Error('page did not become ready');
  await sleep(500);
  const stats = await page.evaluate('window.__stats()');
  console.log('[harness] stats', JSON.stringify(stats));

  const views = [
    ['overview-south', [40, 260, 520], [20, 0, -140]],
    ['island-north', [0, 60, 260], [0, 60, -500]],
    ['beach', [-40, 12, 60], [-20, 2, -120]],
    ['ridge-view', [0, 16, -196], [0, 40, -420]],
    ['seam-east', [180, 60, -60], [230, 20, -60]],
    ['pier', [55, 14, 90], [30, 3, -120]],
  ];
  for (const [name, p, t] of views) {
    await page.evaluate(`window.__look(${p.join(',')},${t.join(',')})`);
    await sleep(250);
    await page.screenshot(path.join(OUT, `terrain-${name}.png`));
    console.log('[shot]', name);
  }
  const errs = browser.consoleErrors.filter((e) => !/AudioContext|autoplay|favicon/i.test(e));
  console.log('[harness] consoleErrors', errs.length, errs.slice(0, 10).join('\n'));
  if (errs.length) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
