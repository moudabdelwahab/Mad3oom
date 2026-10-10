"""Figures for the white paper.  Each figure is built per language; most are HTML/CSS (so that
Arabic wraps and mirrors natively), the two relationship graphs are SVG.

Every figure is conceptual and labeled as such in its caption where it is not a literal map of
the implementation.  Status chips use the same vocabulary as the text (Existing / In development /
Planned / Future / Recommendation)."""
from __future__ import annotations
import html
from lib import diagram, STATUS, A

DIAGRAM_CSS = """
.dg { font-size:8pt; line-height:1.35; color:var(--ink); }
.dg-band { border:.7pt solid var(--rule); border-radius:4pt; padding:2.4mm 3mm 2.8mm; margin-bottom:2.4mm; background:#fff; }
.dg-band.soft { background:var(--tint2); }
.dg-band.navy { background:var(--navy); border-color:var(--navy); color:#fff; }
.dg-lab { font-weight:600; font-size:6.6pt; letter-spacing:.14em; text-transform:uppercase; color:var(--blue); margin-bottom:1.6mm; }
html[dir=rtl] .dg-lab { letter-spacing:0; text-transform:none; font-size:7.6pt; }
.dg-band.navy .dg-lab { color:#9CC6F4; }
.dg-row { display:flex; gap:2.2mm; }
.dg-box { flex:1; background:#fff; border:.8pt solid #C3D3E8; border-radius:3pt; padding:2mm 2.4mm; min-width:0; }
.dg-box.dash { border-style:dashed; border-color:#8FB3E3; background:#FAFCFF; }
.dg-box.hl { background:#fff; border:1pt solid var(--navy); box-shadow: inset 0 2.4pt 0 var(--navy); padding-top:2.6mm; }
.dg-box.dk { background:#0A3A8A; border-color:#3F73C8; color:#fff; }
.dg-t { font-weight:600; color:var(--navy); font-size:8.6pt; }
.dg-box.dk .dg-t { color:#fff; }
.dg-s { color:var(--muted); font-size:7.4pt; margin-top:.4mm; line-height:1.4; }
.dg-box.dk .dg-s { color:#BFD9F7; }
.dg-chips { margin-top:1.4mm; }
.dg-chips .chip { margin-inline:0 1.2mm; }
.dg-arrow { display:flex; align-items:center; justify-content:center; flex:none; width:6mm; color:var(--blue); }
.dg-arrow svg { width:5mm; height:5mm; } html[dir=rtl] .dg-arrow svg { transform:scaleX(-1); }
.dg-down { text-align:center; color:var(--blue); line-height:1; height:4mm; margin:-1mm 0 .6mm; } .dg-down svg { width:4.2mm; height:4mm; }
.dg-group { font-weight:600; font-size:7pt; color:#fff; background:var(--navy); border-radius:2pt; padding:.8mm 2.4mm; display:inline-block; margin:0 0 1.6mm; }
.lay { display:flex; align-items:stretch; gap:2.4mm; margin-bottom:1.5mm; }
.lay-n { flex:none; width:10mm; display:flex; align-items:center; justify-content:center; background:var(--tint); color:var(--navy);
         font-family:"Inter"; font-weight:700; font-size:8.6pt; border-radius:3pt; border:.7pt solid var(--rule); }
.lay-b { flex:1; background:#fff; border:.8pt solid #C3D3E8; border-radius:3pt; padding:1.6mm 2.6mm; display:flex; gap:3mm; align-items:center; justify-content:space-between; }
.lay-b .l-txt { min-width:0; } .lay-b .l-ch { flex:none; text-align:end; max-width:34mm; }
.lay-b .l-ch .chip { margin:.4mm 0 .4mm 1mm; } html[dir=rtl] .lay-b .l-ch .chip { margin:.4mm 1mm .4mm 0; }
.trust { border:1pt dashed var(--blue); border-radius:4pt; padding:2mm 3mm; background:#F5F9FF; margin-bottom:2mm; }
.col3 { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:2.4mm; }
.col4 { display:grid; grid-template-columns: repeat(4, 1fr); gap:2.2mm; }
.rm { background:#fff; border:.8pt solid #C3D3E8; border-radius:4pt; padding:2.4mm 2.6mm; min-width:0; }
.rm-h { font-weight:700; font-size:8pt; color:#fff; padding:1.4mm 2.2mm; margin:-2.4mm -2.6mm 2mm; border-radius:3pt 3pt 0 0; line-height:1.3; }
.rm.c1 .rm-h { background:var(--navy); } .rm.c2 .rm-h { background:#0A55B8; } .rm.c3 .rm-h { background:var(--blue); }
.rm.c4 .rm-h { background:#fff; color:var(--blue); box-shadow: inset 0 0 0 .8pt var(--blue); border-radius:3pt 3pt 0 0; }
.rm ul { margin:0; padding-inline-start:3.6mm; } .rm li { margin:0 0 1.1mm; font-size:7.5pt; line-height:1.4; padding-inline-start:0; }
.rm.c4 { border-style:dashed; border-color:#8FB3E3; }
.ws-win { border:1pt solid #9DB4D3; border-radius:5pt; overflow:hidden; background:#fff; }
.ws-tabs { display:flex; gap:1.4mm; background:var(--tint); padding:1.6mm 2mm 0; border-bottom:.8pt solid #C3D3E8; }
.ws-tab { background:#E3ECF8; border:.7pt solid #C3D3E8; border-bottom:0; border-radius:3pt 3pt 0 0; padding:1.2mm 3mm; font-size:7.2pt; color:var(--muted); }
.ws-tab.on { background:#fff; color:var(--navy); font-weight:600; }
.ws-tab .dot { display:inline-block; width:1.7mm; height:1.7mm; border-radius:50%; background:var(--blue); margin-inline-start:1.4mm; vertical-align:middle; }
.ws-body { display:grid; grid-template-columns: 1.15fr 1fr; grid-template-rows: 1fr 1fr; gap:1.6mm; padding:2mm; background:#DCE6F4; height:50mm; }
.ws-pane { background:#fff; border-radius:3pt; padding:1.6mm 2.2mm; border:.7pt solid #C3D3E8; overflow:hidden; }
.ws-pane.big { grid-row: 1 / span 2; }
.ws-pane .ph { font-size:6.8pt; font-weight:600; color:var(--navy); margin-bottom:1.4mm; }
.ws-pane .ph small { font-weight:400; color:var(--muted); }
.bar { height:1.5mm; background:#E3ECF8; border-radius:1mm; margin-bottom:1.3mm; } .bar.s { width:62%; } .bar.m { width:80%; } .bar.l { width:96%; } .bar.d { background:#BCD3F0; }
"""

