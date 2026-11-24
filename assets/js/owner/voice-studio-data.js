/**
 * voice-studio-data.js — بيانات الاستوديو الصوتي (مدعوم).
 *
 * منقولة من مشروع الاستوديو الصوتي الأصلي (constants.tsx + App.tsx):
 * اللهجات الاثنتا عشرة وأنواع الأصوات ومجالات الأداء وأدوات الاستوديو
 * الست وأنماط الفئات ونصوص المعاينة وخطوات مسار الكتاب الصوتي ودالة
 * الصوت الأساسي حسب النوع والجنس.
 *
 * استثناء مقصود: بروفايلات المعرض ليست أسماء شخصيات Gemini الأصلية
 * (يوسف، مالك، رامي، سيف...) — لا وجود لها في Edge TTS — بل صوتان
 * حقيقيان فقط لكل لهجة (أنثى وذكر)، اسم كل منهما الاسم العربي لصوت
 * Edge المقابل في EDGE_VOICE_MAP، مع حقل edgeVoice الذي يحمل اسم
 * Neural الكامل. نوع الصوت (بالغ/كبار السن/كارتوني) ضبط prosody
 * فقط وليس صوتًا مختلفًا، فيُمرَّر كما يختاره المستخدم عند التوليد.
 *
 * استثناء واحد مقصود: حقول الألوان الأصلية (تدرّجات Tailwind) استُبدلت
 * بمفاتيح نبرة (tone) يقرأها assets/css/owner-voice-studio.css بتوكنز
 * مدعوم فقط — نسخها حرفيًا كان سيُدخل ألوانًا ذهبية محظورة في هذا الملف.
 * لا روابط شخصية ولا أسماء للمؤلف الأصلي هنا.
 */
export const CATEGORY_STYLES = {
  doc: { tone: 'vs-cat-mic-documentary', icon: 'mic-documentary' },
  ads: { tone: 'vs-cat-mic-ads', icon: 'mic-ads' },
  cartoon: { tone: 'vs-cat-mic-kids', icon: 'mic-kids' },
  podcast: { tone: 'vs-cat-mic-podcast', icon: 'mic-podcast' },
  novels: { tone: 'vs-cat-mic-book', icon: 'mic-book' },
  youtube: { tone: 'vs-cat-mic-youtube', icon: 'mic-youtube' },
  drama: { tone: 'vs-cat-mic-drama', icon: 'mic-drama' },
  edu: { tone: 'vs-cat-mic-edu', icon: 'mic-edu' },
  corporate: { tone: 'vs-cat-mic-corp', icon: 'mic-corp' }
};

