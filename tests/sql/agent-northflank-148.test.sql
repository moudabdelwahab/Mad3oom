-- ============================================================================
-- اختبار تنفيذي لـ 148: عمودا توكن Northflank في `ai_agents`.
--
-- يثبّت الخصائص التي جاء 148 ليضيفها، كل واحدة تفشل إن انكسرت:
--
--   ① بعد تطبيق 148: العمودان موجودان، نوعهما text، وكلاهما nullable
--      (وكيل بلا توكن يبقى صالحًا).
--   ② صف بلا توكن يُدرَج ويُقرأ بقيم NULL للعمودين.
--   ③ التراجع يسقط العمودين، وإعادة تطبيق 148 تعيدهما (بلا تكرار).
--   ④ إعادة تطبيق 148 على قاعدة مطبَّقة أصلًا آمنة (IF NOT EXISTS).
--
-- النمط منسوخ من account-gate-ban-144.test.sql: جدول دنيا بذاته + تحميل
-- ملف الترحيل نفسه عبر `\i` (لا نسخة منسوخة من جسمه) + DO blocks ترفع
-- `FAIL n` عند الانكسار وتطبع `PASS n` عند النجاح.
-- لم تُنفَّذ محليًا إن غاب Postgres (run-sql-tests.sh يتخطاها بصوت عالٍ).
-- ============================================================================
\set ON_ERROR_STOP on
\pset tuples_only on

-- ── جدول دنيا كما يعرّفه 134 (بلا عمودي التوكن قبل 148) ────────────────
CREATE TABLE public.ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  type text DEFAULT 'custom' NOT NULL,
  endpoint text,
  api_key_encrypted text,
  api_key_last4 text,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- ── الترحيل تحت الاختبار: 148 ──────────────────────────────────────────
\i migrations/148_agent_northflank_token.sql

-- ════════════════════════════════════════════════════════════════════════
-- ① العمودان موجودان، text، nullable
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_enc_type text; v_enc_nullable text;
  v_last4_type text; v_last4_nullable text;
BEGIN
  SELECT data_type, is_nullable INTO v_enc_type, v_enc_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_agents'
      AND column_name = 'northflank_token_encrypted';
  SELECT data_type, is_nullable INTO v_last4_type, v_last4_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_agents'
      AND column_name = 'northflank_token_last4';
  IF v_enc_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'FAIL 1: northflank_token_encrypted نوعه % لا text', v_enc_type;
  END IF;
  IF v_enc_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'FAIL 1: northflank_token_encrypted ليس nullable';
  END IF;
  IF v_last4_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'FAIL 1: northflank_token_last4 نوعه % لا text', v_last4_type;
  END IF;
  IF v_last4_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'FAIL 1: northflank_token_last4 ليس nullable';
  END IF;
  RAISE NOTICE 'PASS 1: العمودان موجودان، text، nullable';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ② صف بلا توكن: NULL للعمودين
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_enc text; v_last4 text;
BEGIN
  INSERT INTO public.ai_agents (name, slug, type)
    VALUES ('Hermes', 'hermes-agent', 'hermes')
    RETURNING northflank_token_encrypted, northflank_token_last4 INTO v_enc, v_last4;
  IF v_enc IS NOT NULL OR v_last4 IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 2: صف بلا توكن جاء بقيم غير NULL (enc=%, last4=%)', v_enc, v_last4;
  END IF;
  RAISE NOTICE 'PASS 2: صف بلا توكن يُدرَج بقيم NULL للعمودين';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ④ إعادة تطبيق 148 آمنة (قبل التراجع — تثبت IF NOT EXISTS)
-- ════════════════════════════════════════════════════════════════════════
\i migrations/148_agent_northflank_token.sql

DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_agents'
      AND column_name IN ('northflank_token_encrypted', 'northflank_token_last4');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FAIL 4: إعادة التطبيق ضاعفت/أضاعت الأعمدة (count=%)', v_count;
  END IF;
  RAISE NOTICE 'PASS 4: إعادة تطبيق 148 آمنة — العمودان اثنان لا أكثر';
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- ③ التراجع يسقط العمودين، وإعادة التطبيق تعيدهما
-- ════════════════════════════════════════════════════════════════════════
\i migrations/_rollback/148_agent_northflank_token.down.sql

DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_agents'
      AND column_name IN ('northflank_token_encrypted', 'northflank_token_last4');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FAIL 3: التراجع لم يسقط العمودين (count=%)', v_count;
  END IF;
  RAISE NOTICE 'PASS 3: التراجع يسقط العمودين';
END $$;

\i migrations/148_agent_northflank_token.sql

DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_agents'
      AND column_name IN ('northflank_token_encrypted', 'northflank_token_last4');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FAIL 3: إعادة التطبيق بعد التراجع لم تعد العمودين (count=%)', v_count;
  END IF;
  RAISE NOTICE 'PASS 3: إعادة التطبيق بعد التراجع تعيد العمودين';
END $$;

\echo 'ALL AGENT NORTHFLANK 148 TESTS PASSED'
