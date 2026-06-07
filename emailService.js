const { Resend } = require("resend");

// Initialize Resend with the environment API Key
const apiKey = process.env.RESEND_API_KEY || "re_g5992ZKQ_P2mSa72diVDaUfqCNQ3jmBwL";
const resend = apiKey ? new Resend(apiKey) : null;
const MAIL_FROM = process.env.MAIL_FROM || "onboarding@resend.dev";

/**
 * Base email sending utility using official Resend API client.
 * Falls back to console logging in development mode if no key is present.
 */
async function sendEmail(to, subject, html) {
  if (!resend) {
    console.log(`[EMAIL DEV MODE]
To: ${to}
Subject: ${subject}
Content: ${html.replace(/<[^>]*>/g, " ").trim().slice(0, 300)}...`);
    return { dev: true };
  }

  // Diagnostic print before sending
  console.log("Sending email via Resend API:", {
    from: MAIL_FROM,
    to: to,
    subject: subject
  });

  try {
    const data = await resend.emails.send({
      from: MAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      subject: subject,
      html: html,
    });
    
    // Diagnostic print after sending
    console.log("Resend API Response:", data);
    
    return data;
  } catch (error) {
    console.error("[Resend Email Send Error]:", error);
    // Silent fail so backend endpoints don't crash in case of service issues
    return { error: error.message };
  }
}

/**
 * Modern responsive template wrappers with a premium glassmorphic dark-mode appearance.
 */
function getEmailWrapper(title, contentHtml) {
  return `
  <!DOCTYPE html>
  <html lang="ar" dir="rtl">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body {
        margin: 0;
        padding: 0;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        background-color: #08090d;
        color: #e2e8f0;
        direction: rtl;
        text-align: right;
      }
      .email-container {
        max-width: 580px;
        margin: 30px auto;
        background: #0f121d;
        border: 1px solid rgba(99, 102, 241, 0.16);
        border-radius: 20px;
        overflow: hidden;
        box-shadow: 0 15px 35px rgba(0, 0, 0, 0.6);
      }
      .email-header {
        padding: 30px 20px;
        text-align: center;
        background: linear-gradient(180deg, #151a2e 0%, #0f121d 100%);
        border-bottom: 1px solid rgba(99, 102, 241, 0.08);
        border-top: 4px solid #6366f1;
      }
      .brand-name {
        font-size: 28px;
        font-weight: 800;
        color: #ffffff;
        letter-spacing: 2px;
        margin: 0;
      }
      .brand-subtitle {
        font-size: 11px;
        color: #94a3b8;
        margin-top: 5px;
        letter-spacing: 0.5px;
      }
      .email-body {
        padding: 40px 30px;
        line-height: 1.8;
      }
      .email-title {
        font-size: 21px;
        font-weight: 700;
        color: #ffffff;
        margin-top: 0;
        margin-bottom: 25px;
        border-right: 4px solid #6366f1;
        padding-right: 12px;
      }
      .email-content {
        font-size: 15px;
        color: #94a3b8;
      }
      .otp-card {
        background: rgba(99, 102, 241, 0.02);
        border: 1px dashed rgba(99, 102, 241, 0.35);
        border-radius: 16px;
        padding: 26px;
        text-align: center;
        margin: 30px 0;
      }
      .otp-code {
        font-size: 42px;
        font-weight: 800;
        letter-spacing: 8px;
        color: #818cf8;
        font-family: monospace, Courier, monospace;
        margin: 15px 0;
        text-shadow: 0 0 15px rgba(99, 102, 241, 0.25);
      }
      .otp-meta {
        font-size: 12px;
        color: #64748b;
        margin-top: 10px;
      }
      .btn {
        display: inline-block;
        padding: 12px 32px;
        background: linear-gradient(90deg, #6366f1 0%, #8b5cf6 100%);
        color: #ffffff !important;
        font-weight: 600;
        text-decoration: none;
        border-radius: 12px;
        text-align: center;
        margin-top: 15px;
        box-shadow: 0 8px 20px rgba(99, 102, 241, 0.3);
      }
      .receipt-table {
        width: 100%;
        margin-top: 25px;
        border-collapse: collapse;
        background: rgba(255, 255, 255, 0.01);
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.04);
      }
      .receipt-table th, .receipt-table td {
        padding: 14px 18px;
        text-align: right;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }
      .receipt-table th {
        background: rgba(99, 102, 241, 0.1);
        color: #ffffff;
        font-weight: 700;
      }
      .receipt-table td {
        color: #cbd5e1;
        font-size: 14px;
      }
      .email-footer {
        padding: 30px;
        text-align: center;
        background: #0b0d14;
        border-top: 1px solid rgba(255, 255, 255, 0.02);
        font-size: 12px;
        color: #475569;
      }
      .email-footer a {
        color: #6366f1;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="email-header">
        <div class="brand-name">TASKORA</div>
        <div class="brand-subtitle">المنصة المالية الذكية للمهام اليومية</div>
      </div>
      <div class="email-body">
        <h2 class="email-title">${title}</h2>
        <div class="email-content">
          ${contentHtml}
        </div>
      </div>
      <div class="email-footer">
        <p>© 2026 جميع الحقوق محفوظة لشركة Taskora Ltd.</p>
        <p>مرخصة وخاضعة لقوانين تنظيم الخدمات المالية والأصول الرقمية.</p>
      </div>
    </div>
  </body>
  </html>
  `;
}

