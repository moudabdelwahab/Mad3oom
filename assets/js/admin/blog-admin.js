/**
 * blog-admin.js — مدخل تحرير المدوّنة في لوحة الإدارة.
 *
 * مساحة التحرير نفسها في /assets/js/blog/blog-workspace.js، مشتركة مع لوحة المالك (owner/blog.html).
 * هنا حارس الإدارة وقائمتها وحدهما: الحارس يرسم سبب الرفض بنفسه ويعيد null — فلا تنقّل ولا حلقة تحويل.
 */
import { checkAdminAuth } from '/assets/js/admin/auth.js';
import { initSidebar } from '/assets/js/admin/sidebar.js';
import { startBlogWorkspace } from '/assets/js/blog/blog-workspace.js';

document.addEventListener('DOMContentLoaded', async () => {
    initSidebar();
    const user = await checkAdminAuth();
    if (!user) return;
    await startBlogWorkspace(user);
});
