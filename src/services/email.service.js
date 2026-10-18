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
const sendPlanExpiringEmail = (to, { userName, plan, expiresAt, graceDays = 15 }) => {
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
          Customers will be redirected straight to your Google review page without the branded landing page and AI review suggestions.
          The Free plan includes 1 QR code: if you have more, the extra ones stop working ${graceDays} days after expiry until you renew.
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
    footerText: `Renew within ${graceDays} days of expiry to keep every QR code working.`,
  });

  return sendEmail({
    to,
    subject: `⚠️ Your ${planLabel} plan expires on ${expDate}`,
    html,
  });
};

// ─── Plan Expired ────────────────────────────────────────────────────────────
const sendPlanExpiredEmail = (to, { userName, plan, pauseOn = null, extraQrs = 0 }) => {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const pauseDate = pauseOn
    ? new Date(pauseOn).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
    : "";

  const html = baseLayout({
    title: `Your ${planLabel} plan has expired`,
    content: `
      <p>Hi ${userName}, your <span class="accent">${planLabel}</span> subscription has ended.</p>
      ${extraQrs > 0 && pauseDate
        ? `<div style="background: #fef2f2; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #dc2626;">
        <p style="margin: 0; font-size: 15px; color: #991b1b;">
          <strong>${extraQrs} of your QR codes will stop working on ${pauseDate}.</strong><br/>
          The Free plan includes 1 QR code. Your most-scanned QR keeps working; the others are paused on that date until you renew.
          Customers scanning a paused QR see a "temporarily unavailable" page.
        </p>
      </div>`
        : `<div style="background: #f0fdf4; padding: 20px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #1D9E75;">
        <p style="margin: 0; font-size: 15px; color: #166534;">
          <strong>Your QR code still works.</strong><br/>
          Customers scanning it will be redirected directly to your Google review page.
        </p>
      </div>`}
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
    footerText: extraQrs > 0 && pauseDate
      ? `Renew before ${pauseDate} to keep all your QR codes working.`
      : "Your QR code continues to work and redirects directly to Google Reviews.",
  });

  return sendEmail({
    to,
    subject: `Your ${planLabel} plan has expired — Resubscribe to restore features`,
    html,
  });
};


// ─── Agency team invite ──────────────────────────────────────────────────────
const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const sendTeamInviteEmail = (to, { ownerName, businessName, inviteLink, expiresInDays = 7 }) => {
  const inviter = escapeHtml(ownerName || "Your agency");
  const agency = businessName ? ` (<span class="accent">${escapeHtml(businessName)}</span>)` : "";
  const html = baseLayout({
    title: "You're invited to join a team on ReviewQR",
    content: `
      <p><strong>${inviter}</strong>${agency} has invited you to join their agency team on <span class="accent">ReviewQR</span>.</p>
      <p>As a team member you can create and manage Google Review QR codes for your clients using the agency's plan. You'll see only the QR codes you create.</p>
      <div style="background:#f0fdf4;padding:16px 20px;border-radius:10px;margin:20px 0;color:#166534;font-size:14px;">
        Sign in or create your account with <strong>${escapeHtml(to)}</strong> — the invite only works for this email address.
      </div>
    `,
    button: { text: "Accept invitation", link: inviteLink },
    footerText: `This invitation expires in ${expiresInDays} days. If you weren't expecting it, you can ignore this email.`,
  });

  return sendEmail({ to, subject: `${ownerName || "Your agency"} invited you to their ReviewQR team`, html });
};

const sendClientLoginEmail = (to, { clientName, agencyName, email, password, loginLink }) => {
  const html = baseLayout({
    title: "Your review dashboard login",
    content: `
      <p>Hi ${escapeHtml(clientName || "there")},</p>
      <p><strong>${escapeHtml(agencyName)}</strong> has set up a dashboard where you can see how your Google Review QR codes are doing — scans, your Google rating and new reviews.</p>
      <div style="background:#f0fdf4;padding:16px 20px;border-radius:10px;margin:20px 0;color:#166534;font-size:14px;line-height:1.8;">
        <div>Email: <strong>${escapeHtml(email)}</strong></div>
        <div>Password: <strong style="font-family:monospace;font-size:15px;">${escapeHtml(password)}</strong></div>
      </div>
      <p style="font-size:13px;color:#6b7280;">You can change this password after signing in.</p>
    `,
    button: { text: "Sign in to your dashboard", link: loginLink },
    footerText: `This login was created for you by ${escapeHtml(agencyName)}. If you weren't expecting it, please contact them.`,
  });

  return sendEmail({ to, subject: `${agencyName} shared your review dashboard`, html });
};