/**
 * Sends a clean 6-digit OTP verification email.
 */
async function sendOTPEmail(email, username, code, type = "email_verification") {
  const isRegister = type === "email_verification";
  const title = isRegister ? "تأكيد الحساب والبريد الإلكتروني" : "استعادة كلمة المرور";
  
  const welcomeText = isRegister 
    ? `<p>مرحبًا <strong>${username}</strong>، سعداء للغاية بانضمامك إلى عائلة Taskora!</p>
       <p>لتفعيل حسابك بالكامل بنجاح والحصول على <strong>مكافأة ترحيبية فورية بقيمة $10.00</strong>، يرجى إدخال رمز التحقق التالي في صفحة تأكيد البريد:</p>`
    : `<p>مرحبًا <strong>${username}</strong>، لقد تلقينا طلبًا لإعادة تعيين كلمة المرور الخاصة بحسابك.</p>
       <p>يرجى استخدام رمز الاستعادة التالي لإكمال تعيين كلمة المرور الجديدة لحسابك بأمان:</p>`;

  const bodyHtml = `
    ${welcomeText}
    <div class="otp-card">
      <div style="font-size: 13px; color: #94a3b8; font-weight: 600;">رمز التحقق (OTP) المكون من 6 أرقام</div>
      <div class="otp-code">${code}</div>
      <div class="otp-meta">هذا الرمز صالح لمدة 10 دقائق فقط لدواعي الأمان. لا تشارك هذا الرمز مع أي شخص آخر على الإطلاق.</div>
    </div>
    <p style="font-size: 13px; color: #64748b;">إذا لم تكن قد طلبت هذا الإجراء بنفسك، يمكنك تجاهل هذا البريد الإلكتروني بأمان وسيبقى حسابك محميًا بالكامل.</p>
  `;

  const finalHtml = getEmailWrapper(title, bodyHtml);
  return sendEmail(email, `${title} - Taskora`, finalHtml);
}

/**
 * Sends a notification regarding the KYC verification status.
 */
async function sendKYCStatusEmail(email, username, approved, reason = "") {
  const title = approved ? "🎉 تم توثيق حسابك بنجاح!" : "⚠️ تحديث بخصوص طلب توثيق حسابك";
  
  const content = approved
    ? `<p>مرحبًا <strong>${username}</strong>،</p>
       <p>يسعدنا للغاية إبلاغك بأن فريق المراجعة والامتثال لدينا قد **وافق على طلب توثيق هويتك (KYC) بنجاح**!</p>
       <div style="background: rgba(16, 185, 129, 0.06); border-right: 4px solid #10b981; border-radius: 12px; padding: 20px; margin: 25px 0; color: #a7f3d0;">
         <strong style="display: block; font-size: 16px; margin-bottom: 8px; color: #ffffff;">مزايا الترقية الحالية:</strong>
         <ul style="margin: 0; padding-right: 20px; line-height: 1.8;">
           <li>تمت ترقية حسابك رسميًا وتفعيل كامل صلاحيات السحب والإيداع.</li>
           <li>تم إيداع بونص التوثيق بقيمة <strong>$10.00</strong> بنجاح في رصيدك المتاح!</li>
           <li>دورة إكمال المهام والاستثمار أصبحت تعمل بكفاءة كاملة.</li>
         </ul>
       </div>
       <div style="text-align: center; margin: 30px 0;">
         <a href="https://taskora.live" class="btn" style="background: linear-gradient(90deg, #10b981 0%, #059669 100%); box-shadow: 0 8px 20px rgba(16, 185, 129, 0.25);">ابدأ بتنفيذ المهام وجني الأرباح</a>
       </div>`
    : `<p>مرحبًا <strong>${username}</strong>،</p>
       <p>نود إبلاغك بأنه قد تم مراجعة طلب توثيق هويتك (KYC) وللأسف **تم رفض الطلب** نظراً لوجود ملاحظات:</p>
       <div style="padding: 18px; background: rgba(239, 68, 68, 0.06); border-right: 4px solid #ef4444; border-radius: 12px; color: #fecaca; margin: 25px 0;">
         <strong>سبب الرفض:</strong> ${reason || "الوثائق المرفوعة غير واضحة أو غير مكتملة أو لم تطابق البيانات المدخلة."}
       </div>
       <p>لا تقلق، يمكنك بسهولة تسجيل الدخول إلى حسابك مجدداً وإعادة رفع وثائق أوضح (مثل بطاقة الهوية الوطنية أو جواز السفر) لكي يتمكن فريق الامتثال من مراجعتها وتوثيق حسابك فوراً.</p>
       <div style="text-align: center; margin: 30px 0;">
         <a href="https://taskora.live" class="btn" style="background: linear-gradient(90deg, #ef4444 0%, #dc2626 100%); box-shadow: 0 8px 20px rgba(239, 68, 68, 0.25);">إعادة رفع الوثائق فوراً</a>
       </div>`;

  const finalHtml = getEmailWrapper(title, content);
  return sendEmail(email, `تحديث حالة التوثيق - Taskora`, finalHtml);
}

