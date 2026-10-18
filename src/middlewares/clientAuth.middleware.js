import ClientAccount from "../models/ClientAccount.js";
import { verifyClientToken, resolveClientAgency } from "../services/clientAuth.service.js";

// ─── Client portal protect ────────────────────────────────────────────────────
// Sets req.client (the client login), req.agency (the Agency owner) and req.agencyActive.
export const clientProtect = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Please sign in." });
    }

    const decoded = verifyClientToken(header.split(" ")[1]);
    const client = await ClientAccount.findById(decoded.cid);
    if (!client || (client.tokenVersion || 0) !== decoded.v) {
      return res.status(401).json({ message: "Your session has ended. Please sign in again." });
    }
    if (client.status !== "active") {
      return res.status(403).json({ code: "CLIENT_DISABLED", message: "This login has been turned off by your agency." });
    }

    const { agency, active } = await resolveClientAgency(client);
    if (!agency) return res.status(401).json({ message: "Your session has ended. Please sign in again." });

    req.client = client;
    req.agency = agency;
    req.agencyActive = active;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Your session has expired. Please sign in again." });
    }
    return res.status(401).json({ message: "Please sign in." });
  }
};
