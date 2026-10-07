import type { SupportedLocale } from '@hrm/shared';

/**
 * Privacy-policy TEMPLATE content (step 7.1) — static, structured data so the
 * page can render a table of contents and so each locale carries its own
 * full text (this is long-form prose, not UI chrome, hence not in the
 * `UI_MESSAGES` catalog; the page's chrome — title, template banner, TOC
 * label — IS in the catalog).
 *
 * `{{product}}` is replaced with the tenant's branded product name;
 * `[bracketed text]` marks the organization-specific facts a deploying
 * organization must fill in. This is a TEMPLATE and NOT legal advice — the
 * page states so prominently, and a lawyer must review it before production.
 * Section 8 deliberately mirrors what the Phase 6.1 privacy module can and
 * cannot do (see docs/conventions/privacy-residency.md) so the policy never
 * promises more than the product does.
 */
export interface PolicySection {
  id: string;
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  /** Paragraphs rendered after the bullets. */
  closing?: string[];
}

export const PRIVACY_POLICY_VERSION = '2026-10-07';

const EN: PolicySection[] = [
  {
    id: 'introduction',
    title: '1. Introduction and scope',
    paragraphs: [
      'This policy explains how [Organization name] ("we", "us", "the employer") collects, uses, shares and protects personal data when you use {{product}}, our human-resources management service. It applies to employees, managers, HR administrators, job candidates and any other individual whose data is processed in {{product}}.',
      '{{product}} is operated by a software provider acting as our data processor. We, as your employer or prospective employer, decide why and how your data is used (the data controller).',
    ],
  },
  {
    id: 'data-collected',
    title: '2. Information we collect',
    paragraphs: ['Depending on your relationship with us, {{product}} processes the following categories of personal data:'],
    bullets: [
      'Account data — work email address, roles and permissions, branch scope, sign-in timestamps, and (if enabled) multi-factor authentication settings. Passwords are stored only as salted one-way hashes.',
      'Employment data — name, contact details, job title, department, manager, employment dates, work location and employment status.',
      'Time and leave data — clock-in/out records (including location or photo where your employer enables them), leave requests and balances.',
      'Compensation data — salary components, payslips, tax and statutory contributions, bank details for payment, and benefits enrolment.',
      'Recruitment data — application details, CVs, interview notes and offers for candidates.',
      'Performance and learning data — goals, reviews, ratings, training records and certifications.',
      'Documents and signatures — files you upload and electronic-signature records, including a tamper-evident audit trail of signing events.',
      'Technical data — IP address, browser type, and security and audit logs of actions taken in the service.',
    ],
    closing: ['Some of these categories (for example bank details, national identifiers and compensation) are encrypted at rest and shown only to people with a specific permission.'],
  },
  {
    id: 'use',
    title: '3. How we use your information',
    bullets: [
      'To administer the employment relationship: payroll, leave, attendance, benefits, performance and offboarding.',
      'To meet legal and regulatory obligations, including tax, social-security and statutory reporting.',
      'To run recruitment and onboarding.',
      'To keep the service secure: authentication, access control, fraud and abuse prevention, and audit logging of sensitive actions.',
      'To send service notifications such as approvals, reminders and announcements.',
      'To improve reliability and support, using operational metrics rather than the content of your records.',
    ],
    closing: ['We do not sell personal data, and we do not use it for advertising.'],
  },
  {
    id: 'legal-bases',
    title: '4. Legal bases',
    paragraphs: ['Where data-protection law requires a legal basis, we rely on the following, as applicable: performance of your employment contract; compliance with a legal obligation; our legitimate interests in managing our workforce securely and efficiently; and, in limited cases such as optional features, your consent, which you may withdraw at any time. [Confirm the bases that apply in your jurisdiction.]'],
  },
  {
    id: 'sharing',
    title: '5. Who we share data with',
    paragraphs: ['Access inside {{product}} is restricted by role: people see only what their permissions and branch scope allow. Outside the organization, data is shared only as needed with:'],
    bullets: [
      'Our service provider and its sub-processors (for example cloud hosting, object storage, email delivery, error monitoring and, where subscriptions are billed, payment processing). The current sub-processor list is available from [privacy contact].',
      'Banks and payment providers, to pay salaries and reimbursements.',
      'Tax, social-security and other government authorities, where the law requires it.',
      'Professional advisers and auditors, under confidentiality obligations.',
    ],
  },
  {
    id: 'residency',
    title: '6. Data location and international transfers',
    paragraphs: ['Each organization\'s data is hosted in a specific region, [region]. Where data is transferred outside that region or your country, we use the safeguards required by applicable law, such as contractual protections. [Describe your transfer mechanisms.]'],
  },
  {
    id: 'retention',
    title: '7. How long we keep data',
    paragraphs: ['We keep personal data only as long as needed for the purposes above and as the law requires. Retention periods are configured per category of data, for example: employee records after employment ends; candidate records for unsuccessful applicants; payroll and tax records for the statutory period; and security and audit logs for [period]. When a retention period ends, data is deleted or irreversibly anonymized. [Insert your retention schedule.]'],
  },
  {
    id: 'rights',
    title: '8. Your rights',
    paragraphs: ['Depending on where you live, you may have the right to:'],
    bullets: [
      'Access — receive a copy of your personal data. Your organization can generate a structured export of your data, together with the documents held about you, on request.',
      'Rectification — have inaccurate or incomplete data corrected.',
      'Erasure — ask us to delete or anonymize your data. We act on valid requests, but some records must be kept for legal reasons (for example payroll and tax records) and audit logs are anonymized rather than removed so that the integrity of the record is preserved. We will tell you what was erased, anonymized or retained.',
      'Restriction and objection — ask us to limit, or object to, certain processing.',
      'Withdraw consent — where we rely on your consent, you can withdraw it at any time; this does not affect earlier processing.',
      'Complain — lodge a complaint with your data-protection authority.',
    ],
    closing: ['To exercise any right, contact us using the details in section 11. We may need to verify your identity first and will respond within the period required by law.'],
  },
  {
    id: 'security',
    title: '9. How we protect data',
    paragraphs: ['{{product}} uses layered safeguards: tenant data isolation enforced in the database, role-based access control, encryption in transit and for sensitive fields at rest, optional multi-factor authentication, rate limiting, and tamper-resistant audit logging of sensitive actions. No system is perfectly secure; if a breach affects your data we will notify you and the authorities as the law requires.'],
  },
  {
    id: 'cookies',
    title: '10. Cookies and local storage',
    paragraphs: ['The portal does not use advertising or cross-site tracking cookies. It stores your sign-in session and display preferences (such as language and light/dark theme) in your browser so the service works as expected. Clearing your browser data signs you out and resets those preferences.'],
  },
  {
    id: 'contact',
    title: '11. Contact and changes',
    paragraphs: [
      'Questions or requests about this policy: [Privacy contact name, email address and postal address]. Data-protection officer (if appointed): [DPO contact].',
      'We may update this policy from time to time. The version date is shown on this page, and we will notify you of material changes.',
    ],
  },
];