export const DIALECTS = [
  {
    id: 'egyptian',
    title: 'اللهجة المصرية',
    description: 'صوت خفيف الظل، سريع الوتيرة، مثالي للإعلانات والدراما والكوميديا.',
    profiles: [
      { id: 'egy_salma', name: 'سلمى', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-EG-SalmaNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي المصري المتاح في Edge TTS بلا مفتاح (ar-EG-SalmaNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'egy_shakir', name: 'شاكر', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-EG-ShakirNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري المصري المتاح في Edge TTS بلا مفتاح (ar-EG-ShakirNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'saudi',
    title: 'اللهجة السعودية',
    description: 'رصين، فخم، يعكس الهوية السعودية بوضوح واتزان عالي.',
    profiles: [
      { id: 'sau_zariyah', name: 'زارية', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-SA-ZariyahNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي السعودي المتاح في Edge TTS بلا مفتاح (ar-SA-ZariyahNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'sau_hamed', name: 'حامد', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-SA-HamedNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري السعودي المتاح في Edge TTS بلا مفتاح (ar-SA-HamedNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'levantine',
    title: 'اللهجة الشامية',
    description: 'صوت عذب، موسيقي، رائع للروايات والقصص الرومانسية والدراما.',
    profiles: [
      { id: 'lev_amany', name: 'أماني', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-SY-AmanyNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي الشامي المتاح في Edge TTS بلا مفتاح (ar-SY-AmanyNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'lev_laith', name: 'ليث', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-SY-LaithNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري الشامي المتاح في Edge TTS بلا مفتاح (ar-SY-LaithNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'iraqi',
    title: 'اللهجة العراقية',
    description: 'عميق، شجي، يحمل قوة التعبير والأصالة الرافدينية العريقة.',
    profiles: [
      { id: 'irq_rana', name: 'رنا', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-IQ-RanaNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي العراقي المتاح في Edge TTS بلا مفتاح (ar-IQ-RanaNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'irq_bassel', name: 'باسل', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-IQ-BasselNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري العراقي المتاح في Edge TTS بلا مفتاح (ar-IQ-BasselNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'algerian',
    title: 'اللهجة الجزائرية',
    description: 'لهجة غنية، تمزج بين القوة والنعومة، مثالية للوصول لجمهور المغرب العربي بوضوح.',
    profiles: [
      { id: 'alg_amina', name: 'أمينة', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-DZ-AminaNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي الجزائري المتاح في Edge TTS بلا مفتاح (ar-DZ-AminaNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'alg_ismael', name: 'إسماعيل', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-DZ-IsmaelNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري الجزائري المتاح في Edge TTS بلا مفتاح (ar-DZ-IsmaelNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'moroccan',
    title: 'اللهجة المغربية',
    description: 'إيقاع مميز، غني بالتفاصيل، للوصول لجمهور المغرب العربي بذكاء.',
    profiles: [
      { id: 'mor_mouna', name: 'منى', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-MA-MounaNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي المغربي المتاح في Edge TTS بلا مفتاح (ar-MA-MounaNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'mor_jamal', name: 'جمال', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-MA-JamalNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري المغربي المتاح في Edge TTS بلا مفتاح (ar-MA-JamalNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'tunisian',
    title: 'اللهجة التونسية',
    description: 'لبق، منفتح، مثالي للمحتوى الثقافي والاجتماعي المعاصر.',
    profiles: [
      { id: 'tun_reem', name: 'ريم', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-TN-ReemNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي التونسي المتاح في Edge TTS بلا مفتاح (ar-TN-ReemNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'tun_hedi', name: 'هادي', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-TN-HediNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري التونسي المتاح في Edge TTS بلا مفتاح (ar-TN-HediNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'khaleeji',
    title: 'خليجية',
    description: 'أداء هادئ وواثق، يعكس الفخامة والأصالة الخليجية في أبهى صورها.',
    profiles: [
      { id: 'khl_fatima', name: 'فاطمة', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-AE-FatimaNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي الخليجي المتاح في Edge TTS بلا مفتاح (ar-AE-FatimaNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'khl_hamdan', name: 'حمدان', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-AE-HamdanNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري الخليجي المتاح في Edge TTS بلا مفتاح (ar-AE-HamdanNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'sudanese',
    title: 'اللهجة السودانية',
    description: 'نبرة دافئة، مخارج حروف واضحة، تعكس الطيبة والأصالة السودانية.',
    profiles: [
      { id: 'sud_salma', name: 'سلمى', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-EG-SalmaNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'بديل مصري للهجة السودانية — لا يوجد صوت سوداني أصلي في Edge TTS، فيُستخدم الصوت المصري المتاح بلا مفتاح (ar-EG-SalmaNeural).' },
      { id: 'sud_shakir', name: 'شاكر', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-EG-ShakirNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'بديل مصري للهجة السودانية — لا يوجد صوت سوداني أصلي في Edge TTS، فيُستخدم الصوت المصري المتاح بلا مفتاح (ar-EG-ShakirNeural).' },
    ]
  },
  {
    id: 'yemeni',
    title: 'اللهجة اليمنية',
    description: 'لهجة عريقة، فصاحة فطرية، تعبر عن عمق التراث العربي الأصيل.',
    profiles: [
      { id: 'yem_maryam', name: 'مريم', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-YE-MaryamNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي اليمني المتاح في Edge TTS بلا مفتاح (ar-YE-MaryamNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'yem_saleh', name: 'صالح', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-YE-SalehNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري اليمني المتاح في Edge TTS بلا مفتاح (ar-YE-SalehNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'lebanese',
    title: 'اللهجة اللبنانية',
    description: 'رقة في الأداء، أناقة في التعبير، مثالية للمحتوى الفني والتجاري الراقي.',
    profiles: [
      { id: 'leb_layla', name: 'ليلى', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-LB-LaylaNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي اللبناني المتاح في Edge TTS بلا مفتاح (ar-LB-LaylaNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'leb_rami', name: 'رامي', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-LB-RamiNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري اللبناني المتاح في Edge TTS بلا مفتاح (ar-LB-RamiNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
  {
    id: 'fusha',
    title: 'فصحى',
    description: 'لغة الضاد، معايير النطق السليم، للوثائقيات والتعليم والكتب الصوتية العالمية.',
    profiles: [
      { id: 'fus_zariyah', name: 'زارية', gender: 'female', voiceType: 'بالغ', edgeVoice: 'ar-SA-ZariyahNeural', category: 'صوت Edge TTS متاح', categoryKey: 'novels', description: 'الصوت الأنثوي الفصيح المتاح في Edge TTS بلا مفتاح (ar-SA-ZariyahNeural) — صوت طبيعي واضح يناسب الإعلانات والروايات والبودكاست.' },
      { id: 'fus_hamed', name: 'حامد', gender: 'male', voiceType: 'بالغ', edgeVoice: 'ar-SA-HamedNeural', category: 'صوت Edge TTS متاح', categoryKey: 'doc', description: 'الصوت الذكوري الفصيح المتاح في Edge TTS بلا مفتاح (ar-SA-HamedNeural) — صوت طبيعي واضح يناسب الوثائقيات والإعلانات والبودكاست.' },
    ]
  },
];

export const VOICE_TYPES = [
  'بالغ', 'كبار السن', 'شخصية كارتونية'
];

export const VOICE_FIELDS = [
  { id: 'ads', title: 'مجال الإعلانات التجارية', description: 'صوت سريع ومباشر مليء بالطاقة، مخصّص للمحتوى الترويجي والإعلانات.', tone: 'vs-field' },
  { id: 'doc', title: 'مجال الوثائقيات والأفلام', description: 'صوت عميق ورسمي مناسب للروايات الوثائقية والسرد التاريخي.', tone: 'vs-field' },
  { id: 'cartoon_stories', title: 'مجال الرسوم والمغامرات', description: 'نبرة لطيفة وهادئة مليئة بالخيال لاستهداف القصص التعليمية والترفيهية.', tone: 'vs-field' },
  { id: 'podcast', title: 'مجال البودكاست الصوتي', description: 'أسلوب طبيعي متوازن للمحتوى الحواري والحديث الودي.', tone: 'vs-field' },
  { id: 'novels', title: 'مجال الروايات والكتب الصوتية', description: 'أداء سلس طويل المدى، غني بالتعبير والعمق الأدبي.', tone: 'vs-field' },
  { id: 'youtube', title: 'مجال فيديوهات اليوتيوب', description: 'صوت شبابي متحمس مناسب للمحتوى العام والترفيهي.', tone: 'vs-field' },
  { id: 'corporate', title: 'مجال محتوى الشركات والتعريف المؤسسي', description: 'صوت رسمي واضح مناسب للعروض والتقديمات المهنية.', tone: 'vs-field' },
  { id: 'edu', title: 'مجال التعليم والدروس', description: 'إلقاء واضح ومباشر ومفهوم مناسب للشروحات.', tone: 'vs-field' },
  { id: 'drama', title: 'مجال الدراما والمشاهد التمثيلية', description: 'صوت مليء بالعاطفة، ينقل إحساس التوتر والفرح والحزن.', tone: 'vs-field' }
];

export const STUDIO_CONTROLS = {
  temp: {
    title: 'درجة حرارة الصوت',
    options: [
      { label: 'دافئ', desc: 'صوت دافئ مُشبع بنبرة إنسانية وعمق إحساس.' },
      { label: 'متوازن', desc: 'صوت متوازن ومباشر وموضوعي.' },
      { label: 'حاد', desc: 'صوت حاد محايد قليل العاطفة.' }
    ]
  },
  emotion: {
    title: 'مستوى الانفعال',
    options: [
      { label: 'هادئ', desc: 'إلقاء سلس هادئ مناسب للمحتوى الهادئ.' },
      { label: 'متوسط', desc: 'توازن بين الحماس والهدوء.' },
      { label: 'قوي', desc: 'نبرة مؤثرة مليئة بالحيوية للطاقة الإعلانية.' },
      { label: 'شديد', desc: 'أداء قوي جدًا مناسب للمقاطع الدرامية القصوى.' }
    ]
  },
  speed: {
    title: 'سرعة الإلقاء',
    options: [
      { label: 'بطيئة', desc: 'لتقديم روايات وقصص طويلة بتركيز.' },
      { label: 'متوسطة', desc: 'عامة ومتوازنة لمعظم المحتوى.' },
      { label: 'سريعة', desc: 'للإعلانات والنصوص التسويقية.' }
    ]
  },
  depth: {
    title: 'عمق النبرة',
    options: [
      { label: 'خفيفة', desc: 'نبرة طفولية أو مرحة.' },
      { label: 'متوسطة', desc: 'طبيعية متوازنة.' },
      { label: 'عميقة', desc: 'صوت وثائقي وحكائي قوي.' }
    ]
  },
  pitch: {
    title: 'طبقة الصوت',
    options: [
      { label: 'عالية', desc: 'نبرة مرتفعة تناسب القصص الكرتونية أو الأصوات الشبابية.' },
      { label: 'متوسطة', desc: 'نبرة طبيعية.' },
      { label: 'منخفضة', desc: 'صوت رجولي أو درامي عميق.' }
    ]
  },
  drama: {
    title: 'شدة التأثير الدرامي',
    options: [
      { label: 'خفيف', desc: 'مناسب للمحتوى الواقعي.' },
      { label: 'متوسط', desc: 'مناسب للسرد والأدب.' },
      { label: 'قوي', desc: 'مناسب للوثائقيات والإعلانات الملحمية.' }
    ]
  }
};

export const getBaseVoiceForType = (type, gender) => {
  if (gender === 'female' || gender === 'أنثى') return 'Kore';
  if (type === 'كبار السن') return 'Charon';
  if (type === 'شخصية كارتونية') return 'Kore';
  return 'Fenrir';
};

/* ── محركا التوليد الصوتي ─────────────────────────────────────────────
   edge: محرك Edge TTS المجاني من مايكروسوفت — الافتراضي، بلا مفتاح.
   gemini: مسار Gemini السابق — اختياري، يعمل فقط عند وجود مفتاح
   (GEMINI_API_KEY في البيئة أو مفتاح شخصي في الهيدر). */
export const TTS_ENGINES = ['edge', 'gemini'];
export const TTS_ENGINE_DEFAULT = 'edge';

/* ── خريطة أصوات Edge TTS ────────────────────────────────────────────
   أسماء حقيقية من قائمة الأصوات العربية في خدمة Edge (33 صوتًا عربيًا،
   فُحصت حيًا من بيئة الوكيل): لكل لهجة من الاثنتي عشرة صوت ذكر وأنثى.
   لا يوجد صوت سوداني أصلي (لا ar-SD) — السودانية تستخدم أقرب بديل
   مصري موثّق هنا، مع ملاحظة ظاهرة في الواجهة بذلك.
   نوع الصوت («بالغ/كبار السن/كارتوني») لا يغيّر الصوت — يُترجم لضبط
   prosody في SSML (انظر edgeProsodyForControls في voice-studio-state.js). */
export const EDGE_VOICE_MAP = {
  egyptian: { female: 'ar-EG-SalmaNeural', male: 'ar-EG-ShakirNeural' },
  saudi: { female: 'ar-SA-ZariyahNeural', male: 'ar-SA-HamedNeural' },
  levantine: { female: 'ar-SY-AmanyNeural', male: 'ar-SY-LaithNeural' },
  iraqi: { female: 'ar-IQ-RanaNeural', male: 'ar-IQ-BasselNeural' },
  algerian: { female: 'ar-DZ-AminaNeural', male: 'ar-DZ-IsmaelNeural' },
  moroccan: { female: 'ar-MA-MounaNeural', male: 'ar-MA-JamalNeural' },
  tunisian: { female: 'ar-TN-ReemNeural', male: 'ar-TN-HediNeural' },
  yemeni: { female: 'ar-YE-MaryamNeural', male: 'ar-YE-SalehNeural' },
  lebanese: { female: 'ar-LB-LaylaNeural', male: 'ar-LB-RamiNeural' },
  khaleeji: { female: 'ar-AE-FatimaNeural', male: 'ar-AE-HamdanNeural' },
  sudanese: {
    female: 'ar-EG-SalmaNeural', male: 'ar-EG-ShakirNeural', fallback: true,
  },
  fusha: { female: 'ar-SA-ZariyahNeural', male: 'ar-SA-HamedNeural' },
};

export const SUDANESE_EDGE_FALLBACK_NOTE =
  'ملاحظة: لا يوجد صوت سوداني أصلي في Edge TTS — يُستخدم أقرب بديل مصري (Salma / Shakir).';

export const EDGE_VOICE_DEFAULT = 'ar-SA-ZariyahNeural';

export const PREVIEW_SCRIPTS = {
  ads: 'دلوقتي تقدر توصل فكرتك بصوت واضح ومؤثر يخلي رسالتك توصل بسهولة.',
  doc: 'في هذا الفيلم الوثائقي، نستعرض رحلة مليئة بالتفاصيل والحقائق.',
  podcast: 'أهلاً بيكم، النهارده هنتكلم عن موضوع مهم بشكل بسيط وهادئ.',
  novels: 'وفي ليلة هادئة، بدأت الحكاية من حيث لم يتوقع أحد.',
  corporate: 'نحن نؤمن بتقديم حلول مبتكرة تساعد عملاءنا على النجاح.',
  cartoon: 'يلا بينا نبدأ المغامرة ونشوف إيه اللي هيحصل!',
  youtube: 'أهلاً يا أصدقاء، فيديو النهارده هيكون مميز جداً، خليكم معانا.',
  drama: 'الأحداث تتسارع، والغموض يلف المكان، ماذا سيحدث غداً؟',
  edu: 'في هذا الدرس، سنتعلم مهارات جديدة تساعدنا في تطوير ذواتنا.'
};

export const PREVIEW_FALLBACK_TEXT = 'أهلاً بك في استوديو مدعوم. هذا نموذج لبصمة صوتي المميزة.';

export const WORKFLOW_STEPS = [
  { id: 'new', label: 'المشروع' },
  { id: 'import', label: 'استيراد النص' },
  { id: 'script', label: 'تجهيز النص' },
  { id: 'multi', label: 'توزيع النص' },
  { id: 'pilot', label: 'مقطع تجريبي' },
  { id: 'production', label: 'الإنتاج النهائي' }
];

export const VOICE_PURPOSES = ['إعلان', 'قصصي', 'توعوي', 'إخباري', 'تعليمي'];

export const VOICE_STUDIO_FUNCTION = 'voice-studio';
export const GEMINI_KEY_STORAGE = 'mad3oom_voice_gemini_key';
export const INTRO_STORAGE = 'mad3oom_voice_intro_played';
export const HISTORY_STORAGE = 'mad3oom_voice_history';
export const AUDIOBOOK_STORAGE = 'mad3oom_voice_audiobook';
export const HISTORY_LIMIT = 5;