/**
 * Sends a package purchase receipt details.
 * Kept for reverse compatibility but no longer invoked.
 */
async function sendPackagePurchaseEmail(email, username, packageName, price) {
  const title = "💼 تم تفعيل باقتك الاستثمارية الجديدة بنجاح";
  
  const content = `
    <p>مرحبًا <strong>${username}</strong>،</p>
    <p>شكرًا لك على ثقتك بـ Taskora! تم خصم قيمة الاشتراك وتفعيل باقتك الجديدة بنجاح وبدء دورة المهام.</p>
    
    <table class="receipt-table">
      <thead>
        <tr>
          <th colspan="2">تفاصيل الفاتورة والاشتراك</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>الباقة النشطة</td>
          <td><strong>باقة ${packageName}</strong></td>
        </tr>
        <tr>
          <td>سعر الباقة</td>
          <td><strong>$${Number(price).toFixed(2)}</strong></td>
        </tr>
        <tr>
          <td>العائد المستهدف</td>
          <td><strong>10.00% بعد إكمال 12 مهمة</strong></td>
        </tr>
        <tr>
          <td>تاريخ التفعيل</td>
          <td><strong>${new Date().toLocaleString("ar")}</strong></td>
        </tr>
      </tbody>
    </table>
    
    <p style="margin-top: 25px;">يرجى التوجه إلى صفحة **المهام اليومية** للبدء بتنفيذ المهام وإكمالها لتحويل رأس المال والأرباح إلى رصيدك المتاح للسحب فورًا.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="https://taskora.live" class="btn">الذهاب لصفحة المهام</a>
    </div>
  `;

  const finalHtml = getEmailWrapper(title, content);
  return sendEmail(email, `تأكيد شراء باقة ${packageName} - Taskora`, finalHtml);
}

/**
 * Sends withdrawal approved or rejected status emails.
 */
