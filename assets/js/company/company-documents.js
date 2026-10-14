/**
 * company-documents.js — مستندات الشركة في لوحتها (migrations/100_company_documents.sql).
 *
 * القرار في القاعدة: company_documents_mine() لمدير الشركة وحده (null لغيره وقبل 100)، والرفع
 * والتنزيل عبر دالتين طرفيتين تناديان القاعدة بهوية المستخدم. اللوحة تظهر فقط والميزة مفعّلة.
 * الملف لا يُعرض ولا يُنزَّل قبل نتيجة فحص نظيفة — والزر لا يظهر، والقاعدة ترفض على أي حال.
 */
import { supabase } from '/api-config.js';
import { escapeHtml, formatDate } from '/assets/js/customer/portal-ui.js';

export const UPLOAD_FUNCTION = 'company-document-upload';
export const DOWNLOAD_FUNCTION = 'company-document-download';
export const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg'];
const MISSING = new Set(['PGRST202', '42883', 'PGRST404']);

export const DOC_STATUS = Object.freeze({
    missing:        { label: 'غير مرفوع',            pill: 'status-neutral' },
    pending_scan:   { label: 'بانتظار الفحص الأمني', pill: 'status-tone-warning' },
    pending_review: { label: 'بانتظار المراجعة',     pill: 'status-tone-warning' },
    approved:       { label: 'معتمد',                pill: 'status-tone-success' },
    rejected:       { label: 'مرفوض',                pill: 'status-tone-danger' },
    expired:        { label: 'منتهٍ',                pill: 'status-tone-danger' }
});

/** فحص الملف قبل الإرسال (الدالة الطرفية والقاعدة تتحققان مرة أخرى). خالصة. */
export function validateDocumentFile(file, allowed = ALLOWED, max = MAX_BYTES) {
    if (!file) return 'اختر ملفًا';
    if (!allowed.includes(file.type)) return 'النوع المسموح: PDF أو PNG أو JPEG';
    if (file.size < 1) return 'الملف فارغ';
    if (file.size > max) return 'الحد الأقصى 10 ميجابايت';
    return null;
}

/** الإصدار الذي يُسمح بتنزيله: الحالي إن كان نظيفًا. خالصة. */
export function downloadableVersion(doc) {
    const current = (doc?.versions || []).find(v => v.is_current);
    return current && current.status === 'clean' ? current : null;
}

const ERROR_TEXT = {
    feature_not_enabled: 'المستندات غير مفعّلة بعد.',
    forbidden: 'رفع المستندات لمدير الشركة.',
    validation_failed: 'الملف غير صالح (النوع أو الحجم أو المحتوى لا يطابق).',
    invalid_state: 'الملف ما زال قيد الفحص الأمني.',
    idempotency_conflict: 'أُرسل هذا الطلب بملف مختلف — أعد المحاولة.',
    upload_failed: 'تعذّر رفع الملف. حاول مرة أخرى.'
};

async function callFunction(name, { body, headers }) {
    const { data: { session } = {} } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('سجّل الدخول من جديد.');
    const res = await fetch(`${supabase.supabaseUrl}/functions/v1/${name}`, {
        method: 'POST', body,
        headers: { Authorization: `Bearer ${token}`, ...(supabase.supabaseKey ? { apikey: supabase.supabaseKey } : {}), ...headers }
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (!res.ok) throw new Error(ERROR_TEXT[json?.error?.code] || 'تعذّر تنفيذ الطلب.');
    return json;
}

export async function renderCompanyDocuments() {
    const panel = document.getElementById('companyDocumentsPanel');
    const box = document.getElementById('companyDocuments');
    if (!panel || !box) return;
    const { data, error } = await supabase.rpc('company_documents_mine');
    if (error && (MISSING.has(error.code) || error.status === 404)) { panel.hidden = true; return; }
    if (error || !data || data.enabled !== true) { panel.hidden = true; return; }
    panel.hidden = false;
    const docs = new Map((data.documents || []).map(d => [d.doc_type, d]));
    box.innerHTML = `
        <ul class="company-sub-list">
            ${(data.requirements || []).map(r => {
                const doc = docs.get(r.doc_type);
                const info = DOC_STATUS[r.status] || DOC_STATUS.missing;
                const current = (doc?.versions || []).find(v => v.is_current);
                const dl = downloadableVersion(doc);
                return `
                <li class="company-sub" data-document-type="${escapeHtml(r.doc_type)}">
                    <div class="company-sub-main">
                        <p class="company-sub-plan">${escapeHtml(r.label)}${r.required ? ' <span class="pill status-neutral">مطلوب</span>' : ''}</p>
                        <p class="company-sub-dates">
                            ${current ? `الإصدار ${escapeHtml(current.version_no)} · ${escapeHtml(formatDate(current.created_at))}` : 'لم يُرفع بعد'}
                            ${doc?.expires_on ? ` · ينتهي ${escapeHtml(doc.expires_on)}` : ''}
                        </p>
                        ${current?.review_status === 'rejected' && current.review_note
                            ? `<p class="company-sub-dates is-muted">ملاحظة المراجعة: ${escapeHtml(current.review_note)}</p>` : ''}
                    </div>
                    <div class="company-sub-side">
                        <span class="pill ${escapeHtml(info.pill)}">${escapeHtml(info.label)}</span>
                        ${dl ? `<button type="button" class="panel-link" data-document-download="${escapeHtml(dl.id)}">تنزيل</button>` : ''}
                        <label class="panel-link">
                            ${current ? 'رفع إصدار جديد' : 'رفع'}
                            <input type="file" accept="${escapeHtml((r.allowed_mime || ALLOWED).join(','))}" hidden
                                   data-document-upload="${escapeHtml(r.doc_type)}">
                        </label>
                    </div>
                </li>`;
            }).join('')}
        </ul>`;
    box.querySelectorAll('[data-document-upload]').forEach(input => input.addEventListener('change', () => onUpload(input)));
    box.querySelectorAll('[data-document-download]').forEach(btn => btn.addEventListener('click', () => onDownload(btn)));
}

function showError(message) {
    const el = document.getElementById('companyDocumentsError');
    el.textContent = message || '';
    el.hidden = !message;
}

async function onUpload(input) {
    const file = input.files?.[0];
    const invalid = validateDocumentFile(file);
    if (invalid) { showError(invalid); return; }
    showError('');
    input.disabled = true;
    try {
        await callFunction(UPLOAD_FUNCTION, {
            body: file,
            headers: { 'Content-Type': file.type, 'X-Document-Type': input.dataset.documentUpload,
                       'X-Idempotency-Key': crypto.randomUUID(), 'X-Document-Name': encodeURIComponent(file.name || '') }
        });
        await renderCompanyDocuments();
    } catch (err) {
        showError(err.message);
        input.disabled = false;
    }
}

async function onDownload(btn) {
    showError('');
    btn.disabled = true;
    try {
        const res = await callFunction(DOWNLOAD_FUNCTION, {
            body: JSON.stringify({ version_id: btn.dataset.documentDownload }), headers: { 'Content-Type': 'application/json' }
        });
        window.open(res.url, '_blank', 'noopener');
    } catch (err) {
        showError(err.message);
    } finally {
        btn.disabled = false;
    }
}
