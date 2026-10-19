import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    mobile: { type: String, default: "" },
    picture: { type: String, default: "" },
    authProvider: { type: String, enum: ["google", "email"], required: true },
    googleId: { type: String, sparse: true, unique: true },
    password: { type: String, default: null },

    isEmailVerified: { type: Boolean, default: false },
    emailOtp: { type: String, default: null },
    emailOtpExpiry: { type: Date, default: null },
    otpVerified: { type: Boolean, default: false },


    refreshToken: {
      type: String,
      select: false, // never returned in queries by default
    },

    // Onboarding
    businessName: { type: String, default: "" },
    businessType: {
      type: String,
      enum: ["restaurant", "salon", "clinic", "hotel", "other", ""],
      default: "",
    },
    businessCity: { type: String, default: "" },
    firstLogin: { type: Boolean, default: true },

    // Subscription
    plan: { type: String, enum: ["free", "starter", "pro", "agency"], default: "free" },
    planExpiresAt: { type: Date, default: null },

    // Agency team: set when this user is a staff member of an Agency owner.
    // Staff work inside the owner's account and use the owner's plan.
    teamOwner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    teamJoinedAt: { type: Date, default: null },
    // Agency owners: purchased/admin-granted seats on top of the included ones.
    extraSeats: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: ["active", "block"], default: "active" },
    lastLoginAt: { type: Date, default: null },
    inactivityReminderSent: { type: Boolean, default: false },
    emailNotifications: { type: Boolean, default: true },
    weeklyReportEnabled: { type: Boolean, default: true },

    // Plan expiry notification tracking
    planExpiryWarningSent: { type: Boolean, default: false },
    planExpiredNotifSent: { type: Boolean, default: false },
    // When a paid plan ran out without renewal.
    planLapsedAt: { type: Date, default: null },
    // While not on a paid plan, every QR in the account pauses at this date
    // (Free period from the first QR, or the grace period after a plan lapses).
    freeQrStopAt: { type: Date, default: null },
    qrStopWarningSent: { type: Boolean, default: false },
    qrPauseNotifSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Hash password before save
userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password helper
userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Remove sensitive fields from JSON output
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailOtp;
  delete obj.emailOtpExpiry;
  delete obj.otpVerified;
  return obj;
};

export default mongoose.model("User", userSchema);
