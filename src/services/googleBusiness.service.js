import axios from "axios";
import { OAuth2Client } from "google-auth-library";
import GoogleBusinessConnection from "../models/GoogleBusinessConnection.js";
import GbpReview from "../models/GbpReview.js";
import { decryptToken, encryptToken } from "../utils/tokenCrypto.js";

const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

const STAR_MAP = {
  STAR_RATING_UNSPECIFIED: 0,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export function createGbpOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_GBP_CALLBACK_URL ||
    `${process.env.BACKEND_URL || "http://localhost:5000"}/api/gbp/callback`;

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured on the server.");
  }

  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

export function buildGbpAuthUrl(state) {
  const client = createGbpOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: [GBP_SCOPE],
    state,
  });
}

export async function exchangeGbpCode(code) {
  const client = createGbpOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

async function refreshAccessTokenIfNeeded(connection) {
  const client = createGbpOAuthClient();
  const refreshToken = decryptToken(connection.refreshTokenEnc);
  if (!refreshToken) {
    throw new GbpAuthError("Google connection expired. Please reconnect.");
  }

  client.setCredentials({
    refresh_token: refreshToken,
    access_token: decryptToken(connection.accessTokenEnc),
    expiry_date: connection.accessTokenExpiresAt
      ? connection.accessTokenExpiresAt.getTime()
      : 0,
  });

  const needsRefresh =
    !connection.accessTokenExpiresAt ||
    connection.accessTokenExpiresAt.getTime() < Date.now() + 60_000;

  if (needsRefresh) {
    const { credentials } = await client.refreshAccessToken();
    connection.accessTokenEnc = encryptToken(credentials.access_token || "");
    if (credentials.refresh_token) {
      connection.refreshTokenEnc = encryptToken(credentials.refresh_token);
    }
    connection.accessTokenExpiresAt = credentials.expiry_date
      ? new Date(credentials.expiry_date)
      : new Date(Date.now() + 3500 * 1000);
    await connection.save();
    client.setCredentials(credentials);
  }

  return client;
}

export class GbpAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GbpAuthError";
    this.statusCode = 401;
  }
}

export class GbpApiError extends Error {
  constructor(message, statusCode = 502, googleError = null) {
    super(message);
    this.name = "GbpApiError";
    this.statusCode = statusCode;
    this.googleError = googleError;
  }
}

