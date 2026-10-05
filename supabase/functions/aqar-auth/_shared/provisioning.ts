// =============================================================================
// provisioning.ts — تزويد اعتماد Live لكل قناة، وإبطاله عند فقدها
// =============================================================================
// المسار كاملًا:
//
//   مستخدم مدعوم (هوية متحقّقة)
//     → قنواته النشطة في عقار (بعد sync_whatsapp_channels)
//     → aqar_provision_live_credential(owner_user_id, phone_number_id)  [المنصة]
//     → store_credential عبر whatsapp-dispatch بسرّ التزويد               [عقار]
//     → aqar.mad3oom_credentials (مشفّرًا)
//
// خمس قواعد لا تُخرق:
//
//   1. **لا fallback إطلاقًا.** `phone_number_id` صريح في كل نداء. لا «أول
//      قناة»، ولا موضع في مصفوفة، ولا NULL. الحدّ هو (owner_user_id،
//      phone_number_id) معًا في كل خطوة.
//
//   2. **التزويد لا يقع إلا إذا كان عقار مفعَّلًا** والقناة نشطة ومملوكة
//      لنفس مستخدم المنصة. الملكية تُتحقّق مرتين: هنا، وداخل دالة المنصة
//      التي تسأل public.integrations بنفسها.
//
//   3. **النجاح = التخزين المشفّر في عقار.** إنشاء المفتاح على المنصة وحده
//      ليس نجاحًا. ولذلك:
//
//      ⚠️ الفخّ الذي يحكم هذا الملف: الدالة تعيد المفتاح الخام **مرة واحدة**.
//      فلو أُنشئ ثم فشل تخزينه، يعيد النداء التالي `already_active` بلا مفتاح
//      — ويبقى الحساب عالقًا: مفتاح حيّ على المنصة وعقار لا يملكه. لذلك فشل
//      التخزين **يُبطل المفتاح فورًا**، فيصير «غير فعّال» حقًّا وتصير إعادة
//      الإنشاء لاحقًا مشروعة لا تدويرًا عبثيًّا.
//
//   4. **المفتاح الخام لا يخرج.** لا سجلّ، ولا استجابة، ولا صفّ تدقيق. آخر
//      أربعة محارف فقط.
//
//   5. **الفشل لا يمنع الدخول.** يُسجّل ويُعاد في تقرير، والمستخدم يدخل.
//
// الملف بلا Deno وبلا supabase-js: كل وصول خارجي يُحقن، فيُختبر تحت Node.
// =============================================================================

/** قناة واتساب نشطة كما هي في عقار بعد المزامنة. */
export interface OwnedChannel {
  phone_number_id: string;
  status: string;
}

export type ProvisionOutcome =
  /** أُنشئ مفتاح جديد وخُزّن مشفّرًا بنجاح. */
  | { channel: string; result: 'provisioned'; last4: string }
  /** مفتاح فعّال قائم وعقار يملكه — لا شيء يُفعل. */
  | { channel: string; result: 'already_active' }
  /** المنصة رفضت: القناة ليست مملوكة لهذا المستخدم. */
  | { channel: string; result: 'not_owned' }
  /** أُنشئ المفتاح لكن تخزينه فشل ⇒ أُبطل. يُعاد في الدخول القادم. */
  | { channel: string; result: 'store_failed'; detail: string; revoked: boolean }
  /** خطأ غير متوقّع — لا يمنع الدخول. */
  | { channel: string; result: 'error'; detail: string };

export interface ProvisionReport {
  attempted: number;
  provisioned: number;
  alreadyActive: number;
  failed: number;
  outcomes: ProvisionOutcome[];
}

/** نتيجة دالة المنصة، بالحقول التي تعنينا. */
export interface PlatformProvisionRow {
  provisioned: boolean;
  reason: string;
  api_key: string | null;
  key_last4: string | null;
}

export interface ProvisioningDeps {
  /** public.aqar_provision_live_credential — على مشروع المنصة. */
  provisionOnPlatform(ownerUserId: string, phoneNumberId: string): Promise<PlatformProvisionRow>;
  /** public.aqar_revoke_live_credential — على مشروع المنصة. عدد المفاتيح المُبطَلة. */
  revokeOnPlatform(ownerUserId: string, phoneNumberId: string): Promise<number>;
  /** هل لدى عقار اعتماد live فعّال لهذه القناة بالضبط؟ */
  aqarHasActiveLive(ownerId: string, phoneNumberId: string): Promise<boolean>;
  /** تخزين المفتاح مشفّرًا عبر whatsapp-dispatch. يرمي عند الفشل. */
  storeInAqar(input: {
    ownerId: string;
    phoneNumberId: string;
    apiKey: string;
    clientSlug: string;
  }): Promise<void>;
  /** إبطال صفّ عقار — بعد إبطال المفتاح على المنصة، فلا يبقى «فعّالًا» كذبًا. */
  markAqarRevoked(ownerId: string, phoneNumberId: string): Promise<void>;
  /** تشخيص بلا أسرار. */
  log(message: string): void;
}

const emptyReport = (): ProvisionReport => ({
  attempted: 0,
  provisioned: 0,
  alreadyActive: 0,
  failed: 0,
  outcomes: [],
});

/**
 * يزوّد كل قناة نشطة باعتماد Live مستقلّ.
 *
 * `enabled = false` ⇒ لا شيء إطلاقًا: تعطيل عقار يعني ألّا يُنشأ للحساب أي
 * اعتماد جديد، لا أن نزوّده ثم نمنع استخدامه.
 */
