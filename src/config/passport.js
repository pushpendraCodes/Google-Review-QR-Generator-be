import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import User from "../models/User.js";

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails[0].value.toLowerCase();

        // Check if a user with this email already exists
        let user = await User.findOne({ email });

        if (user) {
          // Existing email-signup user tries to log in via Google → link accounts
          if (user.authProvider === "email") {
            user.authProvider = "google";
            user.googleId = profile.id;
            user.isEmailVerified = true;
            user.picture = user.picture || profile.photos?.[0]?.value;
            await user.save();
          }
          user.lastLoginAt = new Date();
          await user.save();
          return done(null, user);
        }

        // New user via Google
        user = await User.create({
          name: profile.displayName,
          email,
          googleId: profile.id,
          picture: profile.photos?.[0]?.value || "",
          authProvider: "google",
          isEmailVerified: true,
          lastLoginAt: new Date(),
        });

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);
