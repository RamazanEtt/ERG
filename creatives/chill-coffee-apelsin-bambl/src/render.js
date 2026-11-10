const { chromium } = require('playwright');
(async () => {
  const dir = process.argv[2], scale = +process.argv[3] || 1;
  const b = await chromium.launch();
  for (const [f, h] of [['feed', 1350], ['story', 1920]]) {
    const p = await b.newPage({ viewport: { width: 1080, height: h }, deviceScaleFactor: scale });
    await p.goto(`file://${dir}/creative.html#${f}`); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
    await p.locator('#ad').screenshot({ path: `${dir}/out_${f}${scale>1?'@2x':''}.png` });
  }
  await b.close();
})();
