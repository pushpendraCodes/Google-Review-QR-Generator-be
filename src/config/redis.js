import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();
const redisClient = createClient({
    username: process.env.REDIS_USERNAME || "default",
    password: process.env.REDIS_PASSWORD,
    socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT
    }
});

redisClient.on("error", (err) => {
    console.error("❌ Redis Client Error:", err);
});

redisClient.on("connect", () => {
    console.log("🔌 Connecting to Redis...");
});

redisClient.on("ready", () => {
    console.log("✅ Redis connected successfully!");
});

redisClient.connect();
export default redisClient;



// for referensce https://github.com/sumankalia/node-redis