const { chromium } = require('playwright');
const https = require('https');
const { anonymizeProxy, closeAnonymizedProxy } = require('proxy-chain');

const EMAIL = process.env.ACL_EMAIL;
const PASSWORD = process.env.ACL_PASSWORD;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const PROXY_URL = process.env.PROXY_URL;
const BASE_URL = 'https://dash.aclclouds.com';

async function notify(message, photoPath) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  if (photoPath) {
    const fs = require('fs');
    const boundary = '----FB' + Math.random().toString(36).slice(2);
    const fileData = fs.readFileSync(photoPath);
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT_ID}\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${message}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="err.png"\r\nContent-Type: image/png\r\n\r\n` + fileData.toString('binary') + `\r\n--${boundary}--\r\n`;
    return new Promise((resolve, reject) => {
      const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{console.log('[TG] Photo sent');resolve(d);}); });
      req.on('error', reject); req.write(body, 'binary'); req.end();
    });
  }
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{console.log('[TG] Notification sent');resolve(d);}); });
    req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  console.log('=== ACLClouds Auto-Renew ===');
  console.log(`Time: ${new Date().toISOString()}`);

  let localProxyUrl = null;
  if (PROXY_URL) {
    console.log('[0] Starting proxy tunnel...');
    localProxyUrl = await anonymizeProxy(PROXY_URL);
    console.log(`  Proxy: ${localProxyUrl}`);
  }

  const launchOptions = { headless: true };
  if (localProxyUrl) launchOptions.proxy = { server: localProxyUrl };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/auth/login') && response.request().method() === 'POST') {
      try {
        const body = await response.json();
        console.log(`  [API] POST /auth/login => ${response.status()}: ${JSON.stringify(body)}`);
      } catch (e) {
        console.log(`  [API] POST /auth/login => ${response.status()} (non-JSON)`);
      }
    }
  });

  try {
    console.log('[1] Loading login page...');
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'networkidle' });

    console.log('[2] Filling credentials...');
    await page.fill('#username', EMAIL);
    await page.fill('#password', PASSWORD);

    console.log('[3] Solving Cap captcha...');
    await page.waitForSelector('cap-widget', { timeout: 30000 });
    console.log('  Clicking cap-widget to start solving...');
    await page.click('cap-widget');
    try {
      await page.waitForFunction(() => {
        const t = document.querySelector('input[name="cap-token"]');
        return t && t.value && t.value.length > 0;
      }, { timeout: 120000 });
      const tokenLen = await page.evaluate(() => document.querySelector('input[name="cap-token"]').value.length);
      console.log(`  Cap token received (length: ${tokenLen})`);
    } catch (e) {
      throw new Error('Cap token still empty after 120s - captcha not solved');
    }

    console.log('[4] Signing in...');
    await page.waitForFunction(() => {
      const btn = document.querySelector('button.auth-submit-btn');
      return btn && !btn.disabled;
    }, { timeout: 30000 });
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/auth/login') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
      page.click('button.auth-submit-btn')
    ]);

    if (response) {
      console.log(`  Login response: ${response.status()}`);
    } else {
      console.log('  No POST /auth/login response captured');
    }

    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    console.log(`  Current URL: ${currentUrl}`);

    if (currentUrl.includes('/auth/login')) {
      throw new Error('Login failed - still on login page');
    }

    await page.waitForTimeout(2000);
    console.log('[OK] Logged in!');

    console.log('[5] Fetching servers...');
    const serversResp = await page.evaluate(async () => {
      const r = await fetch('/api/client');
      return r.json();
    });

    if (serversResp.errors) {
      await notify(`ACLClouds API Error: ${JSON.stringify(serversResp.errors)}`);
      process.exit(1);
    }

    const servers = serversResp.data;
    console.log(`[5] Found ${servers.length} server(s)`);

    let results = [];
    for (const server of servers) {
      const { uuid, name, can_renew, expires_at } = server.attributes;
      console.log(`\n--- ${name} (${uuid}) ---`);
      console.log(`  Expires: ${expires_at} | Can renew: ${can_renew}`);

      if (can_renew) {
        console.log('  [RENEWING via UI]...');
        try {
          const shortId = uuid.split('-')[0];
          await page.goto(`https://aclclouds.com/server/${shortId}`, { waitUntil: 'networkidle' });
          await page.click('button:has-text("Renouveler")');
          console.log('  Renew button clicked, waiting for Cap modal...');
          await page.waitForSelector('cap-widget', { timeout: 15000 });
          console.log('  Cap modal appeared, solving...');
          await page.click('cap-widget');
          const renewResp = await page.waitForResponse(
            r => r.url().includes('/upgrade/renew') && r.request().method() === 'POST',
            { timeout: 120000 }
          ).catch(() => null);
          if (renewResp) {
            const body = await renewResp.json().catch(() => ({}));
            console.log(`  Renew API: ${renewResp.status()} ${JSON.stringify(body)}`);
            if (renewResp.status() === 200 && !body.error) results.push(`${name}: Renewed!`);
            else results.push(`${name}: ${body.error || body.message || 'renew failed'}`);
          } else {
            results.push(`${name}: No renew response captured`);
          }
        } catch (e) {
          console.log(`  UI renew failed: ${e.message}`);
          results.push(`${name}: UI renew failed - ${e.message}`);
        }
      } else {
        console.log('  Not available yet');
        results.push(`${name}: Not available yet (expires: ${expires_at})`);
      }
    }

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    await notify(`ACLClouds Auto-Renew\n${now}\n\n${results.join('\n')}`);
    console.log('\n=== Summary ===');
    results.forEach(r => console.log(r));
    console.log('\n=== Done ===');

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
    if (localProxyUrl) await closeAnonymizedProxy(localProxyUrl);
  }
})();
