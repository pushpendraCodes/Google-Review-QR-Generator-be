import { sendEnquiryEmail } from "../../services/email.service.js";

export const sendEnquiry = async (req, res) => {
    try {
        const { name, email, phone, message } = req.body;

        // ── Basic validation ──────────────────────────────────────────
        if (!name || !email || !message) {
            return res.status(400).json({
                success: false,
                message: "Name, email, and message are required.",
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid email address.",
            });
        }

        if (phone && !/^[6-9]\d{9}$/.test(phone)) {
            return res.status(400).json({
                success: false,
                message: "Please provide a valid 10-digit Indian phone number.",
            });
        }

        // ── Send to admin ─────────────────────────────────────────────
        await sendEnquiryEmail({ name, email, phone, message });

        return res.status(200).json({
            success: true,
            message: "Your enquiry has been sent. We'll get back to you soon!",
        });
    } catch (err) {
        console.error("Enquiry email error:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to send enquiry. Please try again later.",
        });
    }
};