async function sendWithdrawalStatusEmail(email, username, approved, amount, coin, walletAddress, extra = {}) {
  const title = approved ? "💸 تم تنفيذ طلب السحب الخاص بك بنجاح" : "⚠️ تم رفض طلب السحب الخاص بك";
  
  const content = approved
    ? `<p>مرحبًا <strong>${username}</strong>،</p>
       <p>يسعدنا إعلامك بأن عملية مراجعة طلب السحب الخاص بك قد تمت بنجاح وتم إرسال الأموال إلى محفظتك!</p>
       
       <table class="receipt-table">
         <thead>
           <tr>
             <th colspan="2">تفاصيل المعاملة المالية</th>
           </tr>
         </thead>
         <tbody>
           <tr>
             <td>المبلغ المسحوب</td>
             <td style="color: #10b981; font-weight: 700;">+$${Number(amount).toFixed(2)}</td>
           </tr>
           <tr>
             <td>العملة والشبكة</td>
             <td><strong>${String(coin).toUpperCase()} (USDT-TRC20)</strong></td>
           </tr>
           <tr>
             <td>محفظة الاستلام</td>
             <td style="font-size: 12px; font-family: monospace; color: #a7f3d0; word-break: break-all;"><code>${walletAddress}</code></td>
           </tr>
           ${extra.txid ? `<tr>
             <td>رقم المعاملة (TXID)</td>
             <td style="font-size: 12px; font-family: monospace; color: #818cf8; word-break: break-all;"><code>${extra.txid}</code></td>
           </tr>` : ""}
           <tr>
             <td>تاريخ المعالجة</td>
             <td><strong>${new Date().toLocaleString("ar")}</strong></td>
           </tr>
         </tbody>
       </table>
       
       <p style="margin-top: 25px; font-size: 13px; color: #94a3b8;">تنويه: قد تستغرق المعاملة بضع دقائق إضافية لتظهر في رصيد محفظتك الخارجية بناءً على تأكيدات شبكة البلوكشين النشطة.</p>`
    : `<p>مرحبًا <strong>${username}</strong>،</p>
       <p>نود إبلاغك بأنه بعد مراجعة طلب السحب بقيمة <strong>$${Number(amount).toFixed(2)}</strong> للعملة <strong>${String(coin).toUpperCase()}</strong>، قد **تم رفض الطلب** نظراً للسبب التالي:</p>
       <div style="padding: 18px; background: rgba(239, 68, 68, 0.06); border-right: 4px solid #ef4444; border-radius: 12px; color: #fecaca; margin: 25px 0;">
         <strong>سبب الرفض:</strong> ${extra.reason || "يرجى مراجعة عنوان المحفظة المدخل أو التأكد من سلامة المعاملة."}
       </div>
       <p><strong>ملاحظة أمان هامة:</strong> لقد قمنا بإعادة كامل قيمة المبلغ المرفوض ($${Number(amount).toFixed(2)}) إلى رصيدك المتاح في حسابك فورًا دون خصم أي رسوم إدارية.</p>
       <p>يرجى مراجعة تفاصيل محفظتك في الإعدادات وإعادة تقديم طلب سحب آخر، أو يمكنك التواصل مباشرة مع فريق الدعم الفني لمساعدتك.</p>
       <div style="text-align: center; margin: 30px 0;">
         <a href="https://taskora.live" class="btn" style="background: transparent; border: 1.5px solid #6366f1; color: #6366f1 !important; box-shadow: none;">تواصل مع الدعم الفني</a>
       </div>`;

  const finalHtml = getEmailWrapper(title, content);
  return sendEmail(email, `تحديث حالة طلب السحب - Taskora`, finalHtml);
}

/**
 * Sends support ticket details to support@taskora.live.
 */
async function sendSupportTicketNotificationEmail(username, email, subject, category, message) {
  const title = "📬 تذكرة دعم فني جديدة";
  const categoryNames = {
    general: "عام / استفسار",
    kyc: "توثيق الهوية (KYC)",
    deposit: "الإيداع المالي",
    withdrawal: "السحب المالي",
    package: "الباقات والمهام اليومية"
  };
  const categoryName = categoryNames[category] || category;

  const content = `
    <p>مرحبًا فريق الدعم،</p>
    <p>تلقينا للتو تذكرة دعم فني جديدة مرسلة من مستخدم على المنصة. تفاصيل الرسالة أدناه:</p>
    
    <table class="receipt-table">
      <thead>
        <tr>
          <th colspan="2">تفاصيل مرسل الرسالة</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>اسم المستخدم</td>
          <td><strong>${username}</strong></td>
        </tr>
        <tr>
          <td>البريد الإلكتروني</td>
          <td><strong>${email}</strong></td>
        </tr>
        <tr>
          <td>القسم الفني</td>
          <td><strong>${categoryName}</strong></td>
        </tr>
        <tr>
          <td>موضوع الرسالة</td>
          <td><strong>${subject}</strong></td>
        </tr>
      </tbody>
    </table>
    
    <div style="background: rgba(255, 255, 255, 0.02); border: 1.5px solid rgba(99, 102, 241, 0.15); border-radius: 12px; padding: 20px; margin-top: 25px;">
      <strong style="color: #ffffff; display: block; margin-bottom: 8px; font-size: 15px;">نص الرسالة:</strong>
      <p style="color: #cbd5e1; margin: 0; line-height: 1.6; white-space: pre-wrap; font-size: 14px;">${message}</p>
    </div>
    
    <p style="margin-top: 25px; font-size: 13px; color: #94a3b8;">يرجى تسجيل الدخول إلى لوحة إدارة الدعم الفني للرد المباشر على المستخدم.</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="https://taskora.live" class="btn" style="background: linear-gradient(90deg, #6366f1 0%, #8b5cf6 100%);">الذهاب للوحة الدعم</a>
    </div>
  `;

  const finalHtml = getEmailWrapper(title, content);
  return sendEmail("support@taskora.live", `تذكرة دعم جديدة [${categoryName}] - ${subject}`, finalHtml);
}

module.exports = {
  sendEmail,
  sendOTPEmail,
  sendKYCStatusEmail,
  sendPackagePurchaseEmail,
  sendWithdrawalStatusEmail,
  sendSupportTicketNotificationEmail,
};
