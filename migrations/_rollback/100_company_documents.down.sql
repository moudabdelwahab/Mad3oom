-- ============================================================================
-- التراجع عن 100_company_documents — 100 لا يعدّل أي دالة أو سياسة قائمة؛ التراجع يحذف كائناته فقط.
--
-- حماية البيانات: يرفض التراجع إن كان المفتاح مفعّلًا، أو وُجد أي مستند أو إصدار أو سجل أو حجز
-- قانوني أو تشغيل احتفاظ، أو أي ملف في المستودع — مستندات الشركات وسجلها لا تُحذف بتراجع.
--
-- الترتيب (REVIEW_FOLLOWUPS L5): 104 قبل 100، و100 قبل 099. يرفض قبل أي تغيير إن كان 104 مطبَّقًا.
-- يُشغَّل في معاملة واحدة: psql --single-transaction -v ON_ERROR_STOP=1 -f <هذا الملف>
-- ============================================================================
do $$
begin
  if to_regprocedure('public.document_upload_commit_server(uuid,uuid,text)') is not null then
    raise exception 'التراجع عن 100 مرفوض: 104 مطبَّق — تراجع عن 104 أولًا';
  end if;
  if exists (select 1 from public.platform_feature_switches where key = 'company_documents_enabled' and enabled) then
    raise exception 'التراجع عن 100 مرفوض: مفتاح المستندات مفعّل — أطفئه أولًا';
  end if;
  if to_regclass('public.company_documents') is not null and (
       exists (select 1 from public.company_documents) or exists (select 1 from public.company_document_versions)
       or exists (select 1 from public.company_document_events) or exists (select 1 from public.legal_holds)
       or exists (select 1 from public.retention_runs) or exists (select 1 from public.company_kind_assignments)) then
    raise exception 'التراجع عن 100 مرفوض: توجد مستندات أو سجلها أو حجز قانوني — بيانات لا تُحذف بتراجع';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'company-documents') then
    raise exception 'التراجع عن 100 مرفوض: توجد ملفات في مستودع المستندات';
  end if;
end $$;

drop function if exists public.document_upload_begin(text, text, integer, text, uuid);
drop function if exists public.document_upload_commit(uuid, text);
drop function if exists public.document_scan_result(uuid, text, text, jsonb);
drop function if exists public.document_scan_queue(integer);
drop function if exists public.document_download_authorize(uuid);
drop function if exists public.company_documents_mine();
drop function if exists public.owner_documents_queue(text);
drop function if exists public.reviewer_documents();
drop function if exists public.owner_assign_document_reviewer(uuid, uuid, uuid, text);
drop function if exists public.document_review(uuid, boolean, text, date);
drop function if exists public.owner_document_metadata(uuid, jsonb, text);
drop function if exists public.document_expiry_scan(date);
drop function if exists public.owner_legal_hold_set(uuid, uuid, text);
drop function if exists public.owner_legal_hold_release(uuid, text);
drop function if exists public.owner_retention_dry_run(date);
drop function if exists public.owner_set_document_requirement(text, text, boolean, text);
drop function if exists public._document_json(public.company_documents, boolean);
drop function if exists public._document_reader_kind(uuid);
drop function if exists public._document_reviewer_ok(uuid, uuid);
drop function if exists public._documents_require_enabled();
drop function if exists public._document_event(uuid, uuid, uuid, text, jsonb);
drop table if exists public.retention_runs;
drop table if exists public.document_retention_policies;
drop table if exists public.legal_holds;
drop table if exists public.company_document_events;
drop table if exists public.company_document_versions;
drop table if exists public.company_documents;
drop table if exists public.document_requirements;
drop table if exists public.company_kind_assignments;
drop table if exists public.company_kinds;
drop table if exists public.document_types;
drop function if exists public._documents_append_only();
drop function if exists public._document_version_guard();
delete from storage.buckets where id = 'company-documents';
delete from public.platform_feature_switches where key = 'company_documents_enabled';