const detailBox = (rows) => `
  <div style="background:#f0fdf4;padding:16px 20px;border-radius:10px;margin:20px 0;color:#166534;font-size:14px;line-height:1.8;">
    ${rows.filter(([, v]) => v).map(([k, v]) => `<div>${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong></div>`).join("")}
  </div>`;

// ─── Agency owner: a client reported a payment ───────────────────────────────
const sendPaymentClaimEmail = (to, { ownerName, clientName, businessName, amount, method, reference, paidAt, note, link }) => {
  const html = baseLayout({
    title: "A client says they've paid",
    content: `
      <p>Hi ${escapeHtml(ownerName || "there")},</p>
      <p><strong>${escapeHtml(clientName)}</strong> reported a payment from their dashboard. Check that it reached your account, then confirm or reject it.</p>
      ${detailBox([["Amount", amount], ["Location", businessName], ["Paid via", method], ["Reference", reference], ["Paid on", paidAt], ["Note", note]])}
    `,
    button: { text: "Review payment", link },
    footerText: "The payment is added to the client's history only after you confirm it.",
  });
  return sendEmail({ to, subject: `${clientName} reported a payment of ${amount}`, html });
};

// ─── Agency owner: a team member added a client or QR ────────────────────────
const sendTeamActivityEmail = (to, { ownerName, staffName, staffEmail, title, summary, details = [], link, linkText }) => {
  const html = baseLayout({
    title,
    content: `
      <p>Hi ${escapeHtml(ownerName || "there")},</p>
      <p><strong>${escapeHtml(staffName)}</strong> (${escapeHtml(staffEmail)}) ${escapeHtml(summary)}</p>
      ${detailBox(details)}
    `,
    button: link ? { text: linkText || "Open dashboard", link } : null,
    footerText: "You get these emails because you own this agency account on ReviewQR.",
  });
  return sendEmail({ to, subject: `${staffName} ${summary.replace(/\.$/, "")}`, html });
};

// ─── Client: dashboard blocked for an overdue payment ────────────────────────
const sendClientBlockedEmail = (to, { clientName, agencyName, amount, locations, days, link }) => {
  const html = baseLayout({
    title: "Your dashboard is paused: payment overdue",
    content: `
      <p>Hi ${escapeHtml(clientName || "there")},</p>
      <p>A payment to <strong>${escapeHtml(agencyName)}</strong> has been overdue for more than ${days} days, so your review dashboard has been paused.</p>
      ${detailBox([["Amount due", amount], ["For", locations]])}
      <p>Sign in to see the payment options and tap <strong>"I've paid"</strong> once done. Your dashboard is restored as soon as ${escapeHtml(agencyName)} confirms the payment.</p>
      <p style="font-size:13px;color:#6b7280;">Your Google review QR codes keep working for your customers in the meantime.</p>
    `,
    button: { text: "Pay now", link },
    footerText: `Questions about this payment? Please contact ${escapeHtml(agencyName)}.`,
  });
  return sendEmail({ to, subject: `Payment overdue: ${amount} to ${agencyName}`, html });
};

// ─── Agency owner: a client was blocked ──────────────────────────────────────
const sendAgencyClientBlockedEmail = (to, { ownerName, clientName, amount, locations, days, link }) => {
  const html = baseLayout({
    title: "Client dashboard blocked for non-payment",
    content: `
      <p>Hi ${escapeHtml(ownerName || "there")},</p>
      <p><strong>${escapeHtml(clientName)}</strong> hasn't paid for more than ${days} days, so their client dashboard was blocked automatically. We've emailed them the amount due and how to pay.</p>
      ${detailBox([["Amount overdue", amount], ["Locations", locations]])}
      <p>It unblocks automatically when you record or confirm their payment (or move the due date forward). Their QR codes keep working.</p>
    `,
    button: { text: "View client", link },
  });
  return sendEmail({ to, subject: `${clientName} blocked: ${amount} overdue`, html });
};

// ─── QR codes paused after the plan grace period ─────────────────────────────
const sendQrsPausedEmail = (to, { userName, count, link }) => {
  const html = baseLayout({
    title: `${count} QR code${count === 1 ? " is" : "s are"} now paused`,
    content: `
      <p>Hi ${escapeHtml(userName || "there")},</p>
      <p>Your paid plan expired and wasn't renewed, so <strong>${count} QR code${count === 1 ? "" : "s"}</strong> over the Free plan limit
      ${count === 1 ? "has" : "have"} been paused. Customers scanning ${count === 1 ? "it" : "them"} now see a "temporarily unavailable" page.</p>
      <p>Your most-scanned QR code keeps working. Renew any time and every QR code starts working again straight away — nothing has been deleted.</p>
    `,
    button: { text: "Renew my plan", link },
  });
  return sendEmail({ to, subject: `${count} of your review QR codes ${count === 1 ? "is" : "are"} paused`, html });
};

export {
  sendQrsPausedEmail,
  sendPaymentClaimEmail,
  sendTeamActivityEmail,
  sendClientBlockedEmail,
  sendAgencyClientBlockedEmail,
  sendClientLoginEmail,
  sendTeamInviteEmail,
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


