import redisClient from "../config/redis.js";

async function getCache(key) {
    if (!redisClient || !redisClient.isOpen || !redisClient.isReady) {
        return null;
    }
    try {
        const data = await redisClient.get(key);
        if (!data) return null;
        return JSON.parse(data);
    } catch (err) {
        console.error("Redis getCache error:", err);
        return null;
    }
}

async function setCache(key, value, Ex = 60) {
    if (!redisClient || !redisClient.isOpen || !redisClient.isReady) {
        return;
    }
    try {
        await redisClient.set(key, JSON.stringify(value), {
            EX: Ex,
        });
    } catch (err) {
        console.error("Redis setCache error:", err);
    }
}

async function delCache(key) {
    if (!redisClient || !redisClient.isOpen || !redisClient.isReady) {
        return;
    }
    try {
        await redisClient.del(key);
    } catch (err) {
        console.error("Redis delCache error:", err);
    }
}

async function invalidatePattern(pattern) {
    if (!redisClient || !redisClient.isOpen || !redisClient.isReady) {
        return;
    }
    try {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
            await redisClient.del(...keys);
        }
    } catch (err) {
        console.error("Redis invalidatePattern error:", err);
    }
}

export { getCache, setCache, delCache, invalidatePattern };