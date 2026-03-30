import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

const sendEmail = async ({ to, subject, html }) => {
  const mailOptions = {
    from: `"${process.env.SMTP_FROM_NAME || "QR Reviews"}" <${process.env.SMTP_EMAIL}>`,
    to,
    subject,
    html,
  };
  return transporter.sendMail(mailOptions);
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

export { sendEmail, sendOtpEmail, sendWeeklyReportEmail };
