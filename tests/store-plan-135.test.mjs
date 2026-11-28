/**
 * إصلاحات لوحة المتاجر (135) — منطق خالص بلا DOM ولا شبكة.
 * 162: مساعدات سعر/حصة باقة المتاجر حُذفت مع الباقة نفسها
 * (storePriceError / storePlanPriceArgs / storePlanFromConfig /
 * storeQuotaDisableWarning)؛ بقي هنا أساس حساب الانتهاء عند استئناف
 * اشتراك متجر قائم (storeResumeBasis)، لأن إدارة الاشتراكات القائمة باقية.
 * المنطق الخادمي (SQL) موثَّق في tests/sql/owner-stores-135.test.sql.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { storeResumeBasis } from '../assets/js/owner/owner-labels.js';

// ── ③ أساس الاستئناف ─────────────────────────────────────────────────
test('③ التاريخ اليدوي أثناء الإيقاف يفوز، ثم تحويل الدورة، ثم التمديد', () => {
    assert.equal(storeResumeBasis({ end_date_set_while_paused: true, cycle_changed_while_paused: true }), 'manual');
    assert.equal(storeResumeBasis({ end_date_set_while_paused: false, cycle_changed_while_paused: true }), 'cycle');
    assert.equal(storeResumeBasis({ end_date_set_while_paused: false, cycle_changed_while_paused: false }), 'extension');
    assert.equal(storeResumeBasis({}), 'extension');
    assert.equal(storeResumeBasis(null), 'extension');
});
