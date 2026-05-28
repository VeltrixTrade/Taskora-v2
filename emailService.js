const { Resend } = require("resend");

// Initialize Resend with the environment API Key
const apiKey = process.env.RESEND_API_KEY || "re_J9FCQ94f_3JFsuzoRrMLHypf2YPqyF1Zr";
const resend = apiKey ? new Resend(apiKey) : null;
let MAIL_FROM = process.env.MAIL_FROM || "Taskora <noreply@taskora.live>";
if (!MAIL_FROM || MAIL_FROM.includes("onboarding@resend.dev") || MAIL_FROM.includes("resend.dev")) {
  MAIL_FROM = "Taskora <noreply@taskora.live>";
}

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
      to: [to],
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
        background-color: #0d0f14;
        color: #e4e7eb;
        direction: rtl;
        text-align: right;
      }
      .email-container {
        max-width: 600px;
        margin: 40px auto;
        background: linear-gradient(135deg, #11141c 0%, #151a26 100%);
        border: 1px solid rgba(108, 77, 255, 0.15);
        border-radius: 24px;
        overflow: hidden;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      }
      .email-header {
        padding: 30px;
        text-align: center;
        background: rgba(108, 77, 255, 0.08);
        border-bottom: 1px solid rgba(108, 77, 255, 0.1);
      }
      .brand-logo {
        width: 60px;
        height: 60px;
        border-radius: 12px;
        object-fit: contain;
      }
      .brand-name {
        font-size: 24px;
        font-weight: 800;
        color: #ffffff;
        margin-top: 10px;
        letter-spacing: 1px;
      }
      .email-body {
        padding: 40px 30px;
        line-height: 1.8;
      }
      .email-title {
        font-size: 22px;
        font-weight: 700;
        color: #ffffff;
        margin-top: 0;
        margin-bottom: 20px;
        border-right: 4px solid #6c4dff;
        padding-right: 12px;
      }
      .email-content {
        font-size: 16px;
        color: #a0aec0;
      }
      .otp-card {
        background: rgba(108, 77, 255, 0.05);
        border: 1px dashed rgba(108, 77, 255, 0.4);
        border-radius: 16px;
        padding: 24px;
        text-align: center;
        margin: 30px 0;
      }
      .otp-code {
        font-size: 38px;
        font-weight: 800;
        letter-spacing: 6px;
        color: #6c4dff;
        font-family: monospace, Courier, monospace;
        margin: 10px 0;
      }
      .otp-meta {
        font-size: 13px;
        color: #718096;
        margin-top: 8px;
      }
      .btn {
        display: inline-block;
        padding: 12px 30px;
        background: linear-gradient(90deg, #6c4dff 0%, #8a70ff 100%);
        color: #ffffff !important;
        font-weight: 600;
        text-decoration: none;
        border-radius: 12px;
        text-align: center;
        margin-top: 20px;
        box-shadow: 0 8px 16px rgba(108, 77, 255, 0.3);
      }
      .receipt-table {
        width: 100%;
        margin-top: 25px;
        border-collapse: collapse;
        background: rgba(255, 255, 255, 0.02);
        border-radius: 12px;
        overflow: hidden;
      }
      .receipt-table th, .receipt-table td {
        padding: 14px 18px;
        text-align: right;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }
      .receipt-table th {
        background: rgba(108, 77, 255, 0.1);
        color: #ffffff;
        font-weight: 600;
      }
      .receipt-table td {
        color: #cbd5e0;
      }
      .email-footer {
        padding: 30px;
        text-align: center;
        background: rgba(0, 0, 0, 0.2);
        border-top: 1px solid rgba(255, 255, 255, 0.03);
        font-size: 12px;
        color: #4a5568;
      }
      .email-footer a {
        color: #6c4dff;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="email-header">
        <div class="brand-name">TASKORA</div>
        <div style="font-size:12px; color:#718096; margin-top:2px;">المنصة المالية الذكية للمهام اليومية</div>
      </div>
      <div class="email-body">
        <h2 class="email-title">${title}</h2>
        <div class="email-content">
          ${contentHtml}
        </div>
      </div>
      <div class="email-footer">
        <p>© 2026 جميع الحقوق محفوظة لشركة Taskora Ltd.</p>
        <p>مرخصة وخاضعة لقوانين تنظيم الخدمات المالية.</p>
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
    ? `<p>مرحبًا <strong>${username}</strong>، سعداء بانضمامك لعائلة Taskora!</p>
       <p>لتفعيل حسابك بالكامل والحصول على مكافأة التفعيل بقيمة $10، يرجى إدخال الكود التالي في صفحة تأكيد البريد:</p>`
    : `<p>مرحبًا <strong>${username}</strong>، لقد تلقينا طلبًا لإعادة تعيين كلمة المرور الخاصة بحسابك.</p>
       <p>يرجى استخدام كود الاستعادة التالي لإكمال تعيين كلمة المرور الجديدة:</p>`;

  const bodyHtml = `
    ${welcomeText}
    <div class="otp-card">
      <div style="font-size: 14px; color: #718096;">رمز التحقق (OTP) المكون من 6 أرقام</div>
      <div class="otp-code">${code}</div>
      <div class="otp-meta">هذا الكود صالح لمدة 10 دقائق فقط. لا تشارك هذا الرمز مع أي شخص أبدًا لأمان حسابك.</div>
    </div>
    <p style="font-size: 13px; color: #718096;">إذا لم تكن قد طلبت هذا الإجراء، يمكنك تجاهل هذا البريد الإلكتروني بأمان وسيبقى حسابك محميًا.</p>
  `;

  const finalHtml = getEmailWrapper(title, bodyHtml);
  return sendEmail(email, `${title} - Taskora`, finalHtml);
}

/**
 * Sends a notification regarding the KYC verification status.
 */
async function sendKYCStatusEmail(email, username, approved, reason = "") {
  const title = approved ? "🎉 تهانينا! تم توثيق حسابك بنجاح" : "⚠️ تحديث بخصوص توثيق حسابك";
  
  const content = approved
    ? `<p>مرحبًا <strong>${username}</strong>،</p>
       <p>يسعدنا إبلاغك بأن فريق المراجعة لدينا قد **وافق على طلب توثيق هويتك (KYC) بنجاح**!</p>
       <p>لقد تم ترقية حسابك وتفعيل كامل مزايا السحب والإيداع. كما تم إيداع بونص الترحيب بقيمة **$10.00** في رصيدك المتاح!</p>
       <div style="text-align: center; margin: 30px 0;">
         <a href="https://taskora.app" class="btn">ابدأ بتنفيذ المهام وجني الأرباح</a>
       </div>`
    : `<p>مرحبًا <strong>${username}</strong>،</p>
       <p>نود إبلاغك بأنه قد تم مراجعة طلب توثيق هويتك (KYC) وللأسف **تم رفض الطلب** للسبب التالي:</p>
       <div style="padding: 16px; background: rgba(229, 62, 62, 0.08); border-right: 4px solid #e53e3e; border-radius: 8px; color: #fc8181; margin: 20px 0;">
         <strong>السبب:</strong> ${reason || "الوثائق المرفوعة غير واضحة أو غير مكتملة."}
       </div>
       <p>لا تقلق، يمكنك تسجيل الدخول إلى لوحتك الشخصية وإعادة رفع وثائق أوضح (هوية أو جواز سفر) لكي يقوم فريقنا بمراجعتها وتوثيق حسابك فورًا.</p>
       <div style="text-align: center; margin: 30px 0;">
         <a href="https://taskora.app" class="btn" style="background: linear-gradient(90deg, #e53e3e 0%, #f6e05e 180%); box-shadow: 0 8px 16px rgba(229, 62, 62, 0.3);">إعادة رفع الوثائق</a>
       </div>`;

  const finalHtml = getEmailWrapper(title, content);
  return sendEmail(email, `تحديث حالة التوثيق - Taskora`, finalHtml);
}

/**
 * Sends a package purchase receipt details.
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
      <a href="https://taskora.app" class="btn">الذهاب لصفحة المهام</a>
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
       <p>يسعدنا إعلامك بأن طلب السحب الخاص بك قد تم معالجته وإرسال الأموال بنجاح!</p>
       
       <table class="receipt-table">
         <thead>
           <tr>
             <th colspan="2">تفاصيل الحوالة المالية</th>
           </tr>
         </thead>
         <tbody>
           <tr>
             <td>قيمة السحب</td>
             <td style="color: #48bb78; font-weight: 700;">+$${Number(amount).toFixed(2)}</td>
           </tr>
           <tr>
             <td>العملة الرقمية</td>
             <td><strong>${String(coin).toUpperCase()}</strong></td>
           </tr>
           <tr>
             <td>محفظة الاستلام</td>
             <td style="font-size: 13px; font-family: monospace;"><code>${walletAddress}</code></td>
           </tr>
           ${extra.txid ? `<tr>
             <td>رقم المعاملة (TXID)</td>
             <td style="font-size: 13px; font-family: monospace; color: #6c4dff;"><code>${extra.txid}</code></td>
           </tr>` : ""}
           <tr>
             <td>تاريخ المعالجة</td>
             <td><strong>${new Date().toLocaleString("ar")}</strong></td>
           </tr>
         </tbody>
       </table>
       
       <p style="margin-top: 25px; font-size: 14px; color: #a0aec0;">قد يستغرق ظهور الرصيد في محفظتك الشخصية بضع دقائق حسب سرعة تأكيدات شبكة البلوكشين المعتمدة.</p>`
    : `<p>مرحبًا <strong>${username}</strong>،</p>
       <p>نود إبلاغك بأنه قد تم مراجعة طلب السحب الخاص بك بقيمة **$${Number(amount).toFixed(2)}** للعملة **${String(coin).toUpperCase()}**، وللأسف **تم رفض الطلب** للسبب التالي:</p>
       <div style="padding: 16px; background: rgba(229, 62, 62, 0.08); border-right: 4px solid #e53e3e; border-radius: 8px; color: #fc8181; margin: 20px 0;">
         <strong>السبب:</strong> ${extra.reason || "الرجاء مراجعة عنوان المحفظة أو التواصل مع الدعم الفني."}
       </div>
       <p><strong>ملاحظة أمان:</strong> لقد قمنا بإعادة كامل المبلغ المحجوز ($${Number(amount).toFixed(2)}) إلى رصيدك المتاح في حسابك فورًا دون خصم أي رسوم.</p>
       <p>يمكنك التحقق من تفاصيل المحفظة وإعادة تقديم طلب سحب آخر أو التواصل مع فريق الدعم الفني لحل المشكلة.</p>
       <div style="text-align: center; margin: 30px 0;">
         <a href="https://taskora.app" class="btn" style="background: transparent; border: 1.5px solid #6c4dff; color: #6c4dff !important; box-shadow: none;">تواصل مع الدعم الفني</a>
       </div>`;

  const finalHtml = getEmailWrapper(title, content);
  return sendEmail(email, `تحديث حالة طلب السحب - Taskora`, finalHtml);
}

module.exports = {
  sendEmail,
  sendOTPEmail,
  sendKYCStatusEmail,
  sendPackagePurchaseEmail,
  sendWithdrawalStatusEmail,
};
