-- ============================================================================
-- نسخة مطابقة لشكل قاعدة الإنتاج (schema فقط + بيانات إعداد عامة)
--
-- المصدر: استعلامات قراءة على كتالوج srnelrdpqkcntbgudyto بتاريخ 2026-10-07
-- (pg_get_functiondef / pg_get_triggerdef / pg_get_constraintdef / pg_policy /
-- information_schema). مفيش أي صف بيانات مستخدمين. البيانات الوحيدة: خطط
-- الاشتراك وحصص التذاكر والامتيازات وإعدادات SIE (من غير updated_by) وتعريفات
-- الشارات — اللي دوال الحصة والإشعارات بتقراها.
--
-- التطابق مع الإنتاج وقت الاستخراج: 172 جدول، 410 دالة، 270 محفّز، 360 سياسة،
-- 603 قيد، 448 فهرس، وصلاحيات الجداول والدوال والتسلسلات — وبصمة md5 لدوال المحادثة والحصة والتسليم متطابقة.
-- (143) أُضيفت كائنات وحدة HR إلى اللقطة: 9 جداول، 50 دالة، 12 محفّزًا، 9 سياسات،
-- 60 قيدًا، 21 فهرسًا — فصارت الأعداد: 181 جدولًا، 460 دالة، 282 محفّزًا، 369 سياسة،
-- 663 قيدًا، 469 فهرسًا. باقي الأعداد كما في لقطة 2026-10-07.
--
-- 00_supabase_stubs.sql بس هو المكتوب باليد: أدوار Supabase، auth.uid/role/jwt،
-- net.http_post (بيسجّل النداءات في net._calls بدل ما يبعت)، storage، pgcrypto.
--
-- الاستعمال (من جذر المستودع): \i tests/fixtures/prod-shape/load.sql
-- التحديث: نفس الاستعلامات في docs/CONVERSATION_CORE_GATE_AR.md (الملحق أ).
-- ============================================================================
SET check_function_bodies = off;
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS net, extensions, vault, emp_ops CASCADE;
\ir 00_supabase_stubs.sql
SET search_path = public, extensions;
\ir 05_sequences.sql
\ir 10_tables.sql
\ir 20_constraints.sql
\ir 50_functions_a.sql
\ir 51_functions_b.sql
\ir 52_functions_c.sql
\ir 40_views.sql
\ir 30_indexes.sql
\ir 60_triggers_rls_policies.sql
\ir 70_grants.sql
\ir 71_sequence_grants.sql
\ir 80_config_data.sql
SET check_function_bodies = on;
SET client_min_messages = notice;
