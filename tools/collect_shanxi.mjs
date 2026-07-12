// 山西省图书馆 离线采集器（在“关掉黑豹、大陆直连”状态下运行；运行时不需要 Claude）
// 用法：  node tools/collect_shanxi.mjs
// 原理：连本机 Chrome 调试端口(127.0.0.1:9222，localhost 不受 VPN 影响)，
//       打开 lib.sx.cn，把所有 /api/ 响应体 + 资源页 DOM 霰弹式抓下来存进 tools/shanxi_dump/。
//       跑完把电脑切回黑豹，让 Claude 读 shanxi_dump/ 里的文件拼 shanxi.json。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

// 复用已在跑的采集 Chrome(9222)——它是“热”的，关掉黑豹后发出的新请求会自动走直连。
// 若没在跑，则新启动一个（并给足冷启动时间）。
const BASE = 'http://127.0.0.1:9222';
const HOME = 'https://lib.sx.cn/';
const DUMP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shanxi_dump');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function chromeUp() {
  try { const r = await fetch(BASE + '/json/version'); return r.ok; } catch { return false; }
}

async function ensureChrome() {
  if (await chromeUp()) { console.log('✓ 已复用运行中的采集 Chrome (9222)'); return true; }
  console.log('· 未发现采集 Chrome，正在启动一个（冷启动，稍等）…');
  const prof = path.join(os.homedir(), '.cdp-collect-profile');
  const bin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  spawn(bin, ['--user-data-dir=' + prof, '--remote-debugging-port=9222',
    '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await chromeUp()) { console.log('✓ Chrome 已就绪'); return false; } }
  throw new Error('启动 Chrome 超时');
}

function connect(wsUrl) {
  return new Promise((res, rej) => { const w = new WebSocket(wsUrl); w.onopen = () => res(w); w.onerror = e => rej(new Error('ws:' + (e.message || e))); });
}
let _id = 0;
function cmd(ws, method, params = {}) {
  const id = ++_id;
  return new Promise((res, rej) => {
    const on = m => { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener('message', on); d.error ? rej(new Error(method + ' ' + JSON.stringify(d.error))) : res(d.result); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function sane(u) { return u.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 90); }

async function main() {
  const warm = await ensureChrome();
  fs.rmSync(DUMP, { recursive: true, force: true });
  fs.mkdirSync(DUMP, { recursive: true });

  // 新建页面
  let r = await fetch(BASE + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
  if (!r.ok) r = await fetch(BASE + '/json/new?' + encodeURIComponent('about:blank'));
  const tab = await r.json();
  const ws = await connect(tab.webSocketDebuggerUrl);
  await cmd(ws, 'Network.enable');
  await cmd(ws, 'Page.enable');

  const reqs = {};          // requestId -> url
  const saved = {};         // url -> count
  let apiCount = 0;
  ws.addEventListener('message', async ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.responseReceived') reqs[m.params.requestId] = m.params.response.url;
    if (m.method === 'Network.loadingFinished') {
      const url = reqs[m.params.requestId];
      if (!url || !url.includes('/api/')) return;
      try {
        const b = await cmd(ws, 'Network.getResponseBody', { requestId: m.params.requestId });
        const body = b.result?.body ?? b.body ?? (b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body);
        const text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : (b.body ?? body ?? '');
        const key = sane(url); saved[url] = (saved[url] || 0) + 1;
        fs.writeFileSync(path.join(DUMP, key + (saved[url] > 1 ? '_' + saved[url] : '') + '.json'), text || '');
        apiCount++;
      } catch { /* body 可能已被驱逐，忽略 */ }
    }
  });

  const evalJS = async (expr) => (await cmd(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

  console.log('→ 打开首页…');
  await cmd(ws, 'Page.navigate', { url: HOME });
  await sleep(warm ? 10000 : 16000);   // 冷启动的 Chrome 给更久让 SPA 发请求
  // 若首屏没抓到接口，再刷新一次多等等（SPA 偶发慢）
  if (apiCount === 0) { console.log('   首屏无接口，重试一次…'); await cmd(ws, 'Page.navigate', { url: HOME + '?_r=' + Date.now() }); await sleep(12000); }

  // 判断是否仍被封（正文空且接口少 = 可能没直连成功）
  const bodyLen = await evalJS('document.body.innerText.length');
  console.log(`   首页正文 ${bodyLen} 字，已抓 ${apiCount} 个接口响应`);
  if (bodyLen < 30 && apiCount < 3) {
    console.log('⚠ 首页几乎空白、接口极少——可能黑豹没关干净、仍是境外IP。请确认已切到大陆直连再重跑。');
  }

  // 收集站内候选链接（含资源/数据库/数字/更多，以及所有站内<a>）
  const links = await evalJS(`(function(){
    var set={},out=[];
    document.querySelectorAll('a').forEach(function(a){
      var h=a.href||''; var t=(a.innerText||'').trim();
      if(h.indexOf('lib.sx.cn')>=0 && !set[h]){set[h]=1; out.push({h:h,t:t,pri:/资源|数据库|数字|电子|馆藏|专题/.test(t)?1:0});}
    });
    out.sort(function(a,b){return b.pri-a.pri;});
    return out.slice(0,30).map(function(x){return x.h+'\\t'+x.t;});
  })()`) || [];
  console.log(`→ 发现 ${links.length} 个站内链接，逐个访问抓接口…`);

  let i = 0;
  for (const line of links) {
    const url = line.split('\t')[0];
    i++;
    try {
      await cmd(ws, 'Page.navigate', { url });
      await sleep(4500);
      // 顺手存一份该页 DOM 文本，万一清单在 DOM 里
      const txt = await evalJS('document.body.innerText.slice(0,20000)');
      if (txt && txt.length > 200) fs.writeFileSync(path.join(DUMP, '_dom_' + i + '_' + sane(url) + '.txt'), txt);
      process.stdout.write(`   [${i}/${links.length}] ${url.slice(0, 60)}  (累计接口 ${apiCount})\n`);
    } catch (e) { console.log('   跳过', url, e.message); }
  }

  await sleep(1500);
  await fetch(BASE + '/json/close/' + tab.id).catch(() => {});
  ws.close();

  // 汇总：哪些文件含资源关键词
  const files = fs.readdirSync(DUMP);
  const kw = /数据库|知网|读秀|超星|万方|维普|数字资源|电子资源|皮书|CNKI/;
  const hits = [];
  for (const f of files) {
    const c = fs.readFileSync(path.join(DUMP, f), 'utf8');
    const n = (c.match(new RegExp(kw, 'g')) || []).length;
    if (n > 0) hits.push([n, f]);
  }
  hits.sort((a, b) => b[0] - a[0]);
  // 被封检测：多数响应是 403 拦截页 = 没直连成功
  const blocked = files.filter(f => { try { return fs.readFileSync(path.join(DUMP, f), 'utf8').includes('403 Forbidden'); } catch { return false; } }).length;
  console.log('\n===== 完成 =====');
  console.log(`共存 ${files.length} 个文件到 tools/shanxi_dump/，其中 ${apiCount} 个接口响应。`);
  if (apiCount === 0) {
    console.log('\n❌ 一个接口都没抓到——页面可能没加载出来。请确认：');
    console.log('   ①黑豹已彻底关闭；②网络能正常打开 https://lib.sx.cn/ ；③然后重跑本脚本。');
    return;
  }
  if (blocked > 0 && !hits.length) {
    console.log(`\n❌ 检测到 ${blocked} 个响应是「403 Forbidden」拦截页——说明还在走境外IP，山西没直连成功。`);
    console.log('   请确认：①黑豹已彻底关闭（菜单栏图标显示断开）；②然后【重新运行本脚本】即可。');
    console.log('   若反复失败，在“活动监视器”里退掉所有 Google Chrome，再重跑本脚本（会自动重开）。');
    return;
  }
  console.log('含资源关键词最多的文件（很可能就是资源清单）：');
  hits.slice(0, 10).forEach(([n, f]) => console.log(`   ${String(n).padStart(4)} 命中  ${f}`));
  if (!hits.length) console.log('   （没抓到含资源关键词的文件——可能清单在更深的页面，把dump发我看）');
  console.log('\n✅ 抓取完成。现在把电脑切回黑豹、恢复 Claude，然后告诉我“跑完了”，我读 tools/shanxi_dump/ 拼 shanxi.json。');
}

main().catch(e => { console.error('出错：', e.message); process.exit(1); });