ARROW_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M13 6l6 6-6 6"/></svg>'
ARROW_D = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v15M6 12l6 6 6-6"/></svg>'


def chips(keys, lang):
    return "".join(f'<span class="chip chip-{k}">{STATUS[k][0] if lang == "en" else A(STATUS[k][1])}</span>' for k in keys)


def tx(pair, lang):
    s = pair[0] if lang == "en" else A(pair[1])
    if lang == "ar":
        from lib import _bidi_wrap
        import re
        parts = re.split(r"(<[^>]+>)", html.escape(s, quote=False))
        return "".join(p if p.startswith("<") else _bidi_wrap(p) for p in parts)
    return html.escape(s, quote=False)


def box(lang, title, sub=None, keys=(), cls=""):
    c = f'<div class="dg-chips">{chips(keys, lang)}</div>' if keys else ""
    s = f'<div class="dg-s">{tx(sub, lang)}</div>' if sub else ""
    return f'<div class="dg-box {cls}"><div class="dg-t">{tx(title, lang)}</div>{s}{c}</div>'


# ---------------------------------------------------------------------------------------------
@diagram("glance")
def fig_glance(lang):
    B = lambda *a, **k: box(lang, *a, **k)
    ch = ("Customer channels", "قنوات العملاء")
    core = ("Core support platform", "منصة الدعم الأساسية")
    lay = ("Three layers that make it one platform", "ثلاث طبقات تجعلها منصة واحدة")
    fnd = ("Foundation", "الأساس التقني")
    return f"""<div class="dg">
<div class="dg-band soft"><div class="dg-lab">{tx(ch, lang)}</div><div class="dg-row">
 {B(("Website chat", "محادثة الموقع"), keys="E")}
 {B(("Telegram", "تيليجرام"), keys="E")}
 {B(("Email", "البريد الإلكتروني"), keys="E")}
 {B(("WhatsApp module", "وحدة واتساب"), ("separate, pre-launch", "منفصلة، قبل الإطلاق"), keys="D", cls="dash")}
</div></div>
<div class="dg-down">{ARROW_D}</div>
<div class="dg-band"><div class="dg-lab">{tx(core, lang)}</div><div class="dg-row">
 {B(("Tickets", "التذاكر"), keys="E")}
 {B(("Conversations", "المحادثات"), keys="E")}
 {B(("Customer records", "سجلات العملاء"), keys="E")}
 {B(("Knowledge", "المعرفة"), keys="E")}
 {B(("Team workflows", "سير عمل الفريق"), keys="E")}
</div></div>
<div class="dg-down">{ARROW_D}</div>
<div class="dg-band navy"><div class="dg-lab">{tx(lay, lang)}</div><div class="dg-row">
 {B(("Mad3oom Workspace", "Mad3oom Workspace"), ("Multi-context work surface", "مساحة عمل متعددة السياقات"), keys="ED", cls="dk")}
 {B(("Mad3oom Relay", "Mad3oom Relay"), ("Operational continuity and follow-up", "الاستمرارية التشغيلية والمتابعة"), keys="EP", cls="dk")}
 {B(("SIE", "SIE"), ("Support Intelligence Engine", "محرك ذكاء الدعم الفني"), keys="ED", cls="dk")}
</div></div>
<div class="dg-down">{ARROW_D}</div>
<div class="dg-band soft"><div class="dg-lab">{tx(fnd, lang)}</div><div class="dg-row">
 {B(("Supabase", "Supabase"), ("Postgres, Auth, Edge Functions, Realtime", "قاعدة Postgres، والمصادقة، وEdge Functions، وRealtime"), keys="E")}
 {B(("Vercel", "Vercel"), ("Static web delivery", "نشر الواجهات الثابتة"), keys="E")}
 {B(("Integrations", "التكاملات"), ("MCP, OAuth 2.1, API tokens", "MCP وOAuth 2.1 ورموز API"), keys="E")}
</div></div></div>"""


