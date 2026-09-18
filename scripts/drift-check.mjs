#!/usr/bin/env node
// ============================================================================
// كاشف الانحراف بين المستودع وقاعدة الإنتاج
// ============================================================================
//
// لماذا هذا الملف موجود:
//   أثناء تقوية الأمان في 2026-09 تبيّن أن المستودع والإنتاج انحرفا في
//   **الاتجاهين معًا**: ترحيلات أمنية مكتوبة وغير مطبَّقة، ودوال قاعدة بيانات
//   حيّة بلا أي مصدر في المستودع، ودوال حافة منشورة لا يعرفها أحد. وأخطر ما
//   في ذلك أنه كان **صامتًا**: لا شيء في CI يقول إن الفجوة اتسعت.
//
//   والانحراف ليس خطأ تنظيم. ترحيلة أمنية غير مطبَّقة تعني ثغرة مفتوحة يظن
//   الفريق أنها مغلقة — وهذا بالضبط ما وجدناه في ست ترحيلات.
//
// لماذا خطّ أساس (baseline) بدل الفشل على أي انحراف:
//   الانحراف القائم كبير (أكثر من 150 دالة قاعدة بيانات بلا مصدر) لأن كثيرًا
//   من المشروع بُني عبر لوحة Supabase مباشرةً. فحصٌ يفشل على كل ذلك سيُعطَّل
//   في أول أسبوع، ويصير ضوضاء. الهدف هنا مختلف: **تجميد الوضع الحالي ومنع
//   اتساعه**. أي انحراف جديد يفشل البناء؛ والقديم مُسجَّل صراحةً في
//   drift-baseline.json ليُقلَّص عمدًا لا صدفةً.
//
// الأسرار:
//   الوضع (ب) يحتاج رمز وصول. لا يُطبع الرمز ولا أي جزء منه، ولا تُطبع
//   الاستجابة الخام. المطبوع أسماء كائنات فقط.
//
// الاستعمال:
//   node scripts/drift-check.mjs            # الوضع (أ): فحوص المستودع وحدها
//   node scripts/drift-check.mjs --remote   # + مقارنة بالإنتاج (يحتاج بيانات اعتماد)
//   node scripts/drift-check.mjs --remote --write-baseline
// ============================================================================

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "drift-baseline.json");

// ─── قراءة حالة المستودع ─────────────────────────────────────────────────

export function repoMigrations(root = ROOT) {
  const dir = join(root, "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

export function repoDbFunctions(root = ROOT) {
  const dir = join(root, "migrations");
  if (!existsSync(dir)) return new Set();
  const names = new Set();
  // `create [or replace] function [public.]name(` — نلتقط الاسم وحده لا التوقيع،
  // لأن ترتيب المعاملات وأنواعها تُكتب في الترحيلة بصياغة قد تختلف عن
  // pg_get_function_identity_arguments، فمقارنة التواقيع تنتج ضجيجًا زائفًا.
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, f), "utf8");
    for (const m of sql.matchAll(re)) names.add(m[1].toLowerCase());
  }
  return names;
}

export function repoEdgeFunctions(root = ROOT) {
  const dir = join(root, "supabase", "functions");
  if (!existsSync(dir)) return new Set();
  const names = new Set();
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("_") || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (!statSync(p).isDirectory()) continue;
    // مجلد بلا index.ts ليس دالة — وجوده وحده لا يُثبت أن لها مصدرًا.
    if (existsSync(join(p, "index.ts"))) names.add(entry);
  }
  return names;
}

// ─── المقارنة (نقية وقابلة للاختبار بلا شبكة) ────────────────────────────

/**
 * يقارن الحالتين ويردّ الانحراف **الجديد** وحده مقارنةً بخط الأساس.
 * نقية عمدًا: كل الإدخال معاملات، ولا تقرأ ملفًا ولا تنادي شبكة — فيمكن
 * اختبار قرارها كاملًا في tests/drift-check.test.mjs.
 */
