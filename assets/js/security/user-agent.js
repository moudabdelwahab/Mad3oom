/**
 * user-agent.js — وصف الجهاز والمتصفح ونظام التشغيل من رأس User-Agent للعرض (121). خالصة — tests/security-ui.test.mjs.
 *
 * استرشادي بحت: الرأس يكتبه المتصفح ويمكن تزويره، فلا قرار عليه. القيم المجهولة تُعرض «غير معروف».
 */
const BROWSERS = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
    ['curl', /curl\/([\d.]+)/],
    ['Supabase JS', /supabase-js\/?([\d.]*)/]
];
const SYSTEMS = [
    ['iOS', /(?:iPhone|iPad|iPod).*OS ([\d_]+)/],
    ['Android', /Android ([\d.]+)/],
    ['Windows', /Windows NT ([\d.]+)/],
    ['macOS', /Mac OS X ([\d_.]+)/],
    ['ChromeOS', /CrOS/],
    ['Linux', /Linux/]
];

export function describeUserAgent(ua) {
    const s = String(ua || '');
    if (!s.trim()) return { browser: 'غير معروف', os: 'غير معروف', device: 'غير معروف', label: 'غير معروف' };
    let browser = 'غير معروف';
    for (const [name, re] of BROWSERS) {
        const m = s.match(re);
        if (m) { browser = m[1] ? `${name} ${m[1].split('.')[0]}` : name; break; }
    }
    let os = 'غير معروف';
    for (const [name, re] of SYSTEMS) {
        const m = s.match(re);
        if (m) {
            const v = (m[1] || '').replace(/_/g, '.');
            const win = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
            os = name === 'Windows' ? `Windows ${win[v] || v}` : v ? `${name} ${v.split('.').slice(0, 2).join('.')}` : name;
            break;
        }
    }
    const device = /iPad|Tablet/.test(s) ? 'جهاز لوحي'
        : /Mobi|iPhone|Android/.test(s) ? 'جوال'
        : /curl|supabase-js|Deno|node-fetch|python/i.test(s) ? 'برنامج / API'
        : 'حاسوب';
    return { browser, os, device, label: `${browser} · ${os}` };
}