# ---------------------------------------------------------------------------------------------
@diagram("workspace")
def fig_workspace(lang):
    t = lambda a, b: tx((a, b), lang)
    def bars(kind="m"):
        return f'<div class="bar l d"></div><div class="bar m"></div><div class="bar s"></div><div class="bar l"></div><div class="bar m"></div>'
    return f"""<div class="dg">
<div class="ws-win">
 <div class="ws-tabs">
  <div class="ws-tab on">{t("Inbox", "صندوق الوارد")}</div>
  <div class="ws-tab">{t("Ticket", "تذكرة")}</div>
  <div class="ws-tab">{t("Customer", "عميل")}<span class="dot"></span></div>
  <div class="ws-tab">{t("Conversation", "محادثة")}</div>
 </div>
 <div class="ws-body">
  <div class="ws-pane big"><div class="ph">{t("Inbox", "صندوق الوارد")} <small>· {t("existing page", "صفحة قائمة")}</small></div>{bars()}{bars()}</div>
  <div class="ws-pane"><div class="ph">{t("Ticket", "تذكرة")} <small>· {t("hosted page", "صفحة مستضافة")}</small></div>{bars()}</div>
  <div class="ws-pane"><div class="ph">{t("Customer record", "سجل العميل")} <small>· {t("hosted page", "صفحة مستضافة")}</small></div>{bars()}</div>
 </div>
</div>
<div class="col3" style="margin-top:2.6mm">
 {box(lang, ("Layout engine", "محرك التخطيط"), ("Pure functions: groups, tabs, splits, resize, saved layouts", "دوال خالصة: مجموعات وتبويبات وتقسيم وتغيير حجم وتخطيطات محفوظة"), keys="E")}
 {box(lang, ("Panel registry", "سجل اللوحات"), ("Six panel types: list pages and single-record panels", "ستة أنواع من اللوحات: صفحات قوائم ولوحات لسجل منفرد"), keys="E")}
 {box(lang, ("Message bridge", "جسر الرسائل"), ("A small, fixed protocol between shell and panels for titles and unsaved-work state", "بروتوكول صغير ثابت بين الغلاف واللوحات للعناوين وحالة العمل غير المحفوظ"), keys="E")}
</div></div>"""