export function compareDrift({ repo, remote, baseline }) {
  const base = {
    dbFunctionsWithoutSource: [],
    edgeFunctionsWithoutSource: [],
    edgeFunctionsNotDeployed: [],
    unappliedMigrations: [],
    ...(baseline || {}),
  };

  const known = (key) => new Set(base[key] || []);
  const sorted = (s) => [...s].sort();

  const dbWithoutSource = remote.dbFunctions.filter((n) => !repo.dbFunctions.has(n));
  const edgeWithoutSource = remote.edgeFunctions.filter((n) => !repo.edgeFunctions.has(n));
  const edgeNotDeployed = [...repo.edgeFunctions].filter((n) => !remote.edgeFunctions.includes(n));
  const unapplied = repo.migrations.filter((m) => !remote.appliedMigrations.includes(m));

  const current = {
    dbFunctionsWithoutSource: sorted(new Set(dbWithoutSource)),
    edgeFunctionsWithoutSource: sorted(new Set(edgeWithoutSource)),
    edgeFunctionsNotDeployed: sorted(new Set(edgeNotDeployed)),
    unappliedMigrations: sorted(new Set(unapplied)),
  };

  const regressions = {};
  const improvements = {};
  for (const key of Object.keys(current)) {
    const k = known(key);
    regressions[key] = current[key].filter((n) => !k.has(n));
    improvements[key] = [...k].filter((n) => !current[key].includes(n)).sort();
  }

  const newDriftCount = Object.values(regressions).reduce((a, b) => a + b.length, 0);
  const fixedCount = Object.values(improvements).reduce((a, b) => a + b.length, 0);

  return { current, regressions, improvements, newDriftCount, fixedCount };
}

// ─── الوضع (ب): قراءة حالة الإنتاج ───────────────────────────────────────

const MGMT = "https://api.supabase.com";

