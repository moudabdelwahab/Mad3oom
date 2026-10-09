/**
 * workspace-strings.js — نصوص مساحة العمل وأيقوناتها
 * ---------------------------------------------------------------------------
 * العربية لغة المنصة والإنجليزية اختيار صريح (language-manager.js يضبط
 * <html lang/dir>). النص يُختار عند كل رسم من lang الحالي، فتبديل اللغة لا
 * يحتاج إعادة تحميل.
 */
import { panelLabel } from './panel-registry.js';

const STRINGS = {
    ar: {
        workspaceTitle: 'مساحة العمل',
        quickOpenButton: 'ابحث أو افتح…',
        quickOpenTitle: 'فتح سريع',
        quickOpenPlaceholder: 'اسم عميل، رقم تذكرة، أو أمر…',
        quickOpenResults: 'النتائج',
        quickOpenHintEnter: 'Enter: افتح هنا',
        quickOpenHintSide: 'Ctrl + Enter: افتح بجانبها',
        quickOpenSearching: 'جارٍ البحث…',
        quickOpenEmpty: 'لا توجد نتائج',
        group_panel: 'فتح',
        group_layout: 'ترتيبات جاهزة',
        group_command: 'أوامر',
        group_conversation: 'المحادثات',
        group_ticket: 'التذاكر',
        group_customer: 'العملاء',
        newTab: 'تبويب جديد (Ctrl+K)',
        layoutMenu: 'الترتيب',
        tabsOf: 'تبويبات المجموعة',
        tabMenu: 'خيارات التبويب',
        splitSide: 'انقل التبويب لمجموعة بجانبها',
        close: 'إغلاق',
        closeNamed: 'إغلاق {title}',
        closeOthers: 'إغلاق التبويبات الأخرى',
        closeToEnd: 'إغلاق ما بعده',
        reopenClosed: 'إعادة فتح آخر تبويب مغلق',
        reloadPanel: 'إعادة تحميل اللوحة',
        focusPanel: 'الانتقال إلى محتوى اللوحة',
        move_left: 'انقل لمجموعة جديدة يسارًا',
        move_right: 'انقل لمجموعة جديدة يمينًا',
        move_top: 'انقل لمجموعة جديدة بالأعلى',
        move_bottom: 'انقل لمجموعة جديدة بالأسفل',
        moveToGroup: 'انقل إلى المجموعة: {title}',
        resetLayout: 'إعادة ضبط الترتيب',
        starter_inbox: 'الصندوق وحده',
        starter_desk: 'الصندوق والتذاكر جنبًا إلى جنب',
        starter_full: 'الصندوق + التذاكر + سجل العملاء',
        emptyTitle: 'مساحة العمل فارغة',
        emptyBody: 'افتح المحادثات والتذاكر وملفات العملاء جنبًا إلى جنب. اسحب أي تبويب إلى حافة لوحة لتقسيمها، أو استخدم قائمة التبويب.',
        emptyQuick: 'بحث سريع',
        loading: 'جارٍ التحميل…',
        unavailableTitle: 'هذا العنصر غير متاح',
        unavailableBody: 'ربما حُذف، أو لم تعد تملك صلاحية الوصول إليه.',
        retry: 'إعادة المحاولة',
        closeTab: 'إغلاق التبويب',
        dirtyLabel: 'فيه كلام لم يُرسل',
        confirmCloseTitle: 'إغلاق مع كلام لم يُرسل؟',
        confirmCloseBody: 'فيه رد أو ملاحظة لم تُرسل بعد في:',
        confirmCloseNote: 'لو أغلقت سيضيع هذا الكلام. الإرسال نفسه لا يحدث من هنا.',
        confirmDiscard: 'إغلاق وتجاهل',
        confirmResetTitle: 'إعادة ضبط الترتيب؟',
        cancel: 'إلغاء',
        saved: 'الترتيب محفوظ',
        savedLocal: 'الترتيب محفوظ على هذا الجهاز',
        saveError: 'تعذّر الحفظ على الخادم — الترتيب محفوظ على هذا الجهاز',
        conflict: 'تغيّر الترتيب من نافذة أخرى؛ احتفظنا بترتيب هذه النافذة',
        restoreFailed: 'تعذّرت استعادة الترتيب السابق، فبدأنا بترتيب افتراضي.',
        restoreDropped: 'لم تُستعد بعض التبويبات لأنها لم تعد صالحة.',
        notAllowed: 'هذا النوع من اللوحات ليس متاحًا لحسابك.',
        maxPanels: 'وصلت للحد الأقصى من التبويبات. أغلق بعضها أولًا.',
        cannotDock: 'لا يمكن تقسيم هذه المجموعة أكثر.',
        resizeLabel: 'تغيير حجم اللوحات',
        staffOnly: 'مساحة العمل لفريق الدعم. حسابك ليس من طاقم المنصة.',
        openedBeside: 'فُتح بجانب اللوحة الحالية'
    },
    en: {
        workspaceTitle: 'Workspace',
        quickOpenButton: 'Search or open…',
        quickOpenTitle: 'Quick open',
        quickOpenPlaceholder: 'Customer name, ticket number, or command…',
        quickOpenResults: 'Results',
        quickOpenHintEnter: 'Enter: open here',
        quickOpenHintSide: 'Ctrl + Enter: open beside',
        quickOpenSearching: 'Searching…',
        quickOpenEmpty: 'No results',
        group_panel: 'Open',
        group_layout: 'Starter layouts',
        group_command: 'Commands',
        group_conversation: 'Conversations',
        group_ticket: 'Tickets',
        group_customer: 'Customers',
        newTab: 'New tab (Ctrl+K)',
        layoutMenu: 'Layout',
        tabsOf: 'Group tabs',
        tabMenu: 'Tab options',
        splitSide: 'Move tab to a group beside this one',
        close: 'Close',
        closeNamed: 'Close {title}',
        closeOthers: 'Close other tabs',
        closeToEnd: 'Close tabs after this',
        reopenClosed: 'Reopen last closed tab',
        reloadPanel: 'Reload panel',
        focusPanel: 'Go to panel content',
        move_left: 'Move to new group on the left',
        move_right: 'Move to new group on the right',
        move_top: 'Move to new group above',
        move_bottom: 'Move to new group below',
        moveToGroup: 'Move to group: {title}',
        resetLayout: 'Reset layout',
        starter_inbox: 'Inbox only',
        starter_desk: 'Inbox and tickets side by side',
        starter_full: 'Inbox + tickets + customers',
        emptyTitle: 'Your workspace is empty',
        emptyBody: 'Open conversations, tickets and customer profiles side by side. Drag a tab to the edge of a panel to split it, or use the tab menu.',
        emptyQuick: 'Quick open',
        loading: 'Loading…',
        unavailableTitle: 'This item is unavailable',
        unavailableBody: 'It may have been deleted, or you no longer have access to it.',
        retry: 'Retry',
        closeTab: 'Close tab',
        dirtyLabel: 'Unsent changes',
        confirmCloseTitle: 'Close with unsent text?',
        confirmCloseBody: 'There is an unsent reply or note in:',
        confirmCloseNote: 'Closing discards it. Nothing is sent from here.',
        confirmDiscard: 'Close and discard',
        confirmResetTitle: 'Reset the layout?',
        cancel: 'Cancel',
        saved: 'Layout saved',
        savedLocal: 'Layout saved on this device',
        saveError: 'Could not save to the server — saved on this device',
        conflict: 'The layout changed in another window; this window’s layout was kept',
        restoreFailed: 'Your previous layout could not be restored, so a default one was used.',
        restoreDropped: 'Some tabs were not restored because they are no longer valid.',
        notAllowed: 'This panel type is not available for your account.',
        maxPanels: 'Too many open tabs. Close some first.',
        cannotDock: 'This group cannot be split further.',
        resizeLabel: 'Resize panels',
        staffOnly: 'The workspace is for the support team. Your account is not platform staff.',
        openedBeside: 'Opened beside the current panel'
    }
};

export function lang() {
    return document.documentElement.lang === 'en' ? 'en' : 'ar';
}

export function isRtl() {
    return (document.documentElement.dir || 'rtl') !== 'ltr';
}

export function t(key, vars = {}) {
    const text = STRINGS[lang()][key] ?? STRINGS.ar[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

export function defaultTitle(type) {
    return panelLabel(type, lang());
}

const PATHS = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    conversation: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    tickets: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
    ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
    customers: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    customer: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    command: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="12" y1="12" x2="21" y2="12"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    split: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>',
    reload: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>',
    warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'
};

export function icon(name, size = 16) {
    const body = PATHS[name] || PATHS.command;
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
