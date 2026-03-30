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

    status: { type: String, enum: ["active", "block"], default: "active" },
    lastLoginAt: { type: Date, default: null },
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