async function mgmt(path, token, body) {
  const res = await fetch(`${MGMT}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // نص الاستجابة قد يحمل تفاصيل بيئة. الرمز وحده يكفي للتشخيص.
    throw new Error(`Supabase Management API ردّ بـ${res.status} على ${path}`);
  }
  return res.json();
}

async function readRemote(token, ref) {
  const sql = `
    select coalesce(json_agg(x.signature order by x.signature), '[]'::json) as fns from (
      select p.proname as signature
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       group by p.proname
    ) x`;

  const [fnRows, edgeList] = await Promise.all([
    mgmt(`/v1/projects/${ref}/database/query`, token, { query: sql }),
    mgmt(`/v1/projects/${ref}/functions`, token),
  ]);

  let applied = [];
  try {
    const rows = await mgmt(`/v1/projects/${ref}/database/query`, token, {
      query: `select coalesce(json_agg(version order by version), '[]'::json) as v
                from supabase_migrations.schema_migrations`,
    });
    applied = rows?.[0]?.v ?? [];
  } catch {
    // سجلّ الترحيلات غير موثوق في هذا المشروع (مذكور في
    // PRODUCTION_SECURITY_PRECHECK.md): ترحيلات مطبَّقة جزئيًا وغير مسجَّلة.
    // غيابه لا يُفشل الفحص، لكنه يُعلَن بوضوح بدل أن يُفهم صمته كـ«لا انحراف».
    applied = null;
  }

  return {
    dbFunctions: (fnRows?.[0]?.fns ?? []).map((s) => String(s).toLowerCase()),
    edgeFunctions: (Array.isArray(edgeList) ? edgeList : []).map((f) => f.slug),
    appliedMigrations: applied,
  };
}

// ─── التشغيل ─────────────────────────────────────────────────────────────

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function reportSection(title, items) {
  if (!items.length) return;
  console.log(`\n  ${title} (${items.length}):`);
  for (const n of items.slice(0, 40)) console.log(`    - ${n}`);
  if (items.length > 40) console.log(`    … و${items.length - 40} غيرها`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const remoteMode = args.has("--remote");
  const writeBaseline = args.has("--write-baseline");

  const repo = {
    migrations: repoMigrations(),
    dbFunctions: repoDbFunctions(),
    edgeFunctions: repoEdgeFunctions(),
  };

  console.log("حالة المستودع:");
  console.log(`  ترحيلات: ${repo.migrations.length}`);
  console.log(`  دوال قاعدة بيانات مُعرَّفة في الترحيلات: ${repo.dbFunctions.size}`);
  console.log(`  دوال حافة لها مصدر: ${repo.edgeFunctions.size}`);

  if (!remoteMode) {
    console.log("\nالوضع (أ): فحوص المستودع وحدها — لم تُقارَن بالإنتاج.");
    console.log("للمقارنة الكاملة: node scripts/drift-check.mjs --remote");
    return 0;
  }

  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.SUPABASE_PROJECT_REF;

  if (!token || !ref) {
    // لا نمرّ صامتين: فحصٌ لم يعمل ليس فحصًا ناجحًا.
    console.error("\n::error::طُلب --remote بلا SUPABASE_ACCESS_TOKEN أو SUPABASE_PROJECT_REF");
    return 2;
  }

  console.log(`\nمقارنة بالإنتاج (${ref})…`);
  const remote = await readRemote(token, ref);

  if (remote.appliedMigrations === null) {
    console.log("  ⚠️ تعذّرت قراءة supabase_migrations.schema_migrations — فحص الترحيلات متخطّى.");
    remote.appliedMigrations = repo.migrations.slice();
  }

  console.log(`  دوال قاعدة بيانات حيّة: ${remote.dbFunctions.length}`);
  console.log(`  دوال حافة منشورة: ${remote.edgeFunctions.length}`);

  const baseline = loadBaseline();
  const result = compareDrift({ repo, remote, baseline });

  if (writeBaseline) {
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), ...result.current }, null, 2) + "\n"
    );
    console.log(`\nكُتب خط الأساس في ${BASELINE_PATH}`);
    return 0;
  }

  if (!baseline) {
    console.error("\n::error::لا يوجد drift-baseline.json. أنشئه بـ--write-baseline أولًا.");
    return 2;
  }

  if (result.fixedCount > 0) {
    console.log(`\n✅ انحراف مُغلَق منذ خط الأساس: ${result.fixedCount}`);
    reportSection("دوال قاعدة بيانات صار لها مصدر", result.improvements.dbFunctionsWithoutSource);
    reportSection("دوال حافة صار لها مصدر", result.improvements.edgeFunctionsWithoutSource);
    reportSection("ترحيلات طُبِّقت", result.improvements.unappliedMigrations);
    console.log("\n  حدِّث خط الأساس بـ--write-baseline لتثبيت هذا التحسّن.");
  }

  if (result.newDriftCount === 0) {
    console.log("\n✅ لا انحراف جديد.");
    return 0;
  }

  console.error(`\n::error::انحراف جديد: ${result.newDriftCount} عنصرًا خارج خط الأساس`);
  reportSection("دوال قاعدة بيانات حيّة بلا مصدر في المستودع", result.regressions.dbFunctionsWithoutSource);
  reportSection("دوال حافة منشورة بلا مصدر في المستودع", result.regressions.edgeFunctionsWithoutSource);
  reportSection("دوال حافة في المستودع وغير منشورة", result.regressions.edgeFunctionsNotDeployed);
  reportSection("ترحيلات في المستودع وغير مطبَّقة", result.regressions.unappliedMigrations);
  console.error("\nكل عنصر أعلاه إما يُسنَد بمصدر/نشر، أو يُضاف عمدًا إلى drift-baseline.json.");
  return 1;
}

// لا نشغّل main عند الاستيراد من الاختبارات.
if (process.argv[1] && process.argv[1].endsWith("drift-check.mjs")) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(2);
  });
}