async function gbpRequest(client, config) {
  const accessToken = client.credentials.access_token;
  try {
    const res = await axios({
      ...config,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(config.headers || {}),
      },
      timeout: 25_000,
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const googleBody = err.response?.data;
    const detail =
      googleBody?.error?.message ||
      googleBody?.message ||
      err.message;

    console.error("GBP API request failed:", {
      url: config.url,
      status,
      detail,
      googleError: googleBody?.error || googleBody,
    });

    if (status === 401) {
      throw new GbpAuthError(
        "Google authorization expired. Please reconnect your Business Profile."
      );
    }

    if (status === 403) {
      throw new GbpApiError(
        detail?.includes("has not been used") || detail?.includes("disabled")
          ? `${detail} Enable "My Business Account Management API", "My Business Business Information API", and "Google My Business API" in Google Cloud Console, then request GBP API access if required.`
          : `Google Business Profile access denied (403): ${detail}. Usually this means (1) the GBP APIs are not enabled for your Cloud project, (2) Google has not approved GBP API access for this project, or (3) this Google account does not manage a Business Profile.`,
        403,
        googleBody?.error || null
      );
    }

    throw new GbpApiError(detail || "Google Business Profile request failed.", status || 502);
  }
}

export async function getConnectionForUser(userId) {
  return GoogleBusinessConnection.findOne({ owner: userId, status: "active" });
}

export async function saveConnectionTokens(userId, tokens) {
  if (!tokens.refresh_token) {
    const existing = await GoogleBusinessConnection.findOne({ owner: userId });
    if (!existing?.refreshTokenEnc) {
      throw new GbpAuthError(
        "Google did not return a refresh token. Disconnect and connect again with consent."
      );
    }
  }

  let connection = await GoogleBusinessConnection.findOne({ owner: userId });
  if (!connection) {
    connection = new GoogleBusinessConnection({ owner: userId });
  }

  connection.accessTokenEnc = encryptToken(tokens.access_token || "");
  if (tokens.refresh_token) {
    connection.refreshTokenEnc = encryptToken(tokens.refresh_token);
  }
  connection.accessTokenExpiresAt = tokens.expiry_date
    ? new Date(tokens.expiry_date)
    : new Date(Date.now() + 3500 * 1000);
  connection.scopes = tokens.scope ? tokens.scope.split(" ") : [GBP_SCOPE];
  connection.status = "active";
  connection.lastError = "";
  connection.connectedAt = connection.connectedAt || new Date();

  await connection.save();
  return connection;
}

function toFullLocationResourceName(accountId, locationName) {
  // Business Information API returns "locations/{id}"; reviews API needs
  // "accounts/{accountId}/locations/{id}"
  if (!locationName) return "";
  if (locationName.startsWith("accounts/")) return locationName;
  const locationId = locationName.replace(/^locations\//, "");
  return `accounts/${accountId}/locations/${locationId}`;
}

export async function fetchAndStoreAccountsAndLocations(userId) {
  const connection = await getConnectionForUser(userId);
  if (!connection) throw new GbpAuthError("Not connected to Google Business Profile.");

  const client = await refreshAccessTokenIfNeeded(connection);

  const accountsData = await gbpRequest(client, {
    method: "GET",
    url: "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
  });

  const accounts = accountsData.accounts || [];
  if (!accounts.length) {
    throw new GbpApiError(
      "No Google Business Profile accounts found for this Google user. Sign in with the Google account that owns/manages the business in Google Business Profile."
    );
  }

  const primary = accounts[0];
  connection.googleAccountResourceName = primary.name;
  connection.googleAccountDisplayName =
    primary.accountName || primary.organizationInfo?.registeredDomain || "Business account";

  const locations = [];
  for (const account of accounts) {
    const accountId = String(account.name || "").replace(/^accounts\//, "");
    if (!accountId) continue;

    try {
      const locationsData = await gbpRequest(client, {
        method: "GET",
        url: `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${accountId}/locations`,
        params: {
          readMask: "name,title,storefrontAddress,metadata",
          pageSize: 100,
        },
      });

      for (const loc of locationsData.locations || []) {
        locations.push({
          locationResourceName: toFullLocationResourceName(accountId, loc.name),
          title: loc.title || "Untitled location",
          placeId: loc.metadata?.placeId || "",
          address: formatAddress(loc.storefrontAddress),
        });
      }
    } catch (err) {
      // Keep trying other accounts; surface last failure if none found
      console.warn(`GBP locations fetch failed for account ${accountId}:`, err.message);
      if (!locations.length && accounts.indexOf(account) === accounts.length - 1) {
        throw err;
      }
    }
  }

  connection.locations = locations;
  if (!locations.length) {
    connection.selectedLocationResourceName = "";
    connection.lastError =
      "Connected, but no business locations were returned. Use a Google account that manages a verified Business Profile, and ensure GBP APIs are enabled/approved.";
  } else {
    const stillValid = locations.some(
      (l) => l.locationResourceName === connection.selectedLocationResourceName
    );
    if (!stillValid) {
      connection.selectedLocationResourceName = locations[0].locationResourceName;
    }
    connection.lastError = "";
  }

  await connection.save();
  return connection;
}

function formatAddress(addr) {
  if (!addr) return "";
  const parts = [
    ...(addr.addressLines || []),
    addr.locality,
    addr.administrativeArea,
    addr.postalCode,
  ].filter(Boolean);
  return parts.join(", ");
}

export function parseLocationIds(locationResourceName) {
  const match = locationResourceName.match(/accounts\/([^/]+)\/locations\/([^/]+)/);
  if (!match) return null;
  return { accountId: match[1], locationId: match[2] };
}

function mapReviewDoc(review, owner, locationResourceName) {
  const reviewId = review.reviewId || review.name?.split("/").pop() || "";
  const reply = review.reviewReply;
  const replyComment = reply?.comment || "";
  return {
    owner,
    locationResourceName,
    googleReviewId: reviewId,
    reviewResourceName: review.name,
    reviewerDisplayName: review.reviewer?.displayName || "Google User",
    reviewerProfilePhotoUrl: review.reviewer?.profilePhotoUrl || "",
    starRating: STAR_MAP[review.starRating] ?? 0,
    comment: review.comment || "",
    createTime: review.createTime ? new Date(review.createTime) : null,
    updateTime: review.updateTime ? new Date(review.updateTime) : null,
    replyComment,
    replyUpdateTime: reply?.updateTime ? new Date(reply.updateTime) : null,
    replyStatus: replyComment.trim() ? "replied" : "unreplied",
    lastSyncedAt: new Date(),
  };
}

export async function syncReviewsForUser(userId) {
  const connection = await getConnectionForUser(userId);
  if (!connection) throw new GbpAuthError("Not connected to Google Business Profile.");
  if (!connection.selectedLocationResourceName) {
    throw new GbpApiError("Select a business location before syncing reviews.");
  }

  const ids = parseLocationIds(connection.selectedLocationResourceName);
  if (!ids) throw new GbpApiError("Invalid location reference.");

  const client = await refreshAccessTokenIfNeeded(connection);
  const locationResourceName = connection.selectedLocationResourceName;

  let pageToken;
  let totalSynced = 0;
  let averageRating;
  let totalReviewCount;

  do {
    const data = await gbpRequest(client, {
      method: "GET",
      url: `https://mybusiness.googleapis.com/v4/accounts/${ids.accountId}/locations/${ids.locationId}/reviews`,
      params: {
        pageSize: 50,
        pageToken,
      },
    });

    averageRating = data.averageRating;
    totalReviewCount = data.totalReviewCount;

    const reviews = data.reviews || [];
    for (const review of reviews) {
      const doc = mapReviewDoc(review, userId, locationResourceName);
      await GbpReview.findOneAndUpdate(
        {
          owner: userId,
          locationResourceName,
          googleReviewId: doc.googleReviewId,
        },
        { $set: doc },
        { upsert: true, new: true }
      );
      totalSynced += 1;
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  connection.lastSyncAt = new Date();
  connection.lastError = "";
  await connection.save();

  return {
    synced: totalSynced,
    averageRating,
    totalReviewCount,
    locationResourceName,
  };
}

export async function postReviewReply(userId, reviewResourceName, comment) {
  const connection = await getConnectionForUser(userId);
  if (!connection) throw new GbpAuthError("Not connected.");

  const client = await refreshAccessTokenIfNeeded(connection);

  const resourcePath = reviewResourceName.replace(/^\/+/, "");
  const data = await gbpRequest(client, {
    method: "PUT",
    url: `https://mybusiness.googleapis.com/v4/${resourcePath}/reply`,
    data: { comment: comment.trim() },
  });

  await GbpReview.findOneAndUpdate(
    { owner: userId, reviewResourceName },
    {
      $set: {
        replyComment: data.comment || comment.trim(),
        replyUpdateTime: data.updateTime ? new Date(data.updateTime) : new Date(),
        replyStatus: "replied",
        lastSyncedAt: new Date(),
      },
    }
  );

  return data;
}

export async function disconnectGbp(userId) {
  await GbpReview.deleteMany({ owner: userId });
  await GoogleBusinessConnection.deleteOne({ owner: userId });
}
