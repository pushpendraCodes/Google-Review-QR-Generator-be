// Creates the first super-admin. Only works while no admin accounts exist.
// Usage: npm run create-admin -- <email> <password> [name]
import dotenv from "dotenv";
import mongoose from "mongoose";
import AdminUser from "../src/models/AdminUser.js";

dotenv.config();

const [email, password, name = "Super Admin"] = process.argv.slice(2);

if (!email || !password) {
  console.error("Usage: npm run create-admin -- <email> <password> [name]");
  process.exit(1);
}

try {
  await mongoose.connect(process.env.MONGODB_URI);
  if (await AdminUser.countDocuments()) {
    console.error("An admin already exists. Add more admins from the admin panel.");
    process.exitCode = 1;
  } else {
    const admin = await AdminUser.create({ name, email, password, role: "superadmin" });
    console.log(`Super admin created: ${admin.email}`);
  }
} catch (err) {
  console.error("Failed to create admin:", err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
