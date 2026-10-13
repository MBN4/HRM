import type { Prisma, PrismaClient } from '@prisma/client';
import type { NotificationChannel, NotificationEventType } from '@hrm/shared';

type Client = PrismaClient | Prisma.TransactionClient;

interface TemplateSeed {
  eventType: NotificationEventType;
  channel: NotificationChannel;
  locale: string;
  subject?: string;
  body: string;
}

/**
 * The vendor-authored notification copy — "externalize all template
 * strings" (see /CLAUDE.md § Conventions → Notifications) means this is
 * the ONLY place any of this copy is written; `apps/api`'s rendering code
 * never contains a hardcoded English (or Arabic) string. `{{placeholder}}`
 * tokens are substituted from the triggering domain event's payload by
 * `NotificationTemplateRenderer`. English (`en`) and Arabic (`ar`) are
 * seeded for every mapped event type specifically so the locale-driven
 * rendering test (a US recipient vs. a Qatar recipient) has real templates
 * to resolve against for BOTH locales, the same "two reference country
 * packs prove the mechanism" posture `seed-country-packs.ts` established
 * in 0.5.
 */
const TEMPLATES: TemplateSeed[] = [
  {
    eventType: 'auth.password_reset_requested',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'Reset your {{productName}} password',
    body: 'Hello, a password reset was requested for your account. Use this code to continue: {{token}}. If you did not request this, you can ignore this email.',
  },
  {
    eventType: 'auth.password_reset_requested',
    channel: 'EMAIL',
    locale: 'ar',
    subject: 'إعادة تعيين كلمة مرور {{productName}}',
    body: 'مرحبًا، تم طلب إعادة تعيين كلمة المرور لحسابك. استخدم هذا الرمز للمتابعة: {{token}}. إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة.',
  },
  {
    eventType: 'auth.password_reset_requested',
    channel: 'IN_APP',
    locale: 'en',
    body: 'A password reset was requested for your account.',
  },
  {
    eventType: 'auth.password_reset_requested',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'تم طلب إعادة تعيين كلمة المرور لحسابك.',
  },
  {
    eventType: 'workflow.submitted',
    channel: 'IN_APP',
    locale: 'en',
    body: 'A new {{entityType}} request ({{entityId}}) is waiting for your approval.',
  },
  {
    eventType: 'workflow.submitted',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'هناك طلب {{entityType}} جديد ({{entityId}}) بانتظار موافقتك.',
  },
  {
    eventType: 'workflow.approved',
    channel: 'IN_APP',
    locale: 'en',
    body: 'Your {{entityType}} request ({{entityId}}) was approved.',
  },
  {
    eventType: 'workflow.approved',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'تمت الموافقة على طلب {{entityType}} الخاص بك ({{entityId}}).',
  },
  {
    eventType: 'workflow.rejected',
    channel: 'IN_APP',
    locale: 'en',
    body: 'Your {{entityType}} request ({{entityId}}) was rejected.',
  },
  {
    eventType: 'workflow.rejected',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'تم رفض طلب {{entityType}} الخاص بك ({{entityId}}).',
  },
  {
    eventType: 'workflow.escalated',
    channel: 'IN_APP',
    locale: 'en',
    body: 'An approval step was escalated to you. Please review it when you can.',
  },
  {
    eventType: 'workflow.escalated',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'تم تصعيد خطوة موافقة إليك. يرجى مراجعتها عندما تتمكن من ذلك.',
  },
  {
    eventType: 'workflow.escalated',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'An approval was escalated to you',
    body: 'An approval step was escalated to you because it was not actioned in time. Please review it when you can.',
  },
  {
    eventType: 'workflow.escalated',
    channel: 'EMAIL',
    locale: 'ar',
    subject: 'تم تصعيد موافقة إليك',
    body: 'تم تصعيد خطوة موافقة إليك لأنه لم يتم اتخاذ إجراء بشأنها في الوقت المحدد. يرجى مراجعتها عندما تتمكن من ذلك.',
  },
  {
    eventType: 'licensing.issued',
    channel: 'IN_APP',
    locale: 'en',
    body: 'A new license was issued for your organization ({{edition}} edition).',
  },
  {
    eventType: 'licensing.issued',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'تم إصدار ترخيص جديد لمؤسستك (إصدار {{edition}}).',
  },
  {
    eventType: 'licensing.revoked',
    channel: 'IN_APP',
    locale: 'en',
    body: "Your organization's license was revoked.",
  },
  {
    eventType: 'licensing.revoked',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'تم إلغاء ترخيص مؤسستك.',
  },
  // Step 3.5.3 (e-signatures) — see docs/conventions/e-signatures.md.
  {
    eventType: 'esignature.request_sent',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'A document is waiting for your signature: {{requestTitle}}',
    body: 'You have been asked to review and sign "{{requestTitle}}". Please sign in to your account to view and sign it.',
  },
  {
    eventType: 'esignature.request_sent',
    channel: 'EMAIL',
    locale: 'ar',
    subject: 'مستند بانتظار توقيعك: {{requestTitle}}',
    body: 'طُلب منك مراجعة وتوقيع "{{requestTitle}}". يرجى تسجيل الدخول إلى حسابك لعرضه وتوقيعه.',
  },
  {
    eventType: 'esignature.request_sent',
    channel: 'IN_APP',
    locale: 'en',
    body: 'A document is waiting for your signature: {{requestTitle}}.',
  },
  {
    eventType: 'esignature.request_sent',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'مستند بانتظار توقيعك: {{requestTitle}}.',
  },
  {
    eventType: 'esignature.completed',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'All signatures collected: {{requestTitle}}',
    body: 'Every signer has now signed "{{requestTitle}}". The signed document and its certificate are ready to download.',
  },
  {
    eventType: 'esignature.completed',
    channel: 'EMAIL',
    locale: 'ar',
    subject: 'اكتمال جميع التوقيعات: {{requestTitle}}',
    body: 'وقّع الجميع الآن على "{{requestTitle}}". المستند الموقّع وشهادته جاهزان للتنزيل.',
  },
  {
    eventType: 'esignature.completed',
    channel: 'IN_APP',
    locale: 'en',
    body: 'Every signer has now signed "{{requestTitle}}".',
  },
  {
    eventType: 'esignature.completed',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'وقّع الجميع الآن على "{{requestTitle}}".',
  },
  // Step 8.2 — shift scheduling (docs/conventions/shift-scheduling.md).
  {
    eventType: 'roster.published',
    channel: 'IN_APP',
    locale: 'en',
    body: 'Your schedule for {{from}} to {{to}} was published ({{days}} day(s)). Open "My schedule" to see your shifts.',
  },
  {
    eventType: 'roster.published',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'تم نشر جدولك من {{from}} إلى {{to}} ({{days}} يوم). افتح "جدولي" لعرض نوباتك.',
  },
  {
    eventType: 'roster.published',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'Your schedule was published',
    body: 'Your schedule for {{from}} to {{to}} ({{days}} day(s)) was published. Sign in to see your shifts.',
  },
  {
    eventType: 'roster.published',
    channel: 'EMAIL',
    locale: 'ar',
    subject: 'تم نشر جدولك',
    body: 'تم نشر جدولك من {{from}} إلى {{to}} ({{days}} يوم). سجّل الدخول لعرض نوباتك.',
  },
  {
    eventType: 'roster.changed',
    channel: 'IN_APP',
    locale: 'en',
    body: 'Your shift on {{date}} changed: {{previousShift}} → {{shiftName}}.',
  },
  {
    eventType: 'roster.changed',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'تغيّرت نوبتك في {{date}}: {{previousShift}} ← {{shiftName}}.',
  },
  {
    eventType: 'roster.changed',
    channel: 'EMAIL',
    locale: 'en',
    subject: 'Your shift on {{date}} changed',
    body: 'Your shift on {{date}} changed from {{previousShift}} to {{shiftName}}.',
  },
  {
    eventType: 'roster.changed',
    channel: 'EMAIL',
    locale: 'ar',
    subject: 'تغيّرت نوبتك في {{date}}',
    body: 'تغيّرت نوبتك في {{date}} من {{previousShift}} إلى {{shiftName}}.',
  },
  {
    eventType: 'shift_swap.requested',
    channel: 'IN_APP',
    locale: 'en',
    body: '{{requesterName}} asked you to take their {{shiftName}} shift on {{date}}. Open "My schedule" to answer.',
  },
  {
    eventType: 'shift_swap.requested',
    channel: 'IN_APP',
    locale: 'ar',
    body: 'طلب منك {{requesterName}} تولّي نوبة {{shiftName}} في {{date}}. افتح "جدولي" للرد.',
  },
];

/**
 * Idempotent (upsert-per-`(eventType, channel, locale, version)`), same
 * shape as `seedCountryPacks()`. Called by `prisma/seed.ts`.
 */
export async function seedNotificationTemplates(client: Client): Promise<void> {
  for (const template of TEMPLATES) {
    await client.notificationTemplate.upsert({
      where: {
        eventType_channel_locale_version: {
          eventType: template.eventType,
          channel: template.channel,
          locale: template.locale,
          version: 1,
        },
      },
      update: { subject: template.subject, body: template.body, isActive: true },
      create: {
        eventType: template.eventType,
        channel: template.channel,
        locale: template.locale,
        version: 1,
        isActive: true,
        subject: template.subject,
        body: template.body,
      },
    });
  }
}
