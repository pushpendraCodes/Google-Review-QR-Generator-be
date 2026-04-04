// import nodemailer from "nodemailer";

// const transporter = nodemailer.createTransport({
//   service: "gmail",
//   auth: {
//     user: process.env.SMTP_EMAIL,
//     pass: process.env.SMTP_PASSWORD,
//   },
// });

// const sendEmail = async ({ to, subject, html }) => {
//   const mailOptions = {
//     from: `"${process.env.SMTP_FROM_NAME || "QR Reviews"}" <${process.env.SMTP_EMAIL}>`,
//     to,
//     subject,
//     html,
//   };
//   return transporter.sendMail(mailOptions);
// };

// // ─── OTP email ────────────────────────────────────────────────────────────────
// const sendOtpEmail = (to, otp, type = "verify") => {
//   const subject =
//     type === "verify" ? "Verify your email — QR Reviews" : "Reset your password — QR Reviews";
//   const title = type === "verify" ? "Verify Your Email" : "Reset Your Password";
//   const message =
//     type === "verify"
//       ? "Use the OTP below to verify your email address."
//       : "Use the OTP below to reset your password. It expires in 10 minutes.";

//   return sendEmail({
//     to,
//     subject,
//     html: `
//       <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
//         <h2 style="color:#1d4ed8;">${title}</h2>
//         <p style="color:#374151;">${message}</p>
//         <div style="background:#f3f4f6;border-radius:8px;padding:20px;text-align:center;margin:24px 0;">
//           <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#111827;">${otp}</span>
//         </div>
//         <p style="color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
//       </div>
//     `,
//   });
// };

// // ─── Weekly analytics report ───────────────────────────────────────────────────
// const sendWeeklyReportEmail = (to, { userName, totalScans, topQr, changePercent }) => {
//   const arrow = changePercent >= 0 ? "▲" : "▼";
//   const color = changePercent >= 0 ? "#16a34a" : "#dc2626";

//   return sendEmail({
//     to,
//     subject: "📊 Your Weekly QR Scan Report",
//     html: `
//       <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
//         <h2 style="color:#1d4ed8;">Weekly Scan Report</h2>
//         <p>Hi ${userName}, here's your scan summary for this week:</p>
//         <table style="width:100%;border-collapse:collapse;margin:16px 0;">
//           <tr>
//             <td style="padding:12px;background:#f9fafb;border-radius:8px;">
//               <div style="font-size:13px;color:#6b7280;">Total Scans This Week</div>
//               <div style="font-size:28px;font-weight:bold;color:#111827;">${totalScans}</div>
//               <div style="font-size:13px;color:${color};">${arrow} ${Math.abs(changePercent)}% vs last week</div>
//             </td>
//           </tr>
//         </table>
//         ${topQr ? `<p style="color:#374151;">🏆 <strong>Top QR:</strong> ${topQr.businessName} (${topQr.count} scans)</p>` : ""}
//         <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1d4ed8;color:white;text-decoration:none;border-radius:6px;">View Full Dashboard</a>
//         <p style="color:#9ca3af;font-size:12px;margin-top:24px;">You're receiving this because you're on a Pro or Agency plan.</p>
//       </div>
//     `,
//   });
// };

// export { sendEmail, sendOtpEmail, sendWeeklyReportEmail };



// resend
// services/emailService.js


import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Core sender (mirrors nodemailer's sendMail signature) ─────────────────────
const sendEmail = async ({ to, subject, html }) => {
  const { data, error } = await resend.emails.send({
    from: `"${process.env.SMTP_FROM_NAME || "QR Reviews"}" <${process.env.SMTP_EMAIL}>`,
    to,
    subject,
    html,
  });

  if (error) throw new Error(error.message);
  return data;
};

// ─── OTP email ────────────────────────────────────────────────────────────────
const sendOtpEmail = (to, otp, type = "verify") => {
  const subject =
    type === "verify" ? "Verify your email — QR Reviews" : "Reset your password — QR Reviews";
  const title = type === "verify" ? "Verify Your Email" : "Reset Your Password";
  const message =
    type === "verify"
      ? "Use the OTP below to verify your email address."
      : "Use the OTP below to reset your password. It expires in 10 minutes.";

  return sendEmail({
    to,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
        <h2 style="color:#1d4ed8;">${title}</h2>
        <p style="color:#374151;">${message}</p>
        <div style="background:#f3f4f6;border-radius:8px;padding:20px;text-align:center;margin:24px 0;">
          <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#111827;">${otp}</span>
        </div>
        <p style="color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
};

// ─── Weekly analytics report ───────────────────────────────────────────────────
const sendWeeklyReportEmail = (to, { userName, totalScans, topQr, changePercent }) => {
  const arrow = changePercent >= 0 ? "▲" : "▼";
  const color = changePercent >= 0 ? "#16a34a" : "#dc2626";

  return sendEmail({
    to,
    subject: "📊 Your Weekly QR Scan Report",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
        <h2 style="color:#1d4ed8;">Weekly Scan Report</h2>
        <p>Hi ${userName}, here's your scan summary for this week:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr>
            <td style="padding:12px;background:#f9fafb;border-radius:8px;">
              <div style="font-size:13px;color:#6b7280;">Total Scans This Week</div>
              <div style="font-size:28px;font-weight:bold;color:#111827;">${totalScans}</div>
              <div style="font-size:13px;color:${color};">${arrow} ${Math.abs(changePercent)}% vs last week</div>
            </td>
          </tr>
        </table>
        ${topQr ? `<p style="color:#374151;">🏆 <strong>Top QR:</strong> ${topQr.businessName} (${topQr.count} scans)</p>` : ""}
        <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1d4ed8;color:white;text-decoration:none;border-radius:6px;">View Full Dashboard</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">You're receiving this because you're on a Pro or Agency plan.</p>
      </div>
    `,
  });
};

// ─── Contact / Enquiry email to admin ─────────────────────────────────────────
const sendEnquiryEmail = ({ name, email, phone, message }) => {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  return sendEmail({
    to: process.env.ADMIN_EMAIL,          // e.g. admin@reviewqr.in
    subject: `📩 New Enquiry from ${name} — ReviewQR.in`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">

        <!-- Header -->
        <div style="background:#1D9E75;padding:24px 28px;">
          <h2 style="margin:0;color:#ffffff;font-size:20px;">📩 New Enquiry Received</h2>
          <p style="margin:4px 0 0;color:#d1fae5;font-size:13px;">via ReviewQR.in Contact Form</p>
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
          <a href="mailto:${email}?subject=Re: Your enquiry on ReviewQR.in"
            style="display:inline-block;padding:12px 24px;background:#1D9E75;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
            ↩ Reply to ${name}
          </a>
        </div>

        <!-- Footer -->
        <div style="padding:16px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            This email was sent automatically from the ReviewQR.in contact form.
          </p>
        </div>
      </div>
    `,
  });
};

// ── add to your existing export ───────────────────────────────────────────────
export { sendEmail, sendOtpEmail, sendWeeklyReportEmail, sendEnquiryEmail };