# ---------------------------------------------------------------------------------------------
@diagram("sie_layers")
def fig_sie_layers(lang):
    def row(n, title, sub, keys):
        return (f'<div class="lay"><div class="lay-n">{n}</div><div class="lay-b"><div class="l-txt">'
                f'<div class="dg-t">{tx(title, lang)}</div><div class="dg-s">{tx(sub, lang)}</div></div>'
                f'<div class="l-ch">{chips(keys, lang)}</div></div></div>')
    grp = lambda a, b: f'<div class="dg-group">{tx((a, b), lang)}</div>'
    return f"""<div class="dg">
<div class="trust"><div class="dg-t">{tx(("Trust boundary (cross-cutting)", "حد الثقة (يمتد عبر الطبقات)"), lang)}
 {chips("E", lang)}</div><div class="dg-s">{tx(("Designed to treat customer text as untrusted data.", "مصمَّم لمعاملة نص العميل بوصفه بيانات غير موثوقة."), lang)}</div></div>
{grp("Interpret the customer's message", "تفسير رسالة العميل")}
{row("L1", ("Language and normalization", "اللغة والتطبيع"), ("Tokenization, glossary, dialect and Arabizi canonicalization, negation, reply polarity", "التجزئة والمعجم وتوحيد اللهجات والعربيزي والنفي واتجاه الرد"), "ED")}
{row("L2", ("Scenario catalog", "كتالوج السيناريوهات"), ("A closed, authored set of diagnosable situations, grouped into editions", "مجموعة مغلقة مؤلَّفة من الحالات القابلة للتشخيص، مقسَّمة إلى إصدارات"), "ED")}
{row("L3", ("Diagnostic engine", "محرك التشخيص"), ("Evidence extraction and accumulation; per-scenario confidence; sparse session state", "استخراج الأدلة وتراكمها؛ درجة ثقة لكل سيناريو؛ حالة جلسة مخفَّفة"), "ED")}
{row("L4", ("Ranking", "الترتيب"), ("Deterministic ordering of candidates, specificity and ambiguity", "ترتيب حتمي للمرشحين ومراعاة التخصيص والالتباس"), "E")}
{row("L5", ("Decision", "القرار"), ("One action from a closed vocabulary, by ordered, explainable rules", "إجراء واحد من مجموعة مغلقة وفق قواعد مرتَّبة قابلة للتفسير"), "ED")}
{grp("Respond", "صياغة الاستجابة")}
{row("L7", ("Knowledge", "المعرفة"), ("Attaches knowledge to an answer; grounding in live account data is in development", "يُرفق المعرفة بالإجابة؛ ربط الإجابة ببيانات الحساب الحية قيد التطوير"), "ED")}
{row("L6", ("Dialogue", "الحوار"), ("Renders the decision as a message in Arabic or English from templates", "يصوغ القرار رسالةً بالعربية أو الإنجليزية من قوالب"), "ED")}
{grp("Commit and observe", "الحفظ والرصد")}
{row("L8", ("Action", "التنفيذ"), ("Designed as the single writer: message, state and ticket commit in one atomic transaction", "مصمَّمة لتكون الكاتب الوحيد: الرسالة والحالة والتذكرة تُحفظ في معاملة ذرية واحدة"), "E")}
{row("L9", ("Observability and learning", "الرصد والتعلم"), ("One trace per paid turn; review queue; replay and validation tooling", "أثر واحد لكل دور مدفوع؛ قائمة مراجعة؛ أدوات إعادة التشغيل والتحقق"), "ED")}
</div>"""


# ---------------------------------------------------------------------------------------------
@diagram("connectivity")
def fig_connectivity(lang):
    ch = lambda name, keys, sub=None: box(lang, name, sub, keys=keys)
    def col(title, inner):
        return f'<div class="dg-band soft" style="margin:0"><div class="dg-lab">{tx(title, lang)}</div>{inner}</div>'
    stack = lambda *items: '<div style="display:flex;flex-direction:column;gap:1.6mm">' + "".join(items) + "</div>"
    arrow = f'<div class="dg-arrow">{ARROW_R}</div>'
    return f"""<div class="dg">
<div style="display:flex;gap:1.2mm;align-items:center">
 <div style="flex:1.05">{col(("Channels", "القنوات"), stack(
    ch(("Website chat", "محادثة الموقع"), "E", ("adapter defined", "المحوِّل معرَّف")),
    ch(("Telegram", "تيليجرام"), "E"),
    ch(("WhatsApp", "واتساب"), "D", ("separate module", "وحدة مستقلة")),
    ch(("Messenger · API channel", "ماسنجر · قناة API"), "P", ("adapter shape defined", "شكل المحوِّل معرَّف"))))}</div>
 {arrow}
 <div style="flex:1">{col(("Channel adapter layer", "طبقة محوِّلات القنوات"), stack(
    box(lang, ("verify · parse · dedupe", "تحقق · تحليل · إزالة تكرار"), None, "E"),
    box(lang, ("identity · engine · send", "هوية · محرك · إرسال"), None, "E"),
    box(lang, ("Vendor details stay inside each adapter", "تفاصيل كل مزوّد تبقى داخل محوِّله"), None, "E")))}</div>
 {arrow}
 <div style="flex:.8">{col(("Engine", "المحرك"), stack(
    box(lang, ("SIE", "SIE"), ("Knows nothing about channels", "لا يعرف شيئًا عن القنوات"), "E", "hl")))}</div>
</div>
<div class="dg-down" style="margin-top:2mm">{ARROW_D}</div>
<div class="col3">
 {col(("APIs and tools", "الواجهات والأدوات"), stack(
    ch(("MCP server and client", "خادم وعميل MCP"), "E", ("OAuth 2.1 with PKCE", "OAuth 2.1 مع PKCE")),
    ch(("API tokens", "رموز API"), "E")))}
 {col(("Event-driven work", "العمل المدفوع بالأحداث"), stack(
    ch(("Background and scheduled jobs", "المهام الخلفية والمجدولة"), "E", ("notifications, email, SLA checks", "إشعارات وبريد وفحوص SLA")),
    ch(("Outgoing webhooks", "ويب هوك صادرة"), "E", ("notify other systems", "تبلّغ الأنظمة الأخرى"))))}
 {col(("Future connectors", "موصِّلات مستقبلية"), stack(
    ch(("Browser capture for Relay", "التقاط من المتصفح لـ Relay"), "P"),
    ch(("Voice channels", "القنوات الصوتية"), "F")))}
</div></div>"""


