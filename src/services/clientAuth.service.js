import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { isTeamOwnerActive } from "./team.service.js";

const CLIENT_TOKEN_TTL = "7d";

// Distinct secret so a client token can never pass the agency `protect` middleware (and vice versa).
const clientSecret = () =>
  process.env.CLIENT_TOKEN_SECRET || `${process.env.ACCESS_TOKEN_SECRET}:client-portal`;

if (process.env.NODE_ENV === "production" && !process.env.CLIENT_TOKEN_SECRET) {
  console.warn("CLIENT_TOKEN_SECRET is not set; client portal tokens fall back to a secret derived from ACCESS_TOKEN_SECRET.");
}

export const signClientToken = (client) =>
  jwt.sign({ cid: String(client._id), v: client.tokenVersion || 0, typ: "client" }, clientSecret(), {
    expiresIn: CLIENT_TOKEN_TTL,
  });

export const verifyClientToken = (token) => {
  const decoded = jwt.verify(token, clientSecret());
  if (decoded?.typ !== "client" || !decoded.cid) throw new Error("Invalid client token");
  return decoded;
};

// No look-alike characters (0/O, 1/l/I) so passwords are easy to read out or type.
const PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export const generateClientPassword = (length = 12) => {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
};

/** The agency owner behind a client, and whether their Agency plan currently allows client access. */
export const resolveClientAgency = async (client) => {
  const agency = await User.findById(client.agency).select("name email businessName picture plan planExpiresAt status");
  return { agency, active: Boolean(agency && isTeamOwnerActive(agency)) };
};
