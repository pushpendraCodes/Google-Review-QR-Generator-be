import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.ADMIN_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

const sendEmail = async ({ to, subject, html }) => {
  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || "ReviewQR"}" <${process.env.ADMIN_EMAIL}>`,
    to,
    subject,
    html,
  };
  return transporter.sendMail(mailOptions);
};

// ─── Base Layout ─────────────────────────────────────────────────────────────
const baseLayout = ({ title, content, button, footerText }) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f7f6; }
    .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
    .header { background: linear-gradient(135deg, #1D9E75 0%, #178a63 100%); color: #ffffff; padding: 40px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
    .content { padding: 40px 30px; }
    .content h2 { color: #1D9E75; margin-top: 0; font-size: 22px; }
    .content p { margin-bottom: 20px; font-size: 16px; color: #4b5563; }
    .button-container { text-align: center; margin: 30px 0; }
    .button { background-color: #1D9E75; color: #ffffff !important; padding: 14px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; display: inline-block; transition: background 0.3s ease; }
    .footer { background: #f9fbfc; padding: 20px; text-align: center; border-top: 1px solid #edf2f7; }
    .footer p { font-size: 13px; color: #94a3b8; margin: 5px 0; }
    .accent { color: #1D9E75; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>ReviewQR</h1>
    </div>
    <div class="content">
      ${title ? `<h2>${title}</h2>` : ""}
      ${content}
      ${button
    ? `
        <div class="button-container">
          <a href="${button.link}" class="button">${button.text}</a>
        </div>
      `
    : ""
  }
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ReviewQR. All rights reserved.</p>
      <p>${footerText || "Empowering businesses through smart Google Reviews."}</p>
      <p>
        <a href="${process.env.FRONTEND_URL}/dashboard" style="color: #1D9E75; text-decoration: none;">Dashboard</a> | 
        <a href="${process.env.FRONTEND_URL}/support" style="color: #1D9E75; text-decoration: none;">Support</a>
      </p>
    </div>
  </div>
</body>
</html>
`;

// ─── OTP email ────────────────────────────────────────────────────────────────
const sendOtpEmail = (to, otp, type = "verify") => {
  const subject =
    type === "verify" ? "Verify your email — ReviewQR" : "Reset your password — ReviewQR";
  const title = type === "verify" ? "Verify Your Email" : "Reset Your Password";
  const message =
    type === "verify"
      ? "Welcome to <span class='accent'>ReviewQR</span>! Use the code below to verify your email address and get started."
      : "We received a request to reset your password. Use the code below to proceed. This code expires in 10 minutes.";

  const html = baseLayout({
    title,
    content: `
      <p>${message}</p>
      <div style="background:#f3f4f6;border-radius:12px;padding:30px;text-align:center;margin:30px 0;border: 1px dashed #cbd5e1;">
        <span style="font-size:42px;font-weight:800;letter-spacing:10px;color:#111827;font-family:monospace;">${otp}</span>
      </div>
      <p style="font-size:14px;color:#6b7280;text-align:center;">If you didn't request this code, you can safely ignore this email.</p>
    `,
  });

  return sendEmail({ to, subject, html });
};

// ─── Welcome Email ──────────────────────────────────────────────────────────
const sendWelcomeEmail = (to, userName) => {
  const html = baseLayout({
    title: `Welcome to ReviewQR, ${userName}! 🚀`,
    content: `
      <p>We're thrilled to have you join us! <span class="accent">ReviewQR</span> is designed to help you get more 5-star Google Reviews with zero friction.</p>
      <p>Your account is now active. The next step is to create your first dynamic QR code for your business.</p>
      <div style="background: #f0fdf4; padding: 20px; border-radius: 10px; margin: 20px 0;">
        <h3 style="margin-top:0; color: #166534; font-size: 18px;">Getting Started:</h3>
        <ul style="padding-left: 20px; color: #166534;">
          <li>Search for your business in the dashboard</li>
          <li>Customize the QR design to match your brand</li>
          <li>Download and print your custom standee</li>
        </ul>
      </div>
    `,
    button: {
      text: "Create My First QR",
      link: `${process.env.FRONTEND_URL}/generate`,
    },
  });

  return sendEmail({ to, subject: "Welcome to ReviewQR — Let's get those reviews! ⭐", html });
};

// ─── QR Creation Tips ────────────────────────────────────────────────────────
const sendQrTipsEmail = (to, { userName, businessName }) => {
  const html = baseLayout({
    title: "Your QR is Ready! 🎉",
    content: `
      <p>Hi ${userName}, you've successfully created a QR code for <span class="accent">${businessName}</span>. Great job!</p>
      <p>Here are some expert tips to maximize your review collection:</p>
      <div style="display: flex; flex-direction: column; gap: 15px; margin: 20px 0;">
        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #1D9E75;">
          <strong>📍 Visibility is Key</strong>: Place your QR standee at eye-level near the billing counter or on dining tables.
        </div>
        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #1D9E75;">
          <strong>🗣️ The Verbal Ask</strong>: Train your staff to say: "If you enjoyed your experience, please scan this to leave us a quick review!"
        </div>
        <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #1D9E75;">
          <strong>✨ Premium Design</strong>: High-quality prints look more professional and trustworthy.
        </div>
      </div>
    `,
    button: {
      text: "Download Standee",
      link: `${process.env.FRONTEND_URL}/dashboard`,
    },
  });

  return sendEmail({ to, subject: `Tips for your new QR: ${businessName}`, html });
};

// ─── Inactivity Reminder ─────────────────────────────────────────────────────
const sendInactivityReminderEmail = (to, userName) => {
  const html = baseLayout({
    title: "Don't miss out on reviews! 📈",
    content: `
      <p>Hi ${userName}, we noticed you haven't created your first QR code yet.</p>
      <p>Businesses using <span class="accent">ReviewQR</span> typically see a <span class="accent">40% increase</span> in review volume within the first month.</p>
      <p>It only takes 2 minutes to set up. Let's get started today!</p>
    `,
    button: {
      text: "Set Up My QR Now",
      link: `${process.env.FRONTEND_URL}/qr/generate`,
    },
    footerText: "You received this because you recently signed up for ReviewQR.",
  });

  return sendEmail({ to, subject: "Boost your business rating today! ⭐", html });
};

// ─── Weekly analytics report ───────────────────────────────────────────────────
const sendWeeklyReportEmail = (to, { userName, totalScans, topQr, changePercent }) => {
  const arrow = changePercent >= 0 ? "▲" : "▼";
  const color = changePercent >= 0 ? "#16a34a" : "#dc2626";

  const html = baseLayout({
    title: "Your Weekly QR Report 📊",
    content: `
      <p>Hi ${userName}, here is how your QR codes performed this week:</p>
      <div style="background: #f8fafc; border-radius: 12px; padding: 30px; margin: 20px 0; text-align: center; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; color: #64748b; text-transform: uppercase; letter-spacing: 1px;">Total Scans</div>
        <div style="font-size: 48px; font-weight: 800; color: #1e293b; margin: 10px 0;">${totalScans}</div>
        <div style="font-size: 16px; font-weight: 600; color: ${color}; bg-color: ${color}10; padding: 4px 12px; border-radius: 20px; display: inline-block;">
          ${arrow} ${Math.abs(changePercent)}% <span style="font-weight: 400; font-size: 13px; color: #64748b;">vs last week</span>
        </div>
      </div>
      ${topQr
        ? `
        <p style="text-align:center; font-size: 15px; color: #475569;">
          🏆 <strong>Best Performing:</strong> <span class="accent">${topQr.businessName}</span> (${topQr.count} scans)
        </p>
      `
        : ""
      }
    `,
    button: {
      text: "View Full Analytics",
      link: `${process.env.FRONTEND_URL}/dashboard`,
    },
  });

  return sendEmail({
    to,
    subject: `📊 Weekly Report: ${totalScans} scans this week`,
    html,
  });
};

const sendEnquiryEmail = ({ name, email, phone, message }) => {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  return sendEmail({
    to: process.env.ADMIN_EMAIL,          // e.g. admin@getreviewqr.com
    subject: `📩 New Enquiry from ${name} — getreviewqr.com`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">

        <!-- Header -->
        <div style="background:#1D9E75;padding:24px 28px;">
          <h2 style="margin:0;color:#ffffff;font-size:20px;">📩 New Enquiry Received</h2>
          <p style="margin:4px 0 0;color:#d1fae5;font-size:13px;">via getreviewqr.com Contact Form</p>
        </div>

        <!-- Body -->
        <div style="padding:28px;">

          <!-- Sender details table -->
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            <tr>
              <td style="padding:10px 14px;background:#f9fafb;border-radius:8px 8px 0 0;border-bottom:1px solid #e5e7eb;width:30%;">
                <span style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Name</span>
              </td>
              <td style="padding:10px 14px;background:#f9fafb;border-radius:8px 8px 0 0;border-bottom:1px solid #e5e7eb;">
                <span style="font-size:15px;color:#111827;font-weight:600;">${name}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #e5e7eb;">
                <span style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Email</span>
              </td>
              <td style="padding:10px 14px;background:#ffffff;border-bottom:1px solid #e5e7eb;">
                <a href="mailto:${email}" style="font-size:15px;color:#1D9E75;text-decoration:none;">${email}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 14px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
                <span style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Phone</span>
              </td>
              <td style="padding:10px 14px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
                ${phone
        ? `<a href="tel:+91${phone}" style="font-size:15px;color:#1D9E75;text-decoration:none;">+91 ${phone}</a>`
        : `<span style="font-size:14px;color:#9ca3af;">Not provided</span>`
      }
              </td>
            </tr>
            <tr>
              <td style="padding:10px 14px;background:#ffffff;border-radius:0 0 8px 8px;">
                <span style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Received</span>
              </td>
              <td style="padding:10px 14px;background:#ffffff;border-radius:0 0 8px 8px;">
                <span style="font-size:14px;color:#374151;">${now} IST</span>
              </td>
            </tr>
          </table>

          <!-- Message box -->
          <div style="margin-bottom:24px;">
            <p style="font-size:12px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">Message</p>
            <div style="background:#f9fafb;border-left:4px solid #1D9E75;border-radius:0 8px 8px 0;padding:16px 20px;">
              <p style="margin:0;font-size:15px;color:#374151;line-height:1.7;white-space:pre-wrap;">${message}</p>
            </div>
          </div>

          <!-- Quick reply button -->
          <a href="mailto:${email}?subject=Re: Your enquiry on getreviewqr.com"
            style="display:inline-block;padding:12px 24px;background:#1D9E75;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
            ↩ Reply to ${name}
          </a>
        </div>

        <!-- Footer -->
        <div style="padding:16px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            This email was sent automatically from the getreviewqr.com contact form.
          </p>
        </div>
      </div>
    `,
  });
};

// ─── Plan Expiring Soon ──────────────────────────────────────────────────────
const sendPlanExpiringEmail = (to, { userName, plan, expiresAt }) => {
  const expDate = new Date(expiresAt).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);

  const html = baseLayout({
    title: `Your ${planLabel} plan expires soon ⚠️`,
    content: `
      <p>Hi ${userName}, your <span class="accent">${planLabel}</span> plan will expire on <strong>${expDate}</strong>.</p>
      <div style="background: #fef3cd; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #f59e0b;">
        <p style="margin: 0; font-size: 15px; color: #92400e;">
          <strong>What happens after expiry?</strong><br/>
          Your QR codes will continue to work, but customers will be redirected directly to your Google review page without the branded landing page and AI review suggestions.
        </p>
      </div>
      <p>Renew now to keep enjoying:</p>
      <ul style="padding-left: 20px; color: #374151; line-height: 2;">
        <li>🤖 AI-powered review text suggestions</li>
        <li>🏢 Branded business landing page</li>
        <li>📊 Analytics dashboard</li>
        <li>✨ All premium standee features</li>
      </ul>
    `,
    button: {
      text: "Renew My Plan",
      link: `${process.env.FRONTEND_URL}/pricing`,
    },
    footerText: "Your QR codes will still redirect to Google Reviews even after expiry.",
  });

  return sendEmail({
    to,
    subject: `⚠️ Your ${planLabel} plan expires on ${expDate}`,
    html,
  });
};

// ─── Plan Expired ────────────────────────────────────────────────────────────
const sendPlanExpiredEmail = (to, { userName, plan }) => {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);

  const html = baseLayout({
    title: `Your ${planLabel} plan has expired`,
    content: `
      <p>Hi ${userName}, your <span class="accent">${planLabel}</span> subscription has ended.</p>
      <div style="background: #f0fdf4; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #1D9E75;">
        <p style="margin: 0; font-size: 15px; color: #166534;">
          <strong>Don't worry — your QR codes still work!</strong><br/>
          Customers scanning your QR will be redirected directly to your Google review page. You won't lose any reviews.
        </p>
      </div>
      <p>However, you're now missing out on:</p>
      <div style="display: flex; flex-direction: column; gap: 10px; margin: 20px 0;">
        <div style="background: #fef2f2; padding: 12px 16px; border-radius: 8px; font-size: 14px; color: #991b1b;">
          ❌ AI-powered review suggestions for customers
        </div>
        <div style="background: #fef2f2; padding: 12px 16px; border-radius: 8px; font-size: 14px; color: #991b1b;">
          ❌ Branded business landing page
        </div>
        <div style="background: #fef2f2; padding: 12px 16px; border-radius: 8px; font-size: 14px; color: #991b1b;">
          ❌ Analytics dashboard & insights
        </div>
      </div>
      <p>Resubscribe anytime to instantly restore all premium features.</p>
    `,
    button: {
      text: "Resubscribe Now",
      link: `${process.env.FRONTEND_URL}/pricing`,
    },
    footerText: "Your QR codes continue to work — they just redirect directly to Google Reviews.",
  });

  return sendEmail({
    to,
    subject: `Your ${planLabel} plan has expired — Resubscribe to restore features`,
    html,
  });
};


export {
  sendEmail,
  sendOtpEmail,
  sendWeeklyReportEmail,
  sendEnquiryEmail,
  sendWelcomeEmail,
  sendQrTipsEmail,
  sendInactivityReminderEmail,
  sendPlanExpiringEmail,
  sendPlanExpiredEmail,
};