# ---------------------------------------------------------------------------------------------
@diagram("architecture")
def fig_architecture(lang):
    def band(title, inner, cls=""):
        return f'<div class="dg-band {cls}"><div class="dg-lab">{tx(title, lang)}</div>{inner}</div>'
    row = lambda *b: '<div class="dg-row">' + "".join(b) + "</div>"
    B = lambda *a, **k: box(lang, *a, **k)
    down = f'<div class="dg-down">{ARROW_D}</div>'
    return f"""<div class="dg">
{band(("Clients", "العملاء والأطراف"), row(
    B(("Customer portal and chat widget", "بوابة العميل وأداة المحادثة"), ("HTML, CSS, ES modules", "HTML وCSS ووحدات ES"), "E"),
    B(("Admin console and Workspace", "لوحة الإدارة وWorkspace"), ("no bundler, no framework", "بلا مُجمِّع ولا إطار عمل"), "E"),
    B(("Messaging apps and external systems", "تطبيقات المراسلة والأنظمة الخارجية"), ("via adapters and APIs", "عبر المحوِّلات والواجهات"), "E")), "soft")}
{down}
{band(("Delivery", "النشر"), row(B(("Vercel", "Vercel"), ("Static pages and redirects", "صفحات ثابتة وإعادة توجيه"), "E")))}
{down}
{band(("Backend services (Supabase)", "الخدمات الخلفية (Supabase)"), row(
    B(("Auth", "المصادقة"), ("sign-in and authorization", "تسجيل الدخول والتفويض"), "E"),
    B(("Postgres", "Postgres"), ("data, access rules and business logic", "البيانات وقواعد الوصول ومنطق الأعمال"), "E", "hl"),
    B(("Edge Functions", "Edge Functions"), ("integrations, SIE runtime", "التكاملات وبيئة تشغيل SIE"), "E"),
    B(("Realtime and scheduled jobs", "Realtime والمهام المجدولة"), ("live updates, background jobs", "تحديثات حية ومهام في الخلفية"), "E")))}
{down}
{band(("Intelligence and integrations", "الذكاء والتكاملات"), row(
    B(("SIE engine", "محرك SIE"), ("deterministic ES modules, no npm dependencies", "وحدات ES حتمية، بلا اعتماديات npm"), "ED"),
    B(("AI gateway", "بوابة الذكاء الاصطناعي"), ("multi-provider registry for AI features", "سجل متعدد المزوّدين لميزات الذكاء الاصطناعي"), "E"),
    B(("External services", "خدمات خارجية"), ("messaging and email providers", "مزوّدو المراسلة والبريد الإلكتروني"), "E", "dash")), "soft")}
</div>"""


# ---------------------------------------------------------------------------------------------
@diagram("roadmap")
def fig_roadmap(lang):
    items = {
        "c1": (("1 · Existing foundations", "1 · الأسس القائمة"), [
            ("Ticketing, SLA targets, notifications", "التذاكر وأهداف SLA والإشعارات"),
            ("Helpdesk inbox with human–bot handoff", "صندوق وارد للدعم مع تسليم بين الإنسان والروبوت"),
            ("Customer history and knowledge base", "سجل العميل وقاعدة المعرفة"),
            ("Workspace (local layouts)", "Workspace (تخطيطات محلية)"),
            ("Relay core: records, sources, ownership", "نواة Relay: السجلات والمصادر والمسؤولية"),
            ("SIE engine; website and Telegram", "محرك SIE؛ الموقع وتيليجرام"),
            ("CI, SQL and render tests", "التكامل المستمر واختبارات SQL والعرض")]),
        "c2": (("2 · Current development", "2 · التطوير الحالي"), [
            ("SIE refinement and extension", "تحسين SIE وتوسيعه"),
            ("Relay trash and restore", "سلة محذوفات Relay واستعادتها"),
            ("Workspace server-side layouts", "تخطيطات Workspace على الخادم"),
            ("Unified conversation core", "نواة محادثات موحَّدة"),
            ("Grounded knowledge and live account data", "إجابات مرتكزة على المعرفة وبيانات الحساب الحية")]),
        "c3": (("3 · Planned capabilities", "3 · الإمكانات المخطَّطة"), [
            ("Relay handovers with acceptance", "تسليمات Relay مع القبول"),
            ("Relay reminders, escalation, monitor", "تذكيرات Relay والتصعيد ولوحة المتابعة"),
            ("Relay external API and browser capture", "واجهة Relay الخارجية والالتقاط من المتصفح"),
            ("Relay as a Workspace panel", "Relay بوصفها لوحة في Workspace"),
            ("WhatsApp on the shared channel layer", "واتساب على طبقة القنوات المشتركة")]),
        "c4": (("4 · Long-term opportunities", "4 · فرص بعيدة المدى"), [
            ("Assisted extraction for Relay records", "استخراج مساعَد لسجلات Relay"),
            ("Company workspaces in Relay", "مساحات الشركات في Relay"),
            ("Controlled AI-assisted actions", "إجراءات مدعومة بالذكاء الاصطناعي بضوابط"),
            ("Richer workspace organization", "تنظيم أغنى لمساحة العمل"),
            ("Voice channels", "القنوات الصوتية")]),
    }
    cols = []
    for k, (title, lst) in items.items():
        li = "".join(f"<li>{tx(i, lang)}</li>" for i in lst)
        cols.append(f'<div class="rm {k}"><div class="rm-h">{tx(title, lang)}</div><ul>{li}</ul></div>')
    return f'<div class="dg"><div class="col4">{"".join(cols)}</div></div>'


