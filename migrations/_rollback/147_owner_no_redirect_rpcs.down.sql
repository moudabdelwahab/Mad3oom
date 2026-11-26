-- تراجع 147_owner_no_redirect_rpcs.sql: يسقط الدوال الثماني التي أنشأها 147
-- ويعيد `manage_user_points` إلى بوابة بريد 134 الأصلية.
--
-- الدوال السبع جديدة كليًا (لا نسخ سابقة تُستعاد)، والداخلية كذلك؛ فالتراجع
-- إسقاط فقط. لا سياسات ولا جداول ولا أعمدة في 147، فلا شيء آخر يُستعاد.
-- الاستثناء الوحيد: `manage_user_points` كانت قائمة قبل 147، فالتراجع
-- يعيد تعريفها بجسم 134 حرفيًا (بوابة بريد support@ وحده).
-- بعد التراجع تعود لوحة المالك إلى تحويلات لوحة الإدارة التي جاء 147
-- ليستبدلها — للطوارئ فقط، ويُعاد تطبيق 147 فور زوال سبب التراجع.
drop function if exists public.owner_service_status();
drop function if exists public.owner_set_service_status(uuid, text);
drop function if exists public.owner_company_store_overview(uuid);
drop function if exists public.owner_list_mcp_servers();
drop function if exists public.owner_set_user_role(uuid, text);
drop function if exists public.owner_ban_user(uuid, text, timestamptz);
drop function if exists public.owner_set_user_points(uuid, int);
drop function if exists public._owner_company_has_feature(uuid, text);

-- استعادة manage_user_points إلى نسخة 134 الأصلية (بوابة البريد وحده).
CREATE OR REPLACE FUNCTION public.manage_user_points(target_user_email text, amount_change bigint, action_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    target_uid UUID;
    admin_uid UUID;
    current_balance BIGINT;
    new_balance BIGINT;
    transaction_id UUID;
BEGIN
    admin_uid := auth.uid();

    IF COALESCE(auth.jwt() ->> 'email', '') != 'support@mad3oom.online' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'غير مصرح لك بالقيام بهذه العملية',
            'error_code', 'UNAUTHORIZED'
        );
    END IF;

    IF target_user_email IS NULL OR target_user_email = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'بريد العميل مطلوب',
            'error_code', 'INVALID_EMAIL'
        );
    END IF;

    IF action_type NOT IN ('add', 'deduct', 'freeze', 'unfreeze') THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'نوع العملية غير صحيح',
            'error_code', 'INVALID_ACTION'
        );
    END IF;

    SELECT id INTO target_uid FROM auth.users WHERE email = target_user_email;

    IF target_uid IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', 'المستخدم غير موجود: ' || target_user_email,
            'error_code', 'USER_NOT_FOUND'
        );
    END IF;

    SELECT available_points INTO current_balance
    FROM user_wallets
    WHERE user_id = target_uid;

    IF current_balance IS NULL THEN
        current_balance := 0;
    END IF;

    IF action_type = 'add' THEN
        IF amount_change IS NULL OR amount_change < 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'يجب أن يكون عدد النقاط موجباً',
                'error_code', 'INVALID_AMOUNT'
            );
        END IF;

        UPDATE user_wallets
        SET available_points = available_points + amount_change,
            total_points = total_points + amount_change,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance + amount_change;

    ELSIF action_type = 'deduct' THEN
        IF amount_change IS NULL OR amount_change < 0 THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'يجب أن يكون عدد النقاط موجباً',
                'error_code', 'INVALID_AMOUNT'
            );
        END IF;

        IF current_balance < amount_change THEN
            RETURN jsonb_build_object(
                'success', false,
                'message', 'رصيد العميل غير كافٍ. الرصيد الحالي: ' || current_balance,
                'error_code', 'INSUFFICIENT_BALANCE',
                'current_balance', current_balance
            );
        END IF;

        UPDATE user_wallets
        SET available_points = GREATEST(0, available_points - amount_change),
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := GREATEST(0, current_balance - amount_change);

    ELSIF action_type = 'freeze' THEN
        UPDATE user_wallets
        SET is_frozen = TRUE,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance;

    ELSIF action_type = 'unfreeze' THEN
        UPDATE user_wallets
        SET is_frozen = FALSE,
            updated_at = NOW()
        WHERE user_id = target_uid;

        new_balance := current_balance;
    END IF;

    INSERT INTO central_wallet_transactions (
        admin_id,
        target_user_id,
        amount,
        transaction_type,
        previous_balance,
        new_balance,
        created_at
    )
    VALUES (
        admin_uid,
        target_uid,
        amount_change,
        action_type,
        current_balance,
        new_balance,
        NOW()
    )
    RETURNING id INTO transaction_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'تمت العملية بنجاح',
        'transaction_id', transaction_id,
        'action_type', action_type,
        'amount', amount_change,
        'user_email', target_user_email,
        'previous_balance', current_balance,
        'new_balance', new_balance
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'message', 'حدث خطأ غير متوقع: ' || SQLERRM,
        'error_code', 'SYSTEM_ERROR'
    );
END;
$function$
;

revoke all on function public.manage_user_points(target_user_email text, amount_change bigint, action_type text) from public, anon, authenticated, service_role;
grant execute on function public.manage_user_points(target_user_email text, amount_change bigint, action_type text) to authenticated;
grant execute on function public.manage_user_points(target_user_email text, amount_change bigint, action_type text) to service_role;
