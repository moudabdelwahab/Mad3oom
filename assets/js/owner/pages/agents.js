/**
 * owner/agents.html — إدارة وكلاء الذكاء الاصطناعي في لوحة المالك.
 *
 * نفس صفحة الإدارة admin/agent.html حرفيًا (نفس الـ DOM ids، ونفس
 * initAgentAdminPage من assets/js/admin/agent.js عبر /agent-service.js)،
 * بقشرة المالك فقط: bootOwnerPage (بوابة مالك المنصة في سياقه) بدل
 * checkAdminAuth وقائمة الإدارة.
 *
 * الصلاحية: لا تغيير في منطقها. agent-manager نفسها تتحقق من is_admin()
 * (الترحيل 040: رتبة admin، أو مالك في سياق admin/owner) وترفض بـ 403
 * «هذا القسم متاح للأدمن فقط» — والمالك في سياقه يمرّ منها كما يمرّ في
 * صفحة الإدارة. platformAuthority هنا عرض فقط (رسالة «للأدمن فقط» بدل
 * المحتوى) والرفض الحقيقي في الدالة.
 */
import { bootOwnerPage, announce } from '/assets/js/owner/owner-page.js';
import { platformAuthority } from '/assets/js/platform-authority.js';
import { initAgentAdminPage } from '/assets/js/admin/agent.js';

const $ = (id) => document.getElementById(id);

(async function init() {
    if (!await bootOwnerPage()) return;
    const { isAdmin } = await platformAuthority();
    if (!isAdmin) {
        $('agentPageRoot').innerHTML = `
            <div class="not-authorized">
                <p style="font-size:1.05rem; font-weight:700; color:var(--color-text);">هذه الصفحة متاحة للأدمن فقط</p>
                <p style="font-size:.85rem; margin-top:.4rem;">إدارة وكلاء الذكاء الاصطناعي تتطلب صلاحية أدمن.</p>
            </div>`;
        announce($('pageStatus'), 'هذه الصفحة متاحة للأدمن فقط', 'error');
        return;
    }
    initAgentAdminPage();
})();