const AR: PolicySection[] = [
  {
    id: 'introduction',
    title: '1. المقدمة ونطاق السياسة',
    paragraphs: [
      'توضح هذه السياسة كيف تقوم [اسم المؤسسة] ("نحن"، "صاحب العمل") بجمع البيانات الشخصية واستخدامها ومشاركتها وحمايتها عند استخدامك {{product}}، خدمة إدارة الموارد البشرية لدينا. وتنطبق على الموظفين والمديرين ومسؤولي الموارد البشرية والمرشحين للوظائف وأي شخص تُعالَج بياناته في {{product}}.',
      'يُشغَّل {{product}} من قِبل مزوّد برمجيات يعمل بصفته معالِجًا للبيانات نيابةً عنا. أما نحن، بصفتنا صاحب العمل الحالي أو المحتمل، فنحدد لماذا وكيف تُستخدم بياناتك (مسؤول التحكم بالبيانات).',
    ],
  },
  {
    id: 'data-collected',
    title: '2. المعلومات التي نجمعها',
    paragraphs: ['بحسب علاقتك بنا، يعالج {{product}} الفئات التالية من البيانات الشخصية:'],
    bullets: [
      'بيانات الحساب — عنوان البريد الإلكتروني للعمل، والأدوار والصلاحيات، ونطاق الفروع، وأوقات تسجيل الدخول، وإعدادات المصادقة متعددة العوامل (إن كانت مفعّلة). تُخزَّن كلمات المرور فقط في صورة تجزئة أحادية الاتجاه.',
      'بيانات التوظيف — الاسم وبيانات الاتصال والمسمى الوظيفي والقسم والمدير وتواريخ التوظيف وموقع العمل وحالة التوظيف.',
      'بيانات الوقت والإجازات — سجلات الحضور والانصراف (بما في ذلك الموقع أو الصورة حيث يفعّلها صاحب العمل)، وطلبات الإجازة وأرصدتها.',
      'بيانات التعويضات — مكوّنات الراتب وكشوف الرواتب والضرائب والاشتراكات النظامية والبيانات المصرفية للدفع والتسجيل في المزايا.',
      'بيانات التوظيف الخارجي — تفاصيل الطلبات والسير الذاتية وملاحظات المقابلات والعروض للمرشحين.',
      'بيانات الأداء والتعلّم — الأهداف والتقييمات والدرجات وسجلات التدريب والشهادات.',
      'المستندات والتوقيعات — الملفات التي ترفعها وسجلات التوقيع الإلكتروني، بما في ذلك سجل تدقيق يكشف أي تلاعب بأحداث التوقيع.',
      'البيانات التقنية — عنوان IP ونوع المتصفح وسجلات الأمان والتدقيق للإجراءات المنفذة في الخدمة.',
    ],
    closing: ['بعض هذه الفئات (مثل البيانات المصرفية والمعرّفات الوطنية والتعويضات) مشفّرة أثناء التخزين ولا تظهر إلا لمن لديه صلاحية محددة.'],
  },
  {
    id: 'use',
    title: '3. كيف نستخدم معلوماتك',
    bullets: [
      'لإدارة علاقة العمل: الرواتب والإجازات والحضور والمزايا والأداء وإنهاء الخدمة.',
      'للوفاء بالالتزامات القانونية والتنظيمية، ومنها الضرائب والتأمينات الاجتماعية والتقارير النظامية.',
      'لإدارة التوظيف وتهيئة الموظفين الجدد.',
      'للحفاظ على أمان الخدمة: المصادقة والتحكم في الوصول ومنع الاحتيال وإساءة الاستخدام وتسجيل الإجراءات الحساسة للتدقيق.',
      'لإرسال إشعارات الخدمة مثل الموافقات والتذكيرات والإعلانات.',
      'لتحسين الموثوقية والدعم باستخدام مقاييس تشغيلية لا محتوى سجلاتك.',
    ],
    closing: ['لا نبيع البيانات الشخصية ولا نستخدمها في الإعلانات.'],
  },
  {
    id: 'legal-bases',
    title: '4. الأسس القانونية',
    paragraphs: ['حيثما يشترط قانون حماية البيانات أساسًا قانونيًا، فإننا نعتمد على ما ينطبق مما يلي: تنفيذ عقد العمل؛ والامتثال لالتزام قانوني؛ ومصالحنا المشروعة في إدارة القوى العاملة بأمان وكفاءة؛ وفي حالات محدودة مثل الميزات الاختيارية، موافقتك التي يمكنك سحبها في أي وقت. [أكّد الأسس المنطبقة في ولايتك القضائية.]'],
  },
  {
    id: 'sharing',
    title: '5. مع من نشارك البيانات',
    paragraphs: ['يُقيَّد الوصول داخل {{product}} بحسب الدور: لا يرى الأشخاص إلا ما تسمح به صلاحياتهم ونطاق فروعهم. وخارج المؤسسة، لا تُشارك البيانات إلا بالقدر اللازم مع:'],
    bullets: [
      'مزوّد خدمتنا ومعالِجيه الفرعيين (مثل الاستضافة السحابية وتخزين الملفات وإرسال البريد الإلكتروني ومراقبة الأخطاء ومعالجة المدفوعات حيث تُفوتر الاشتراكات). قائمة المعالجين الفرعيين الحالية متاحة لدى [جهة الاتصال للخصوصية].',
      'البنوك ومزودي خدمات الدفع، لصرف الرواتب والتعويضات.',
      'الجهات الضريبية والتأمينات الاجتماعية والجهات الحكومية الأخرى حيث يقتضي القانون ذلك.',
      'المستشارين المهنيين والمدققين، بموجب التزامات السرية.',
    ],
  },
  {
    id: 'residency',
    title: '6. موقع البيانات والنقل الدولي',
    paragraphs: ['تُستضاف بيانات كل مؤسسة في منطقة محددة، [المنطقة]. وعند نقل البيانات خارج تلك المنطقة أو خارج بلدك، نستخدم الضمانات التي يشترطها القانون المعمول به، مثل الحماية التعاقدية. [صِف آليات النقل لديك.]'],
  },
  {
    id: 'retention',
    title: '7. مدة الاحتفاظ بالبيانات',
    paragraphs: ['نحتفظ بالبيانات الشخصية فقط بالقدر اللازم للأغراض المذكورة أعلاه وبما يقتضيه القانون. وتُضبط مدد الاحتفاظ لكل فئة من البيانات، مثل: سجلات الموظفين بعد انتهاء الخدمة؛ وسجلات المرشحين غير المقبولين؛ وسجلات الرواتب والضرائب للمدة النظامية؛ وسجلات الأمان والتدقيق لمدة [المدة]. وعند انتهاء مدة الاحتفاظ تُحذف البيانات أو يُزال تعريفها بشكل لا رجعة فيه. [أدرج جدول الاحتفاظ لديك.]'],
  },
  {
    id: 'rights',
    title: '8. حقوقك',
    paragraphs: ['بحسب مكان إقامتك، قد يحق لك:'],
    bullets: [
      'الاطلاع — الحصول على نسخة من بياناتك الشخصية. يمكن لمؤسستك عند الطلب إنشاء تصدير منظّم لبياناتك مع المستندات المحفوظة عنك.',
      'التصحيح — تصحيح البيانات غير الدقيقة أو غير المكتملة.',
      'المحو — أن تطلب منا حذف بياناتك أو إخفاء هويتها. ننفّذ الطلبات الصحيحة، لكن يجب الاحتفاظ ببعض السجلات لأسباب قانونية (مثل سجلات الرواتب والضرائب)، وتُخفى هوية سجلات التدقيق بدلًا من إزالتها حفاظًا على سلامة السجل. وسنخبرك بما جرى محوه أو إخفاء هويته أو الاحتفاظ به.',
      'التقييد والاعتراض — أن تطلب تقييد معالجة معينة أو تعترض عليها.',
      'سحب الموافقة — حيثما نعتمد على موافقتك يمكنك سحبها في أي وقت، ولا يؤثر ذلك على المعالجة السابقة.',
      'الشكوى — تقديم شكوى إلى سلطة حماية البيانات لديك.',
    ],
    closing: ['لممارسة أي حق، تواصل معنا عبر البيانات الواردة في القسم 11. وقد نحتاج إلى التحقق من هويتك أولًا وسنرد خلال المدة التي يقتضيها القانون.'],
  },
  {
    id: 'security',
    title: '9. كيف نحمي البيانات',
    paragraphs: ['يستخدم {{product}} ضمانات متعددة الطبقات: عزل بيانات المؤسسات المفروض على مستوى قاعدة البيانات، والتحكم في الوصول حسب الأدوار، والتشفير أثناء النقل وللحقول الحساسة أثناء التخزين، والمصادقة متعددة العوامل الاختيارية، وتحديد معدل الطلبات، وتسجيل تدقيق مقاوم للتلاعب للإجراءات الحساسة. لا يوجد نظام آمن تمامًا؛ وإذا أثّر اختراق على بياناتك فسنُخطرك والجهات المختصة وفق ما يقتضيه القانون.'],
  },
  {
    id: 'cookies',
    title: '10. ملفات تعريف الارتباط والتخزين المحلي',
    paragraphs: ['لا تستخدم البوابة ملفات تعريف ارتباط إعلانية أو تتبعًا عبر المواقع. وهي تخزّن جلسة تسجيل الدخول وتفضيلات العرض (مثل اللغة والمظهر الفاتح/الداكن) في متصفحك ليعمل الموقع كما هو متوقع. ومسح بيانات المتصفح يؤدي إلى تسجيل خروجك وإعادة ضبط تلك التفضيلات.'],
  },
  {
    id: 'contact',
    title: '11. التواصل والتعديلات',
    paragraphs: [
      'للاستفسارات أو الطلبات المتعلقة بهذه السياسة: [اسم جهة الاتصال للخصوصية وبريدها الإلكتروني وعنوانها البريدي]. مسؤول حماية البيانات (إن وُجد): [بيانات التواصل].',
      'قد نحدّث هذه السياسة من وقت لآخر. يظهر تاريخ الإصدار في هذه الصفحة، وسنخطرك بالتغييرات الجوهرية.',
    ],
  },
];

export const PRIVACY_POLICY_SECTIONS: Record<SupportedLocale, PolicySection[]> = { en: EN, ar: AR };