# ---------------------------------------------------------------------------------------------
# SVG graphs
# ---------------------------------------------------------------------------------------------
class Svg:
    def __init__(self, W, H, lang):
        self.W, self.H, self.lang, self.parts = W, H, lang, []
        self.rtl = lang == "ar"

    def mx(self, x, w=0):
        return self.W - x - w if self.rtl else x

    def rect(self, x, y, w, h, fill="#fff", stroke="#C3D3E8", sw=1.6, rx=8, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<rect x="{self.mx(x, w):.1f}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')

    def text(self, cx, y, s, size=17, weight=400, fill="#14233B"):
        s = html.escape(s, quote=False)   # no <bdi> in SVG text: unsupported elements make the text vanish
        self.parts.append(f'<text x="{self.mx(cx):.1f}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="middle">{s}</text>')

    def lines(self, cx, y, ss, size=17, weight=400, fill="#14233B", lh=1.34):
        for i, s in enumerate(ss):
            self.text(cx, y + i * size * lh, s, size, weight, fill)

    def line(self, x1, y1, x2, y2, color="#2074D0", dash=None, w=2.2, arrow=True, both=False):
        a = f' marker-end="url(#ah-{color[1:]})"' if arrow else ""
        b = f' marker-start="url(#ah-{color[1:]})"' if both else ""
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(f'<line x1="{self.mx(x1):.1f}" y1="{y1}" x2="{self.mx(x2):.1f}" y2="{y2}" stroke="{color}" stroke-width="{w}"{d}{a}{b}/>')

    def status_label(self, key):
        return STATUS[key][0] if self.lang == "en" else A(STATUS[key][1])

    def pill_w(self, key):
        return max(74, len(self.status_label(key)) * (7.6 if not self.rtl else 7.2) + 24)

    def pill(self, cx, cy, key, w=96):
        label = self.status_label(key)
        fills = {"E": ("#002560", "#fff", None), "D": ("#2074D0", "#fff", None), "P": ("#DCEBFB", "#002560", "#2074D0"),
                 "F": ("#fff", "#2074D0", "#2074D0"), "R": ("#E6EBF3", "#344864", None)}
        f, t, s = fills[key]
        st = f' stroke="{s}" stroke-width="1.4"' if s else ""
        self.parts.append(f'<rect x="{self.mx(cx - w/2, w):.1f}" y="{cy-11}" width="{w}" height="22" rx="11" fill="{f}"{st}/>')
        self.text(cx, cy + 5.2, label, 12.4, 600, t)

    def node(self, x, y, w, h, title, sub=None, keys="", style="solid"):
        fill = {"solid": "#fff", "navy": "#002560", "tint": "#EEF4FC", "dash": "#FAFCFF"}[style]
        stroke = {"solid": "#9DB4D3", "navy": "#002560", "tint": "#C3D3E8", "dash": "#8FB3E3"}[style]
        self.rect(x, y, w, h, fill, stroke, 1.8, 9, "7 5" if style == "dash" else None)
        tc = "#fff" if style == "navy" else "#002560"
        sc = "#BFD9F7" if style == "navy" else "#55657F"
        ty = y + 28
        self.text(x + w / 2, ty, title, 18.5, 600, tc)
        if sub:
            self.lines(x + w / 2, ty + 22, sub, 14.4, 400, sc)
        widths = [self.pill_w(k) for k in keys]
        gap = 8
        total = sum(widths) + gap * (len(keys) - 1)
        cur = x + w / 2 - total / 2
        for k, pw in zip(keys, widths):
            self.pill(cur + pw / 2, y + h - 20, k, pw)
            cur += pw + gap

    def poly(self, pts, color="#2074D0", dash=None, w=2.2, arrow=True, both=False):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        a = f' marker-end="url(#ah-{color[1:]})"' if arrow else ""
        b = f' marker-start="url(#ah-{color[1:]})"' if both else ""
        pp = " ".join(f"{self.mx(x):.1f},{y}" for x, y in pts)
        self.parts.append(f'<polyline points="{pp}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linejoin="round"{d}{a}{b}/>')

    def state(self, x, y, w, h, title, fill="#fff", stroke="#2074D0", color="#002560", size=17):
        self.rect(x, y, w, h, fill, stroke, 1.8, h / 2)
        self.text(x + w / 2, y + h / 2 + size * 0.34, title, size, 600, color)

    def label(self, cx, cy, ss, size=14.4, color="#2074D0"):
        wmax = max(len(s) for s in ss) * size * (0.50 if not self.rtl else 0.52)
        hh = len(ss) * size * 1.36 + 8
        self.parts.append(f'<rect x="{self.mx(cx - wmax/2 - 6, wmax + 12):.1f}" y="{cy - hh/2:.1f}" width="{wmax+12:.1f}" height="{hh:.1f}" rx="6" fill="#fff" fill-opacity=".96"/>')
        self.lines(cx, cy - hh / 2 + size + 2, ss, size, 500, color)

    def render(self):
        colors = ["2074D0", "002560", "8FB3E3"]
        defs = "".join(
            f'<marker id="ah-{c}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">'
            f'<path d="M0 0L10 5L0 10z" fill="#{c}"/></marker>' for c in colors)
        d = ' direction="rtl" style="direction:rtl"' if self.rtl else ''
        return (f'<svg viewBox="0 0 {self.W} {self.H}" xmlns="http://www.w3.org/2000/svg" role="img"{d}>'
                f'<defs>{defs}</defs>{"".join(self.parts)}</svg>')


@diagram("relations")
def fig_relations(lang):
    ar = lang == "ar"
    t = lambda a, b: A(b) if ar else a
    s = Svg(1000, 640, lang)
    # Workspace frame around the records it hosts
    s.rect(350, 44, 300, 548, "#F4F8FE", "#002560", 2.2, 12)
    s.text(500, 78, "Mad3oom Workspace", 20, 700, "#002560")
    s.text(500, 100, t("hosts these records side by side", "يستضيف هذه السجلات جنبًا إلى جنب"), 14.2, 400, "#55657F")
    s.pill(500 - 58, 128, "E", s.pill_w("E")); s.pill(500 + 58, 128, "D", s.pill_w("D"))
    s.node(375, 156, 250, 98, t("Conversations", "المحادثات"), [t("Inbox, bot and human", "الصندوق: روبوت وإنسان")], "E")
    s.node(375, 288, 250, 98, t("Tickets", "التذاكر"), [t("Lifecycle, SLA, owners", "دورة الحياة وSLA والمسؤولون")], "E")
    s.node(375, 420, 250, 98, t("Customer records", "سجلات العملاء"), [t("History across contacts", "السجل عبر جهات الاتصال")], "E")
    s.text(500, 556, t("Relay is not yet a panel here", "Relay ليست لوحة هنا بعد"), 13.6, 500, "#55657F")
    # Relay (left) and SIE (right)
    s.node(20, 110, 190, 300, "Mad3oom Relay", [t("Continuity records:", "سجلات الاستمرارية:"), t("evidence, owner,", "الدليل والمسؤول"), t("next action,", "والإجراء التالي"), t("deadline, history", "والموعد والسجل")], "EP", "tint")
    s.node(790, 110, 190, 310, t("SIE", "SIE"), [t("Support Intelligence", "محرك ذكاء"), t("Engine: interprets", "الدعم الفني: يفسّر"), t("messages and decides", "الرسائل ويقرّر"), t("one action", "إجراءً واحدًا")], "ED", "tint")
    s.node(790, 484, 190, 104, t("Knowledge", "المعرفة"), [t("Articles, help center", "مقالات ومركز مساعدة")], "E")
    # edges
    ycv, ytk = 205, 337
    s.line(210, ycv, 375, ycv, "#2074D0", None, 2.6, True, True)
    s.label(292, ycv, [t("cites selected", "تستشهد برسائل"), t("messages", "مختارة")], 13.4)
    s.line(210, ytk, 375, ytk, "#8FB3E3", "7 6", 2.4, True, True)
    s.label(292, ytk, [t("ticket as", "التذكرة"), t("a source", "مصدرًا")], 13.4, "#55657F")
    s.line(790, ycv, 625, ycv, "#2074D0", None, 2.6, True, True)
    s.label(708, ycv, [t("reads and", "يقرأ ويردّ"), t("replies", "في المحادثة")], 13.4)
    s.line(790, ytk, 625, ytk, "#2074D0", None, 2.6, True, False)
    s.label(708, ytk, [t("opens", "يفتح"), t("tickets", "التذاكر")], 13.4)
    s.line(885, 484, 885, 422, "#2074D0", None, 2.6, True, False)
    s.label(885, 453, [t("static today", "ثابتة اليوم")], 13.2, "#55657F")
    # future: SIE -> Relay over the top
    s.poly([(790 + 95 - 40, 110), (790 + 95 - 40, 18), (20 + 95, 18), (20 + 95, 110)], "#8FB3E3", "7 6", 2.4, True, False)
    s.label(500, 18, [t("future: hand follow-up work to Relay", "مستقبلًا: تسليم أعمال المتابعة إلى Relay")], 13.6, "#55657F")
    # legend
    s.line(20, 622, 80, 622, "#2074D0", None, 2.6, False)
    s.text(80 + 20 + 55, 627, t("exists today", "قائم اليوم"), 14.4, 500, "#14233B")
    s.line(250, 622, 310, 622, "#8FB3E3", "7 6", 2.6, False)
    s.text(310 + 20 + 170, 627, t("planned, in development or future", "مخطَّط أو قيد التطوير أو مستقبلي"), 14.4, 500, "#14233B")
    return s.render()


@diagram("lifecycle")
def fig_lifecycle(lang):
    ar = lang == "ar"
    t = lambda a, b: A(b) if ar else a
    s = Svg(1000, 470, lang)
    # planned handover (above)
    s.node(250, 12, 330, 92, t("Ready for handover", "جاهز للتسليم"), [t("receiver accepts, queries or declines", "المستلم يقبل أو يستوضح أو يرفض")], "P", "dash")
    # created
    s.node(20, 190, 170, 110, t("Created", "إنشاء"), [t("owner · next action", "المسؤول · الإجراء التالي"), t("deadline + time zone", "الموعد + المنطقة الزمنية")], "", "tint")
    # active container
    s.rect(250, 140, 330, 210, "#F4F8FE", "#2074D0", 2.0, 14)
    s.text(415, 172, t("Active", "نشط"), 19, 700, "#002560")
    s.state(272, 190, 130, 38, t("Open", "مفتوح"))
    s.state(428, 190, 130, 38, t("Scheduled", "مجدول"))
    s.state(272, 242, 130, 38, t("In progress", "قيد المعالجة"))
    s.state(428, 242, 130, 38, t("Waiting", "بانتظار"))
    s.text(415, 312, t("moves among scheduled, in progress", "تنقّل بين المجدول وقيد المعالجة"), 13.4, 400, "#55657F")
    s.text(415, 332, t("and waiting; “waiting” needs a note", "والانتظار؛ «بانتظار» تتطلب ملاحظة"), 13.4, 400, "#55657F")
    # closed container
    s.rect(690, 140, 290, 210, "#002560", "#002560", 2.0, 14)
    s.text(835, 172, t("Closed", "مغلق"), 19, 700, "#fff")
    s.state(712, 190, 246, 38, t("Resolved: resolution note", "تمت المعالجة: ملاحظة حل"), "#fff", "#fff", "#002560", 15.6)
    s.state(712, 242, 246, 38, t("Cancelled: a reason", "أُلغي: سبب"), "#fff", "#fff", "#002560", 15.6)
    s.text(835, 318, t("every transition is recorded", "كل انتقال يُسجَّل"), 13.4, 400, "#BFD9F7")
    s.text(835, 336, t("with who, when and why", "بمن ومتى ولماذا"), 13.4, 400, "#BFD9F7")
    # edges
    s.line(190, 245, 250, 245, "#002560", None, 2.6)
    s.line(580, 245, 690, 245, "#002560", None, 2.6)
    s.label(635, 215, [t("resolve", "حلّ"), t("or cancel", "أو إلغاء")], 13.4, "#002560")
    s.line(415, 104, 415, 140, "#8FB3E3", "7 6", 2.4, True, True)
    s.label(540, 122, [t("on acceptance: new owner", "عند القبول: مسؤول جديد")], 13.2, "#55657F")
    # reopen route under both containers
    s.poly([(835, 350), (835, 410), (415, 410), (415, 350)], "#2074D0", None, 2.4, True, False)
    s.label(625, 410, [t("reopen, with a reason", "إعادة فتح مع ذكر السبب")], 13.6)
    # legend
    s.line(20, 455, 80, 455, "#2074D0", None, 2.6, False)
    s.text(80 + 20 + 90, 460, t("implemented transitions", "انتقالات منفَّذة"), 14.4, 500, "#14233B")
    s.line(330, 455, 390, 455, "#8FB3E3", "7 6", 2.6, False)
    s.text(390 + 20 + 90, 460, t("designed, not yet available", "مصمَّمة وغير متاحة بعد"), 14.4, 500, "#14233B")
    return s.render()
