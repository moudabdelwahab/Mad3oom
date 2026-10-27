/**
 * owner/blog.html — تحرير المدوّنة من لوحة المالك.
 *
 * نفس مساحة التحرير التي تخدم لوحة الإدارة (blog-workspace.js) بلا نسخة ثانية منها. الفرق الحارس والقشرة:
 * هنا بوابة سياق المالك. والكتابة تحرسها سياسات blog_posts/blog_categories ← is_platform_staff()، وهي تشمل
 * المالك في سياقه (owner_capability('staff')) — فالتحرير الكامل صلاحيته الفعلية لا امتياز أُضيف له.
 */
import { supabase, bootOwnerPage } from '/assets/js/owner/owner-page.js';
import { startBlogWorkspace } from '/assets/js/blog/blog-workspace.js';

(async function init() {
    const ctx = await bootOwnerPage();
    if (!ctx) return;
    const { data: profile } = await supabase.from('profiles').select('full_name')
        .eq('id', ctx.session.user.id).maybeSingle();
    await startBlogWorkspace({ id: ctx.session.user.id, email: ctx.session.user.email, profile: profile || {} });
})();
