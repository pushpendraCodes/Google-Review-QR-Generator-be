import redisClient from "../config/redis.js";

async function getCache(key) {
    const data = await redisClient.get(key);
    if (!data) return null;
    return JSON.parse(data);
}

async function setCache(key, value, Ex = 60) {
    await redisClient.set(key, JSON.stringify(value), {
        EX: Ex,
    });
}

async function delCache(key) {
    await redisClient.del(key);
}

async function invalidatePattern(pattern) {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
        await redisClient.del(...keys);
    }
}

export { getCache, setCache, delCache, invalidatePattern };