export async function provisionLiveCredentials(
  deps: ProvisioningDeps,
  params: {
    enabled: boolean;
    platformUserId: string;
    aqarOwnerId: string;
    channels: OwnedChannel[];
  },
): Promise<ProvisionReport> {
  const report = emptyReport();
  if (!params.enabled) return report;

  const active = (params.channels ?? []).filter(
    (c) => c && c.status === 'active' && String(c.phone_number_id ?? '').trim().length > 0,
  );

  for (const channel of active) {
    const phoneNumberId = String(channel.phone_number_id).trim();
    report.attempted++;

    try {
      const hasLive = await deps.aqarHasActiveLive(params.aqarOwnerId, phoneNumberId);
      let row = await deps.provisionOnPlatform(params.platformUserId, phoneNumberId);

      if (row.reason === 'not_owned') {
        report.failed++;
        report.outcomes.push({ channel: phoneNumberId, result: 'not_owned' });
        deps.log(`provisioning: القناة ${phoneNumberId} ليست مملوكة لهذا المستخدم — تُخطّى`);
        continue;
      }

      // مصالحة: المنصة تقول «فعّال» وعقار لا يملكه ⇒ المفتاح ضائع بلا رجعة
      // (يُعاد مرة واحدة فقط). نُبطله ونُنشئ بديلًا — وهو تدوير مشروع لأن
      // القائم غير قابل للاستخدام فعلًا، لا مجرّد «أحببنا تجديده».
      if (row.reason === 'already_active' && !hasLive) {
        deps.log(`provisioning: مفتاح ${phoneNumberId} فعّال على المنصة وغائب عن عقار — إبطال وإعادة إنشاء`);
        await deps.revokeOnPlatform(params.platformUserId, phoneNumberId);
        row = await deps.provisionOnPlatform(params.platformUserId, phoneNumberId);
      }

      if (row.reason === 'already_active') {
        report.alreadyActive++;
        report.outcomes.push({ channel: phoneNumberId, result: 'already_active' });
        continue;
      }

      if (!row.provisioned || !row.api_key) {
        report.failed++;
        report.outcomes.push({
          channel: phoneNumberId,
          result: 'error',
          detail: `رد غير متوقّع من التزويد: ${row.reason}`,
        });
        continue;
      }

      const apiKey = row.api_key;
      const last4 = row.key_last4 ?? apiKey.slice(-4);

      try {
        await deps.storeInAqar({
          ownerId: params.aqarOwnerId,
          phoneNumberId,
          apiKey,
          clientSlug: `aqar-${phoneNumberId}`,
        });
      } catch (storeErr) {
        // التخزين فشل ⇒ المفتاح بلا قيمة ولن يُعاد أبدًا. إبطاله يجعل الدخول
        // القادم يبدأ من نقطة سليمة بدل أن يعلق على already_active إلى الأبد.
        const detail = storeErr instanceof Error ? storeErr.message : String(storeErr);
        let revoked = false;
        try {
          await deps.revokeOnPlatform(params.platformUserId, phoneNumberId);
          revoked = true;
        } catch (revokeErr) {
          deps.log(
            `provisioning: تعذّر إبطال مفتاح ${phoneNumberId} بعد فشل التخزين: ` +
              (revokeErr instanceof Error ? revokeErr.message : String(revokeErr)),
          );
        }
        report.failed++;
        report.outcomes.push({ channel: phoneNumberId, result: 'store_failed', detail, revoked });
        deps.log(`provisioning: فشل تخزين اعتماد ${phoneNumberId} في عقار (${detail}) — أُبطل=${revoked}`);
        continue;
      }

      report.provisioned++;
      report.outcomes.push({ channel: phoneNumberId, result: 'provisioned', last4 });
      // آخر أربعة محارف فقط — المفتاح الخام لا يُسجّل أبدًا.
      deps.log(`provisioning: اعتماد Live جديد للقناة ${phoneNumberId} (••••${last4})`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      report.failed++;
      report.outcomes.push({ channel: phoneNumberId, result: 'error', detail });
      deps.log(`provisioning: خطأ على القناة ${phoneNumberId}: ${detail}`);
    }
  }

  return report;
}

export interface RevokeReport {
  revokedChannels: string[];
  failures: Array<{ channel: string; detail: string }>;
}

/**
 * يبطل اعتماد كل قناة لم تعد نشطة — **تلك القناة وحدها**.
 *
 * الإبطال في موضعين لأن الحقيقة في موضعين: المفتاح على المنصة، وصفّه في عقار.
 * إبطال الأول وحده يترك عقار يعرض «فعّال» لمفتاح ميت.
 *
 * لا يحذف قناة، ولا بيانات، ولا يمسّ اعتماد test، ولا قناة أخرى.
 */
export async function revokeCredentialsForLostChannels(
  deps: Pick<ProvisioningDeps, 'revokeOnPlatform' | 'markAqarRevoked' | 'log'>,
  params: {
    platformUserId: string;
    aqarOwnerId: string;
    /** قنوات عقار التي حالتها لم تعد 'active' بعد المزامنة. */
    lostChannels: string[];
  },
): Promise<RevokeReport> {
  const report: RevokeReport = { revokedChannels: [], failures: [] };

  for (const raw of params.lostChannels ?? []) {
    const phoneNumberId = String(raw ?? '').trim();
    if (!phoneNumberId) continue;

    try {
      const count = await deps.revokeOnPlatform(params.platformUserId, phoneNumberId);
      await deps.markAqarRevoked(params.aqarOwnerId, phoneNumberId);
      if (count > 0) {
        report.revokedChannels.push(phoneNumberId);
        deps.log(`provisioning: أُبطل اعتماد القناة ${phoneNumberId} (${count} مفتاحًا)`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      report.failures.push({ channel: phoneNumberId, detail });
      deps.log(`provisioning: تعذّر إبطال اعتماد ${phoneNumberId}: ${detail}`);
    }
  }

  return report;
}
