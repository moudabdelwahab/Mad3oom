/**
 * voice-studio-data.js — بيانات الاستوديو الصوتي (مدعوم).
 *
 * منقولة من مشروع الاستوديو الصوتي الأصلي (constants.tsx + App.tsx):
 * اللهجات الاثنتا عشرة بكل الأصوات والأوصاف حرفيًا، وأنواع الأصوات،
 * ومجالات الأداء، وأدوات الاستوديو الست، وأنماط الفئات، ونصوص المعاينة،
 * وخطوات مسار الكتاب الصوتي، ودالة الصوت الأساسي حسب النوع والجنس.
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
      { id: 'egy_youssef', name: 'يوسف', gender: 'male', voiceType: 'بالغ', category: 'وثائقي قوي', categoryKey: 'doc', description: 'صوت رجولي عميق يناسب الأفلام الوثائقية والروايات التاريخية بنبرة حاكمة مؤثرة.' },
      { id: 'egy_malek', name: 'مالك', gender: 'male', voiceType: 'بالغ', category: 'إعلاني سريع', categoryKey: 'ads', description: 'صوت سريع وجذاب مخصص لصناعة الإعلانات والمؤثرات التسويقية بأسلوب مرحّب لامع.' },
      { id: 'egy_ramy', name: 'رامي', gender: 'male', voiceType: 'بالغ', category: 'بودكاست هادئ', categoryKey: 'podcast', description: 'صوت محايد وواضح مناسب للبودكاست العربي والمحتوى الهادئ المباشر.' },
      { id: 'egy_seif', name: 'سيف', gender: 'male', voiceType: 'بالغ', category: 'درامي عاطفي', categoryKey: 'drama', description: 'نبرة عميقة مشحونة بالإحساس، مثالية للمشاهد المؤثرة والدراما الإذاعية.' },
      { id: 'egy_zaid', name: 'زيد', gender: 'male', voiceType: 'بالغ', category: 'روايات درامية', categoryKey: 'novels', description: 'صوت مصري ذكوري عميق ومليء بالحيوية يناسب الروايات درامية الطويلة والإلقاء المؤثر.' },
      { id: 'egy_loujin', name: 'لوجين', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتونية مرِحة', categoryKey: 'cartoon', description: 'صوت مصري أنثوي مرتفع النبرة مليء بالضحك والطاقة، مناسب للشخصيات الكوميدية والرسوم المتحركة للأطفال.' },
      { id: 'egy_noura', name: 'نورا', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتونية خيالية', categoryKey: 'cartoon', description: 'صوت مصري ناعم بأسلوب ساحر وخيالي، مثالي للقصص السحرية ومحتوى الأنيمي والقصص الصوتية الخيالية.' },
      { id: 'egy_joumana', name: 'جمانة', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتونية شريرة', categoryKey: 'cartoon', description: 'صوت مصري أنثوي درامي منخفض النبرة ببراعة تمثيلية، مناسب لتقديم شخصية الشريرة والمحتوى الكوميدي الأسود.' },
      { id: 'egy_fares', name: 'فارس', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني كوميدي', categoryKey: 'cartoon', description: 'صوت مصري ذكوري سريع ومُبالغ بنبرة مرحة ساخرة، مناسب لمحتوى الرسوم الكوميدية والشخصيات الخفيفة.' },
      { id: 'egy_zeidan', name: 'زيدان', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني بطل', categoryKey: 'cartoon', description: 'صوت مصري رجولي شبابي ذو نبرة بطولية وواثقة، مناسب لشخصيات الأبطال الكارتونية والمحتوى التشويقي.' },
      { id: 'egy_moumen', name: 'مؤمن', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني شرير', categoryKey: 'cartoon', description: 'صوت مصري ذكوري منخفض بمؤثرات درامية، مناسب لتقديم شخصية الخصم الشرير في القصص المصورة والكارتون.' },
      { id: 'egy_mariam', name: 'مريم', gender: 'female', voiceType: 'بالغ', category: 'صوت قصصي', categoryKey: 'novels', description: 'صوت ناعم ودافئ باللهجة المصرية، مناسب لسرد الحكايات والقصص الخيالية بنبرة هادئة ممتعة.' },
      { id: 'egy_laila', name: 'ليلى', gender: 'female', voiceType: 'بالغ', category: 'إعلان وتسويق', categoryKey: 'ads', description: 'لهجة مصرية أنثوية واضحة ونشيطة، مناسبة للإعلانات التجارية السريعة والفواصل الترويجية.' },
      { id: 'egy_sama', name: 'سما', gender: 'female', voiceType: 'بالغ', category: 'بودكاست ومحتوى اجتماعي', categoryKey: 'podcast', description: 'صوت مصري أنثوي طبيعي ومحايد، مناسب للبودكاست والمحتوى الاجتماعي.' }
    ]
  },
  {
    id: 'saudi',
    title: 'اللهجة السعودية',
    description: 'رصين، فخم، يعكس الهوية السعودية بوضوح واتزان عالي.',
    profiles: [
      { id: 'sau_nasser', name: 'ناصر', gender: 'male', voiceType: 'بالغ', category: 'وثائقي رسمي', categoryKey: 'doc', description: 'صوت سعودي ذكوري عميق ورسمي يناسب الأفلام الوثائقية والتقارير الجادة.' },
      { id: 'sau_rakan', name: 'راكان', gender: 'male', voiceType: 'بالغ', category: 'إعلان تجاري', categoryKey: 'ads', description: 'صوت سعودي شبابي سريع ومؤثر مناسب للإعلانات والمحتوى الترويجي.' },
      { id: 'sau_abdulaziz', name: 'عبد العزيز', gender: 'male', voiceType: 'بالغ', category: 'بودكاست هادئ', categoryKey: 'podcast', description: 'نبرة سعودية واضحة وطبيعية مناسبة للحوارات والبودكاست الصوتي.' },
      { id: 'sau_fahd', name: 'فهد', gender: 'male', voiceType: 'بالغ', category: 'روايات درامية', categoryKey: 'novels', description: 'صوت سعودي مليء بالعاطفة مناسب للروايات الطويلة والسرد القصصي.' },
      { id: 'sau_mohsen', name: 'محسن', gender: 'male', voiceType: 'بالغ', category: 'صوت شركات', categoryKey: 'corporate', description: 'صوت رسمي قوي مناسب للتقديم المؤسسي والعروض المهنية.' },
      { id: 'sau_jawhara', name: 'الجوهرة', gender: 'female', voiceType: 'بالغ', category: 'وثائقي أنثوي', categoryKey: 'doc', description: 'نبرة رسمية قوية، مناسبة للروايات والقصص الوثائقية.' },
      { id: 'sau_afnan', name: 'أفنان', gender: 'female', voiceType: 'بالغ', category: 'إعلان وتسويق', categoryKey: 'ads', description: 'صوت سعودي أنثوي سريع وجذاب للإعلانات والفواصل الدعائية.' },
      { id: 'sau_mouna', name: 'منى', gender: 'female', voiceType: 'بالغ', category: 'بودكاست اجتماعي', categoryKey: 'podcast', description: 'صوت هادئ وطبيعي مناسب للمحتوى الاجتماعي والحوارات الصوتية.' },
      { id: 'sau_haya', name: 'هيا', gender: 'female', voiceType: 'بالغ', category: 'روايات صوتية', categoryKey: 'novels', description: 'صوت غني بالإحساس والأداء مناسب للروايات والقصص الطويلة.' },
      { id: 'sau_bdour', name: 'بدور', gender: 'female', voiceType: 'بالغ', category: 'تعليم وشروحات', categoryKey: 'edu', description: 'صوت واضح ومفهوم مناسب للدروس التعليمية والشروحات.' },
      { id: 'sau_loulou', name: 'لولو', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتونية مرحة أنثى', categoryKey: 'cartoon', description: 'صوت سعودي خفيف مناسب للمحتوى الكوميدي الكارتوني.' },
      { id: 'sau_fawaz', name: 'فواز', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني ساخر ذكر', categoryKey: 'cartoon', description: 'صوت سعودي مرح مناسب للشخصيات الفكاهية والأنيمي.' }
    ]
  },
  {
    id: 'levantine',
    title: 'اللهجة الشامية',
    description: 'صوت عذب، موسيقي، رائع للروايات والقصص الرومانسية والدراما.',
    profiles: [
      { id: 'lev_rabie', name: 'ربيع', gender: 'male', voiceType: 'بالغ', category: 'وثائقي درامي', categoryKey: 'doc', description: 'صوت ذكوري شامي عميق ومؤثر يناسب الوثائقيات الروايات التاريخية بنبرة درامية قوية.' },
      { id: 'lev_jad', name: 'جاد', gender: 'male', voiceType: 'بالغ', category: 'إعلان تجاري', categoryKey: 'ads', description: 'صوت شبابي سريع وروّاق باللهجة الشامية مناسب للإعلانات والفواصل الدعائية.' },
      { id: 'lev_youssef', name: 'يوسف شامي', gender: 'male', voiceType: 'بالغ', category: 'بودكاست', categoryKey: 'podcast', description: 'صوت هادئ ومباشر مناسب للمحتوى الحواري الشامي والبودكاست التعليمي.' },
      { id: 'lev_milad', name: 'ميلاد', gender: 'male', voiceType: 'بالغ', category: 'روايات', categoryKey: 'novels', description: 'صوت شامي ناعم ورنان مناسب للقصص والروايات الطويلة مع تفاصيل أداء دقيقة.' },
      { id: 'lev_leen', name: 'لين', gender: 'female', voiceType: 'بالغ', category: 'قصص رومانسية', categoryKey: 'novels', description: 'صوت نسائي شامي دافئ مناسب للروايات الرومانسية والمشاهد الوجدانية.' },
      { id: 'lev_rahaf', name: 'رهف', gender: 'female', voiceType: 'بالغ', category: 'إعلانات', categoryKey: 'ads', description: 'نبرة تجارية واضحة باللهجة الشامية مناسبة للإعلانات والفيديوهات السريعة.' },
      { id: 'lev_nour', name: 'نور', gender: 'female', voiceType: 'بالغ', category: 'بودكاست', categoryKey: 'podcast', description: 'صوت هاديء باللهجة الشامية مناسب للحوارات والمحتوى الاجتماعي.' },
      { id: 'lev_bebo', name: 'بيبو', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني فكاهي ذكوري', categoryKey: 'cartoon', description: 'صوت مرح ومتحرك باللهجة الشامية مناسب لشخصيات الرسوم المتحركة الكوميدية.' },
      { id: 'lev_lilia', name: 'ليليا', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتونية لطيفة أنثى', categoryKey: 'cartoon', description: 'صوت أنثوي شامي خيالي مناسب للقصص الصوتية الكارتونية والأنمي.' }
    ]
  },
  {
    id: 'iraqi',
    title: 'اللهجة العراقية',
    description: 'عميق، شجي، يحمل قوة التعبير والأصالة الرافدينية العريقة.',
    profiles: [
      { id: 'irq_ali', name: 'علي', gender: 'male', voiceType: 'بالغ', category: 'قصص شعبية', categoryKey: 'drama', description: 'صوت ذكوري عراقي عاطفي غني بالتعبير الشعبي، مناسب للروايات التراثية والمحتوى الدرامي.' },
      { id: 'irq_mohanad', name: 'مهند', gender: 'male', voiceType: 'بالغ', category: 'إعلان تجاري', categoryKey: 'ads', description: 'صوت عراقي شبابي سريع ومؤثر يناسب الإعلانات والمحتوى التسويقية.' },
      { id: 'irq_haider', name: 'حيدر', gender: 'male', voiceType: 'بالغ', category: 'بودكاست واقعي', categoryKey: 'podcast', description: 'نبرة عراقية هادئة ومباشرة مناسبة للبودكاست والنقاش الاجتماعي.' },
      { id: 'irq_samar', name: 'سمر', gender: 'female', voiceType: 'بالغ', category: 'قصص شعبية', categoryKey: 'drama', description: 'صوت أنثوي عراقي مليء بالأصالة والروح العربية، مناسب للقصص الحوارات الإنسانية.' },
      { id: 'irq_zahraa', name: 'زهراء', gender: 'female', voiceType: 'بالغ', category: 'بودكاست', categoryKey: 'podcast', description: 'صوت واضح وطبيعي باللهجة العراقية مناسب للمحتوى التثقيفي والحوار الودي.' },
      { id: 'irq_mimo', name: 'ميمو', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني فكاهي', categoryKey: 'cartoon', description: 'صوت مضحك وسريع باللهجة العراقية مناسب لشخصيات الرسوم المتحركة الكوميدية.' },
      { id: 'irq_louli', name: 'لولي', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتوني خيالي', categoryKey: 'cartoon', description: 'صوت لطيف وخيالي باللهجة العراقية مناسب للقصص الصوتية الكارتونية.' }
    ]
  },
  {
    id: 'algerian',
    title: 'اللهجة الجزائرية',
    description: 'لهجة غنية، تمزج بين القوة والنعومة، مثالية للوصول لجمهور المغرب العربي بوضوح.',
    profiles: [
      { id: 'alg_anwar', name: 'أنور', gender: 'male', voiceType: 'بالغ', category: 'محتوى وثائقي', categoryKey: 'doc', description: 'صوت ذكوري جزائري عميق بنبرة هادئة، مناسب للأفلام الوثائقية والمحتوى التاريخي.' },
      { id: 'alg_qais', name: 'قيس', gender: 'male', voiceType: 'بالغ', category: 'إعلان تجاري', categoryKey: 'ads', description: 'صوت جزائري شبابي سريع ومؤثر، مناسب للإعلانات والمحتوى التسويقي.' },
      { id: 'alg_hakim', name: 'حكيم', gender: 'male', voiceType: 'بالغ', category: 'بودكاست ثقافي', categoryKey: 'podcast', description: 'صوت واضح وطبيعي باللهجة الجزائرية مناسب للحوار الثقافي والبودكاست.' },
      { id: 'alg_ayda', name: 'عايدة', gender: 'female', voiceType: 'بالغ', category: 'روايات', categoryKey: 'novels', description: 'صوت أنثوي جزائري دافئ مناسب للقصص والروايات الصوتية الطويلة.' },
      { id: 'alg_hajar', name: 'هاجر', gender: 'female', voiceType: 'بالغ', category: 'إعلان وتسويق', categoryKey: 'ads', description: 'نبرة أنثوية نشيطة باللهجة الجزائرية مناسبة للإعلانات والفيديوهات القصيرة.' },
      { id: 'alg_mimo_j', name: 'ميمو', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني ذكوري', categoryKey: 'cartoon', description: 'صوت مضحك سريع باللهجة الجزائرية مناسب للشخصيات الفكاهية الكارتونية.' },
      { id: 'alg_silia', name: 'سيليا', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتونية أنثى', categoryKey: 'cartoon', description: 'صوت أنثوي لطيف مناسب للقصص الكارتونية والأنيمي.' }
    ]
  },
  {
    id: 'moroccan',
    title: 'اللهجة المغربية',
    description: 'إيقاع مميز، غني بالتفاصيل، للوصول لجمهور المغرب العربي بذكاء.',
    profiles: [
      { id: 'mor_mahdi', name: 'المهدي', gender: 'male', voiceType: 'تقديم معلوماتي', category: 'edu', categoryKey: 'edu', description: 'صوت ذكوري مغربي متوازن غني بالوضوح، مناسب للفيديوهات التثقيفية والشرح.' },
      { id: 'mor_tariq', name: 'طارق', gender: 'male', voiceType: 'بالغ', category: 'روايات صوتية', categoryKey: 'novels', description: 'صوت مغربي دافئ مناسب للروايات والكتب الصوتية بنبرة قصصية جذابة.' },
      { id: 'mor_amin', name: 'أمين', gender: 'male', voiceType: 'بالغ', category: 'محتوى اجتماعي', categoryKey: 'podcast', description: 'صوت طبيعي خفيف باللهجة المغربية مناسب للمحتوى الاجتماعي والبودكاست اليومي.' },
      { id: 'mor_sara', name: 'سارة', gender: 'female', voiceType: 'بالغ', category: 'بودكاست مريح', categoryKey: 'podcast', description: 'صوت أنثوي مغربي هادىء وواضح، مناسب للبودكاست والمحتوى الهادئ.' },
      { id: 'mor_reem', name: 'ريم', gender: 'female', voiceType: 'بالغ', category: 'إعلان سريع', categoryKey: 'ads', description: 'صوت أنثوي تجاري باللهجة المغربية مناسب للإعلانات والمحتوى السريع المقنع.' },
      { id: 'mor_mimoun', name: 'ميمون', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني ذكوري', categoryKey: 'cartoon', description: 'صوت مضحك وخفيف باللهجة المغربية مناسب لشخصيات الرسوم المتحركة.' },
      { id: 'mor_lima', name: 'ليما', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتونية أنثى', categoryKey: 'cartoon', description: 'صوت لطيف وخيالي باللهجة المغربية مناسب للقصص الصوتية الهادئة للأطفال.' }
    ]
  },
  {
    id: 'tunisian',
    title: 'اللهجة التونسية',
    description: 'لبق، منفتح، مثالي للمحتوى الثقافي والاجتماعي المعاصر.',
    profiles: [
      { id: 'tun_karim', name: 'كريم', gender: 'male', voiceType: 'بالغ', category: 'محتوى ثقافي', categoryKey: 'doc', description: 'صوت ذكوري تونسي متوازن مناسب للمحتوى التاريخي والثقافي والروايات الوثائقية.' },
      { id: 'tun_nader', name: 'نادر', gender: 'male', voiceType: 'بالغ', category: 'إعلان تجاري', categoryKey: 'ads', description: 'صوت تونسي شبابي سريع ونشط مناسب للإعلانات التجارية والحملات الترويجية.' },
      { id: 'tun_hossam', name: 'حسام', gender: 'male', voiceType: 'بالغ', category: 'بودكاست اجتماعي', categoryKey: 'podcast', description: 'نبرة تونسية هادئة وطبيعية مناسبة للبودكاست والحوار الاجتماعي اليومي.' },
      { id: 'tun_laila', name: 'ليلى', gender: 'female', voiceType: 'بالغ', category: 'قصص درامية', categoryKey: 'novels', description: 'صوت أنثوي تونسي عميق مناسب للروايات الطويلة والمحتوى الأدبي.' },
      { id: 'tun_yousra', name: 'يسرى', gender: 'female', voiceType: 'بالغ', category: 'إعلان وتسويق', categoryKey: 'ads', description: 'صوت أنثوي سريع وجذاب باللهجة التونسية مناسب للإعلانات والفيديوهات القصيرة.' },
      { id: 'tun_mimi', name: 'ميمي', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتوني أنثى', categoryKey: 'cartoon', description: 'صوت تونسي خفيف مناسب للشخصيات الأنثوية الكارتونية والرسوم المتحركة.' },
      /* Fixed: Removed duplicate 'name' property on line 149 */
      { id: 'tun_poulino', name: 'بولينو', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني ذكوري', categoryKey: 'cartoon', description: 'صوت تونسي فكاهي مناسب للمحتوى المضحك والأنيمي العربي.' }
    ]
  },
  {
    id: 'khaleeji',
    title: 'خليجية',
    description: 'أداء هادئ وواثق، يعكس الفخامة والأصالة الخليجية في أبهى صورها.',
    profiles: [
      { id: 'khl_jasim', name: 'جاسم', gender: 'male', voiceType: 'بالغ', category: 'إعلان تجاري', categoryKey: 'ads', description: 'صوت خليجي ذكوري سريع ومقنع مناسب للإعلانات والفيديوهات الدعائية.' },
      { id: 'khl_rashid', name: 'راشد', gender: 'male', voiceType: 'بالغ', category: 'وثائقي عاطفي', categoryKey: 'doc', description: 'صوت خليجي عميق مناسب للروايات والقصص التاريخية والمحتوى الوثائقي.' },
      { id: 'khl_fahd', name: 'فهد خليجي', gender: 'male', voiceType: 'بالغ', category: 'بودكاست اجتماعي', categoryKey: 'podcast', description: 'نبرة خليجية واقعية مناسبة للبودكاست والحوار الاجتماعي.' },
      { id: 'khl_mai', name: 'مي', gender: 'female', voiceType: 'بالغ', category: 'قصص صوتية', categoryKey: 'novels', description: 'صوت خليجي أنثوي ناعم مناسب للروايات القصيرة والقصص الحقيقية.' },
      { id: 'khl_lamia', name: 'لمياء', gender: 'female', voiceType: 'بالغ', category: 'إعلان تجاري', categoryKey: 'ads', description: 'صوت خليجي سريع ولامع مناسب للإعلانات والمحتوى التسويقي السريع.' },
      { id: 'khl_mimi', name: 'ميمي', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كارتوني أنثى', categoryKey: 'cartoon', description: 'صوت خفيف باللهجة الخليجية مناسب للشخصيات الكارتونية المرحة.' },
      { id: 'khl_loulan', name: 'لؤلان', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كارتوني ذكوري', categoryKey: 'cartoon', description: 'صوت مضحك ومتحرك باللهجة الخليجية مناسب للأنمي والمحتوى الفكاهي.' }
    ]
  },
  {
    id: 'sudanese',
    title: 'اللهجة السودانية',
    description: 'نبرة دافئة، مخارج حروف واضحة، تعكس الطيبة والأصالة السودانية.',
    profiles: [
      { id: 'sud_idris', name: 'إدريس', gender: 'male', voiceType: 'بالغ', category: 'إذاعي / وثائقي', categoryKey: 'doc', description: 'صوت سوداني عميق ورسمي، مثالي للأفلام الوثائقية والتقديم الإذاعي الجاد.' },
      { id: 'sud_mazen', name: 'مازن', gender: 'male', voiceType: 'بالغ', category: 'إعلاني نشط', categoryKey: 'ads', description: 'نبرة شبابية سودانية سريعة وحيوية، مخصصة للإعلانات التجارية والحملات.' },
      { id: 'sud_othman', name: 'عثمان', gender: 'male', voiceType: 'بالغ', category: 'سردي دافئ', categoryKey: 'novels', description: 'أداء قصصي سوداني متوازن، يمنح المستمع شعوراً بالألفة والدفء في الروايات.' },
      { id: 'sud_sadiq', name: 'الصادق', gender: 'male', voiceType: 'بالغ', category: 'بودكاست طبيعي', categoryKey: 'podcast', description: 'صوت مريح وعفوي، مناسب جداً للمحتوى الحواري والنقاشات الطويلة.' },
      { id: 'sud_eithar', name: 'إيثار', gender: 'female', voiceType: 'بالغ', category: 'إعلاني / تعريفي', categoryKey: 'ads', description: 'صوت أنثوي سوداني واضح وحيوي، مناسب للإعلانات والرسائل التعريفية.' },
      { id: 'sud_rayan', name: 'ريان', gender: 'female', voiceType: 'بالغ', category: 'قصصي / سردي', categoryKey: 'novels', description: 'نبرة ناعمة ومعبرة، تبرع في سرد الحكايات والقصص الإنسانية المؤثرة.' },
      { id: 'sud_tasneem', name: 'تسنيم', gender: 'female', voiceType: 'بالغ', category: 'محتوى تعليمي', categoryKey: 'edu', description: 'صوت متزن وهادئ، مخارج حروف سليمة تناسب الشروحات والدروس التعليمية.' }
    ]
  },
  {
    id: 'yemeni',
    title: 'اللهجة اليمنية',
    description: 'لهجة عريقة، فصاحة فطرية، تعبر عن عمق التراث العربي الأصيل.',
    profiles: [
      { id: 'yem_hamza', name: 'حمزة', gender: 'male', voiceType: 'بالغ', category: 'إذاعي / وثائقي', categoryKey: 'doc', description: 'فخامة يمنية في الإلقاء، نبرة عميقة تناسب الوثائقيات التاريخية الكبرى.' },
      { id: 'yem_waddah', name: 'وضاح', gender: 'male', voiceType: 'بالغ', category: 'إعلاني جذاب', categoryKey: 'ads', description: 'صوت يمني نشط وتسويقي، يجذب الانتباه للإعلانات بأسلوب عصري جذاب.' },
      { id: 'yem_seif', name: 'سيف', gender: 'male', voiceType: 'بالغ', category: 'سردي متوازن', categoryKey: 'novels', description: 'صوت دافئ يعكس روح الحكواتي اليمني، مناسب للروايات والكتب الصوتية.' },
      { id: 'yem_moath', name: 'معاذ', gender: 'male', voiceType: 'بالغ', category: 'بودكاست حواري', categoryKey: 'podcast', description: 'نبرة يمنية بيضاء، طبيعية ومريحة للحوارات والبودكاست اليومي.' },
      { id: 'yem_balqis', name: 'بلقيس', gender: 'female', voiceType: 'بالغ', category: 'إعلاني / تعريفي', categoryKey: 'ads', description: 'صوت أنثوي يمني واثق ولامع، مثالي للمحتوى الترويجي والتعريفي.' },
      { id: 'yem_arwa', name: 'أروى', gender: 'female', voiceType: 'بالغ', category: 'قصصي / سردي', categoryKey: 'novels', description: 'نبرة ناعمة مليئة بالإحساس، تضفي طابعاً إنسانياً فريداً على القصص والسير.' },
      { id: 'yem_maab', name: 'مآب', gender: 'female', voiceType: 'بالغ', category: 'محتوى تعليمي', categoryKey: 'edu', description: 'صوت هادئ ومخارج حروف واضحة جداً، مثالي للمنصات التعليمية والشرح.' }
    ]
  },
  {
    id: 'lebanese',
    title: 'اللهجة اللبنانية',
    description: 'رقة في الأداء، أناقة في التعبير، مثالية للمحتوى الفني والتجاري الراقي.',
    profiles: [
      { id: 'leb_fouad', name: 'فؤاد', gender: 'male', voiceType: 'بالغ', category: 'وثائقي رسمي', categoryKey: 'doc', description: 'صوت لبناني عميق وواضح، يمنح المحتوى الوثائقي طابعاً من الفخامة والرزانة.' },
      { id: 'leb_tariq', name: 'طارق', gender: 'male', voiceType: 'بالغ', category: 'إعلاني نشط', categoryKey: 'ads', description: 'نبرة لبنانية تسويقية بامتياز، سريعة وجذابة للحملات الإعلانية اللامعة.' },
      { id: 'leb_ramy', name: 'رامي لبناني', gender: 'male', voiceType: 'بالغ', category: 'سردي دافئ', categoryKey: 'novels', description: 'أداء ناعم ومتزن، مناسب جداً للروايات الرومانسية والسرد الأدبي الراقي.' },
      { id: 'leb_ziyad', name: 'زياد لبناني', gender: 'male', voiceType: 'بالغ', category: 'بودكاست مريح', categoryKey: 'podcast', description: 'صوت طبيعي ومباشر، يعكس أسلوب الحديث اللبناني العفوي في البودكاست.' },
      { id: 'leb_nadine', name: 'نادين', gender: 'female', voiceType: 'بالغ', category: 'إعلاني / تعريفي', categoryKey: 'ads', description: 'صوت أنثوي لبناني أنيق وحيوي، مخصص للإعلانات الراقية والتقديم التعريفي.' },
      { id: 'leb_yara', name: 'يارا', gender: 'female', voiceType: 'بالغ', category: 'قصصي / سردي', categoryKey: 'novels', description: 'نبرة معبرة جداً وناعمة، تبدع في السرد القصصي والمحتوى الدرامي الوجداني.' },
      { id: 'leb_lana', name: 'لانا', gender: 'female', voiceType: 'بالغ', category: 'محتوى عام', categoryKey: 'edu', description: 'صوت متوازن وهادئ، مناسب للفيديوهات التعليمية والمحتوى العام بوضوح عالٍ.' }
    ]
  },
  {
    id: 'fusha',
    title: 'فصحى',
    description: 'لغة الضاد، معايير النطق السليم، للوثائقيات والتعليم والكتب الصوتية العالمية.',
    profiles: [
      { id: 'fus_tariq', name: 'طارق', gender: 'male', voiceType: 'بالغ', category: 'روايات', categoryKey: 'novels', description: 'صوت عربي فصيح ثابت وواضح مناسب للكتب والروايات الصوتية الطويلة.' },
      { id: 'fus_samer', name: 'سامر', gender: 'male', voiceType: 'بالغ', category: 'وثائقي تاريخي', categoryKey: 'doc', description: 'صوت فصيح عميق مناسب للأفلام الوثائقية والمحتوى التاريخي والوطني.' },
      { id: 'fus_nadeem', name: 'نديم', gender: 'male', voiceType: 'بالغ', category: 'تقديم رسمي', categoryKey: 'corporate', description: 'صوت فصيح إعلامي مناسب لنشرات الأخبار والعروض الرسمية.' },
      { id: 'fus_ziyad', name: 'زياد', gender: 'male', voiceType: 'بالغ', category: 'إعلاني فصيح', categoryKey: 'ads', description: 'صوت عربي فصيح سريع ومقنع مناسب للإعلانات والعروض التجارية وإعلانات الخدمات والتنبيهات الصوتية.' },
      { id: 'fus_hossam', name: 'حسام', gender: 'male', voiceType: 'بالغ', category: 'بودكاست هادئ', categoryKey: 'podcast', description: 'صوت فصيح بسيط وهادئ بأسلوب محادثة سلس، مناسب للبودكاست العربي والحوار التفسيري والنقاش الاجتماعي.' },
      { id: 'fus_salma', name: 'سلمى', gender: 'female', voiceType: 'بالغ', category: 'تعليم ودروس', categoryKey: 'edu', description: 'صوت أنثوي فصيح واضح مناسب للشرح والتدريس والسرد الأكاديمي.' },
      { id: 'fus_joud', name: 'جود', gender: 'female', voiceType: 'بالغ', category: 'قصص أدبية', categoryKey: 'novels', description: 'صوت فصيح ناعم مناسب للروايات والقصص الطويلة والإلقاء الأدبي.' },
      { id: 'fus_anime_m', name: 'بطل كرتون', gender: 'male', voiceType: 'شخصية كارتونية', category: 'كرتوني', categoryKey: 'cartoon', description: 'صوت فكاهي مرتفع بالفصحى مناسب لعروض الكرتون والأنيمي.' },
      { id: 'fus_anime_f', name: 'بطلة كرتون', gender: 'female', voiceType: 'شخصية كارتونية', category: 'كرتوني', categoryKey: 'cartoon', description: 'صوت مرح مناسب للشخصيات الكارتونية والخيالية بالفصحى.' },
      { id: 'fus_eld_abdulrahman', name: 'عبد الرحمن', gender: 'male', voiceType: 'كبار السن', category: 'وثائقي تاريخي', categoryKey: 'doc', description: 'صوت ذكوري عربي هادئ وعميق بنبرة خبرة ووقار، مناسب للوثائقيات التاريخية.' },
      { id: 'fus_eld_hassan', name: 'حسان', gender: 'male', voiceType: 'كبار السن', category: 'حكيم سردي', categoryKey: 'podcast', description: 'صوت هادىء يشبه حكمة الشيوخ، يناسب القصص الفلسفية والنصائح.' },
      { id: 'fus_eld_farouk', name: 'فاروق', gender: 'male', voiceType: 'كبار السن', category: 'مذيع إذاعي مخضرم', categoryKey: 'corporate', description: 'نبرة إذاعية قديمة مع عمق صوتي واضح، مناسب للبرامج الإذاعية الكلاسيكية.' },
      { id: 'fus_eld_salah', name: 'صلاح', gender: 'male', voiceType: 'كبار السن', category: 'راوي روايات أدبية', categoryKey: 'novels', description: 'صوت ثقيل ورنان، مناسب للكتب الصوتية بنبرة تأملية مريحة.' },
      { id: 'fus_eld_adnan', name: 'عدنان', gender: 'male', voiceType: 'كبار السن', category: 'صوت درامي تمثيلي', categoryKey: 'drama', description: 'صوت كبير السن مليء بالعاطفة، مناسب للمشاهد الدرامية والمحتوى المؤثر.' },
      { id: 'fus_eld_khadija', name: 'خديجة', gender: 'female', voiceType: 'كبار السن', category: 'صوت أم حنونة', categoryKey: 'drama', description: 'نبرة عربية دافئة تشبه صوت أم كبيرة السن، مناسبة للقصص العائلية.' },
      { id: 'fus_eld_aisha', name: 'عائشة', gender: 'female', voiceType: 'كبار السن', category: 'روايات أدبية', categoryKey: 'novels', description: 'صوت عربي رزين ذو شخصية قوية، مناسب للروايات النسائية.' },
      { id: 'fus_eld_sharifa', name: 'شريفة', gender: 'female', voiceType: 'كبار السن', category: 'صوت تراثي ثقافي', categoryKey: 'doc', description: 'صوت أنثوي كبير السن بإحساس شعبي تراثي، مناسب للحكايات القديمة.' },
      { id: 'fus_eld_najlaa', name: 'نجلاء', gender: 'female', voiceType: 'كبار السن', category: 'بودكاست الحكمة', categoryKey: 'podcast', description: 'صوت صريح وواضح مليء بالخبرة، مناسب للمحتوى الفكري والنصيحة.' },
      { id: 'fus_eld_rajaa', name: 'رجاء', gender: 'female', voiceType: 'كبار السن', category: 'صوت درامي تمثيلي', categoryKey: 'drama', description: 'نبرة أنثوية قوية مع مساحات إحساس واضحة، مناسبة للدراما.' }
    ]
  }
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
