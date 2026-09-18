// اختبارات كاشف الانحراف.
//
// المقصود هنا هو قرار compareDrift وحده: متى يُعتبر الانحراف «جديدًا» فيفشل
// البناء، ومتى يكون مُسجَّلًا في خط الأساس فيمرّ. الدالة نقية بلا شبكة ولا
// ملفات، ولذلك يمكن اختبار قرارها كاملًا هنا.
//
// ولماذا نختبر كاشف انحراف أصلًا: كاشف يمرّ صامتًا وهو معطوب أسوأ من غيابه —
// يمنح ثقة بلا أساس. تحديدًا الحالة الأخيرة أدناه: خط أساس فارغ يجب أن يفشل
// على أول انحراف، لا أن يبتلعه.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compareDrift } from "../scripts/drift-check.mjs";

const repoOf = (o) => ({
  migrations: o.migrations ?? [],
  dbFunctions: new Set(o.dbFunctions ?? []),
  edgeFunctions: new Set(o.edgeFunctions ?? []),
});

const remoteOf = (o) => ({
  dbFunctions: o.dbFunctions ?? [],
  edgeFunctions: o.edgeFunctions ?? [],
  appliedMigrations: o.appliedMigrations ?? [],
});

test("لا انحراف حين يتطابق المستودع والإنتاج", () => {
  const r = compareDrift({
    repo: repoOf({ migrations: ["001.sql"], dbFunctions: ["is_admin"], edgeFunctions: ["mcp"] }),
    remote: remoteOf({ appliedMigrations: ["001.sql"], dbFunctions: ["is_admin"], edgeFunctions: ["mcp"] }),
    baseline: null,
  });
  assert.equal(r.newDriftCount, 0);
});

test("دالة قاعدة بيانات حيّة بلا مصدر تُحتسب انحرافًا", () => {
  const r = compareDrift({
    repo: repoOf({ dbFunctions: ["is_admin"] }),
    remote: remoteOf({ dbFunctions: ["is_admin", "secret_backdoor"] }),
    baseline: null,
  });
  assert.deepEqual(r.current.dbFunctionsWithoutSource, ["secret_backdoor"]);
  assert.equal(r.newDriftCount, 1);
});

test("دالة حافة منشورة بلا مصدر تُحتسب انحرافًا", () => {
  const r = compareDrift({
    repo: repoOf({ edgeFunctions: ["mcp"] }),
    remote: remoteOf({ edgeFunctions: ["mcp", "ghost-fn"] }),
    baseline: null,
  });
  assert.deepEqual(r.current.edgeFunctionsWithoutSource, ["ghost-fn"]);
});

test("ترحيلة في المستودع وغير مطبَّقة تُحتسب انحرافًا", () => {
  // هذه هي الحالة التي كلّفت المشروع ست ثغرات مفتوحة: الترحيلة مكتوبة
  // ومدموجة، والفريق يظن الثغرة مغلقة، وهي غير مطبَّقة على الإنتاج.
  const r = compareDrift({
    repo: repoOf({ migrations: ["027_security.sql", "028_storage.sql"] }),
    remote: remoteOf({ appliedMigrations: ["027_security.sql"] }),
    baseline: null,
  });
  assert.deepEqual(r.current.unappliedMigrations, ["028_storage.sql"]);
  assert.equal(r.newDriftCount, 1);
});

test("انحراف مُسجَّل في خط الأساس يمرّ بلا فشل", () => {
  const r = compareDrift({
    repo: repoOf({ dbFunctions: [] }),
    remote: remoteOf({ dbFunctions: ["legacy_fn"] }),
    baseline: { dbFunctionsWithoutSource: ["legacy_fn"] },
  });
  assert.equal(r.newDriftCount, 0);
  assert.deepEqual(r.regressions.dbFunctionsWithoutSource, []);
});

test("انحراف جديد يفشل رغم وجود خط أساس يغطي غيره", () => {
  const r = compareDrift({
    repo: repoOf({ dbFunctions: [] }),
    remote: remoteOf({ dbFunctions: ["legacy_fn", "brand_new_fn"] }),
    baseline: { dbFunctionsWithoutSource: ["legacy_fn"] },
  });
  assert.equal(r.newDriftCount, 1);
  assert.deepEqual(r.regressions.dbFunctionsWithoutSource, ["brand_new_fn"]);
});

test("إغلاق انحراف قديم يُبلَّغ عنه ولا يفشل البناء", () => {
  const r = compareDrift({
    repo: repoOf({ dbFunctions: ["legacy_fn"] }),
    remote: remoteOf({ dbFunctions: ["legacy_fn"] }),
    baseline: { dbFunctionsWithoutSource: ["legacy_fn"] },
  });
  assert.equal(r.newDriftCount, 0);
  assert.deepEqual(r.improvements.dbFunctionsWithoutSource, ["legacy_fn"]);
  assert.equal(r.fixedCount, 1);
});

test("خط أساس فارغ لا يبتلع الانحراف", () => {
  // الحالة الأخطر: كاشف يمرّ دائمًا. لو ابتلع خط أساس فارغ الانحراف، لصار
  // الفحص زينة خضراء بلا معنى.
  const r = compareDrift({
    repo: repoOf({}),
    remote: remoteOf({ dbFunctions: ["x"], edgeFunctions: ["y"] }),
    baseline: {},
  });
  assert.equal(r.newDriftCount, 2);
});

test("دالة في المستودع وغير منشورة تُرصد أيضًا", () => {
  // الاتجاه المعاكس: مصدر مدموج ولم يُنشر — أي أن الإصلاح في الريبو ولا أثر
  // له على العملاء.
  const r = compareDrift({
    repo: repoOf({ edgeFunctions: ["new-fn"] }),
    remote: remoteOf({ edgeFunctions: [] }),
    baseline: null,
  });
  assert.deepEqual(r.current.edgeFunctionsNotDeployed, ["new-fn"]);
});
