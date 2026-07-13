/* ============================================================================
   OLS seed data — Omani curriculum structure (KG–12), official sources,
   and starter library / lessons / exercises / tests content.

   Textbook PDFs are copyrighted by the Omani Ministry of Education, so OLS
   does NOT host them. Instead each book links to the OFFICIAL source
   (omanedubooks.com / moe.gov.om) where the learner opens or downloads it.
   Admins can also upload their own media/documents into the Library & Lessons,
   which are stored on the OLS server and shared across devices.
   ========================================================================== */
(function () {
  'use strict';

  // Official learning-source links (from OLS-Links.docx)
  const OFFICIAL = [
    {name: 'بوابة الكتب التفاعلية — وزارة التربية والتعليم', url: 'https://ict.moe.gov.om/book/', note: 'الكتب المدرسية التفاعلية الرسمية لجميع الصفوف.', tag: 'رسمي'},
    {name: 'المكتبة التعليمية — وزارة التربية والتعليم', url: 'https://home.moe.gov.om/library/99', note: 'مكتبة المصادر والمناهج الرسمية.', tag: 'رسمي'},
    {name: 'مصادر تعليمية (Google Drive)', url: 'https://drive.google.com/file/d/1Yz3JNx6TOndoby29ST5QKrvHDBeKulAE/view', note: 'ملف مصادر تعليمية مساندة.', tag: 'مصدر'},
    {name: 'كتب عُمان التعليمية — علوم الصف الأول (ج1)', url: 'https://www.omanedubooks.com/2024/08/Science-class1-p1.html', note: 'كتاب العلوم للصف الأول — الفصل الأول.', tag: 'كتاب'},
    {name: 'كتب عُمان التعليمية — الصف الأول (فصل 2)', url: 'https://www.omanedubooks.com/p/grade-1-book-s2_17.html', note: 'كتب الصف الأول — الفصل الدراسي الثاني.', tag: 'كتاب'},
    {name: 'كتب عُمان التعليمية — بحث الصف الأول', url: 'https://www.omanedubooks.com/search?q=%D8%A7%D9%84%D8%B5%D9%81+%D8%A7%D9%84%D8%A7%D9%88%D9%84', note: 'نتائج بحث كتب الصف الأول.', tag: 'بحث'},
  ];

  const GRADE_AR = ['', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر', 'الحادي عشر', 'الثاني عشر'];

  // subject sets by stage
  const SUB_KG = ['أساسيات القراءة والكتابة', 'أساسيات الحساب', 'اكتشاف العالم', 'المهارات الحياتية', 'الفنون والأناشيد'];
  const SUB_C1 = ['التربية الإسلامية', 'اللغة العربية', 'اللغة الإنجليزية', 'الرياضيات', 'العلوم', 'الدراسات الاجتماعية', 'المهارات الحياتية', 'الفنون التشكيلية', 'الرياضة المدرسية'];
  const SUB_C2 = SUB_C1.concat(['تقنية المعلومات', 'المهارات الموسيقية']);
  const SUB_PB = ['التربية الإسلامية', 'اللغة العربية', 'اللغة الإنجليزية', 'الرياضيات', 'الفيزياء', 'الكيمياء', 'الأحياء', 'الجيولوجيا وعلوم البيئة', 'الدراسات الاجتماعية', 'تقنية المعلومات'];

  function subjectsFor(grade) {
    if (grade === 0) return SUB_KG;
    if (grade <= 4) return SUB_C1;
    if (grade <= 10) return SUB_C2;
    return SUB_PB;
  }
  function stageFor(grade) {
    if (grade === 0) return 'رياض الأطفال';
    if (grade <= 4) return 'الحلقة الأولى';
    if (grade <= 9) return 'الحلقة الثانية';
    if (grade === 10) return 'التعليم الأساسي';
    return 'التعليم ما بعد الأساسي';
  }
  const searchUrl = q => 'https://www.omanedubooks.com/search?q=' + encodeURIComponent(q);

  // per-grade explicit overrides for specific official book links
  const OVERRIDES = {
    1: {
      'العلوم': {1: 'https://www.omanedubooks.com/2024/08/Science-class1-p1.html'},
      '_s2': 'https://www.omanedubooks.com/p/grade-1-book-s2_17.html',
    }
  };

  function booksFor(grade) {
    const subs = subjectsFor(grade);
    const gradeName = grade === 0 ? 'رياض الأطفال' : 'الصف ' + GRADE_AR[grade];
    const ov = OVERRIDES[grade] || {};
    const mk = (sem) => subs.map(sub => {
      let url = searchUrl(gradeName + ' ' + sub);
      if (ov[sub] && ov[sub][sem]) url = ov[sub][sem];
      else if (sem === 2 && ov._s2) url = ov._s2;
      return {subject: sub, title: 'كتاب ' + sub, source: url, official: true};
    });
    return {1: mk(1), 2: mk(2)};
  }

  const levels = [];
  levels.push({id: 'kg', grade: 0, name: 'رياض الأطفال', stage: stageFor(0), subjects: subjectsFor(0), books: booksFor(0), kindergarten: true});
  for (let g = 1; g <= 12; g++) {
    levels.push({id: 'g' + g, grade: g, name: 'الصف ' + GRADE_AR[g], stage: stageFor(g), subjects: subjectsFor(g), books: booksFor(g)});
  }

  // Starter library (official sources surfaced as browsable cards)
  const library = [
    {id: 'lib-portal-1', title: 'الكتب التفاعلية الرسمية', author: 'وزارة التربية والتعليم', subject: 'عام', grade: 0, kind: 'link', url: 'https://ict.moe.gov.om/book/', desc: 'المنصة الرسمية للكتب المدرسية التفاعلية لجميع الصفوف.', cover: '#0e7c66'},
    {id: 'lib-portal-2', title: 'المكتبة التعليمية للوزارة', author: 'وزارة التربية والتعليم', subject: 'عام', grade: 0, kind: 'link', url: 'https://home.moe.gov.om/library/99', desc: 'مصادر ومناهج تعليمية رسمية.', cover: '#12a37d'},
    {id: 'lib-sci-1', title: 'العلوم — الصف الأول (ج1)', author: 'وزارة التربية والتعليم', subject: 'العلوم', grade: 1, kind: 'link', url: 'https://www.omanedubooks.com/2024/08/Science-class1-p1.html', desc: 'كتاب العلوم للصف الأول، الفصل الدراسي الأول.', cover: '#2563eb'},
    {id: 'lib-g1-s2', title: 'كتب الصف الأول — الفصل الثاني', author: 'وزارة التربية والتعليم', subject: 'عام', grade: 1, kind: 'link', url: 'https://www.omanedubooks.com/p/grade-1-book-s2_17.html', desc: 'مجموعة كتب الصف الأول للفصل الدراسي الثاني.', cover: '#7c3aed'},
  ];

  // Starter lessons (admins add real video/audio which upload to the server)
  const lessons = [
    {id: 'les-1', title: 'مقدمة في الأعداد (1–10)', subject: 'الرياضيات', grade: 1, type: 'video', embed: '', desc: 'درس تمهيدي للتعرف على الأعداد من 1 إلى 10 وعدّ المجسّمات.', duration: '08:20'},
    {id: 'les-2', title: 'الحروف الهجائية — أصواتها', subject: 'اللغة العربية', grade: 1, type: 'audio', embed: '', desc: 'نطق الحروف الهجائية وأصواتها مع أمثلة.', duration: '05:10'},
  ];

  // Starter skill exercises (auto-checkable)
  const exercises = [
    {id: 'ex-add', title: 'جمع الأعداد', subject: 'الرياضيات', grade: 1, skill: 'الحساب الذهني', kind: 'math-add', desc: 'تمارين جمع سريعة لتقوية الحساب الذهني.'},
    {id: 'ex-sub', title: 'طرح الأعداد', subject: 'الرياضيات', grade: 2, skill: 'الحساب الذهني', kind: 'math-sub', desc: 'تمارين طرح متدرجة.'},
    {id: 'ex-letters', title: 'ترتيب الحروف', subject: 'اللغة العربية', grade: 1, skill: 'القراءة', kind: 'order', desc: 'رتّب الحروف لتكوين كلمة صحيحة.',
      items: [{scrambled: ['م', 'ل', 'ق'], answer: 'قلم'}, {scrambled: ['ب', 'ا', 'ب'], answer: 'باب'}, {scrambled: ['د', 'ر', 'س'], answer: 'درس'}]},
  ];

  // Starter interactive tests (answered & scored in-page)
  const tests = [
    {id: 'test-math-1', title: 'اختبار الرياضيات — الصف الأول', subject: 'الرياضيات', grade: 1, minutes: 10,
      questions: [
        {q: 'كم يساوي 3 + 4 ؟', choices: ['6', '7', '8', '9'], answer: 1},
        {q: 'ما العدد الذي يأتي بعد 9 ؟', choices: ['8', '10', '11', '7'], answer: 1},
        {q: 'كم يساوي 5 − 2 ؟', choices: ['2', '3', '4', '5'], answer: 1},
        {q: 'أي الأعداد هو الأكبر؟', choices: ['4', '2', '8', '6'], answer: 2},
      ]},
    {id: 'test-ar-1', title: 'اختبار اللغة العربية — الصف الأول', subject: 'اللغة العربية', grade: 1, minutes: 10,
      questions: [
        {q: 'ما الحرف الأول من كلمة "قلم"؟', choices: ['ل', 'م', 'ق', 'ن'], answer: 2},
        {q: 'أيّ الكلمات تبدأ بحرف الباء؟', choices: ['باب', 'دار', 'شمس', 'ورد'], answer: 0},
        {q: 'كم حرفًا في كلمة "درس"؟', choices: ['2', '3', '4', '5'], answer: 1},
      ]},
  ];

  window.APP_DATA = {official: OFFICIAL, levels, library, lessons, exercises, tests, gradeNames: GRADE_AR};
})();
