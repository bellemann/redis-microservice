import express from "express";
import cors from "cors";
import Redis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.options("*", cors()); // Preflight support for all routes
app.use(express.json());

// ===== Redis connection (disable ready check warning) =====
const redis = new Redis(process.env.REDIS_URL, { enableReadyCheck: false });

// ===== In-Memory Cache =====
const cache = {};

function getCached(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    delete cache[key];
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlSeconds = 30) {
  cache[key] = {
    data,
    expires: Date.now() + ttlSeconds * 1000
  };
}

// ===== Simple /ping test (no auth) =====
app.all("/ping", (_req, res) => {
  res.send("pong");
});

// ===== Public health endpoint (no auth) =====
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// ===== Public welcome/info (no auth) =====
app.get("/", (_req, res) => {
  res.type("text").send("Redis Microservice online. Public: /ping, /healthz, /feed/explore. Auth routes: POST /, /whoami, /debug-auth, /feed/following.");
});

// ===== GET /feed/explore: Explore feed with pagination (PUBLIC) =====
app.get("/feed/explore", async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    let limit = parseInt(req.query.limit) || 20;

    // Validate and cap limit at 100
    if (limit > 100) limit = 100;

    const cacheKey = `explore_feed_${offset}_${limit}`;

    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] ${cacheKey}`);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] ${cacheKey}`);

    // Fetch a buffer of post IDs to account for missing posts/users
    const bufferMultiplier = 2;
    const bufferSize = limit * bufferMultiplier;
    let currentOffset = offset;
    let posts = [];

    // Continue fetching until we have enough posts or run out of items
    while (posts.length < limit) {
      const postIds = await redis.zrevrange(
        "explore:feed",
        currentOffset,
        currentOffset + bufferSize - 1
      );

      console.log(`Fetched ${postIds.length} post IDs from explore:feed at offset ${currentOffset}`);

      // No more posts available
      if (postIds.length === 0) break;

      // Aggregate posts with user data
      const aggregated = await aggregatePostsWithUsers(postIds);
      posts.push(...aggregated);

      // If we've collected enough posts, trim to exact limit
      if (posts.length >= limit) {
        posts = posts.slice(0, limit);
        break;
      }

      // Move offset forward for next iteration
      currentOffset += postIds.length;
    }

    console.log(`Found ${posts.length} valid posts in explore:feed`);

    const response = {
      posts,
      pagination: {
        offset,
        limit,
        count: posts.length
      }
    };

    // Cache the result for 30 seconds
    setCache(cacheKey, response, 30);

    res.json(response);
  } catch (err) {
    console.error("Error fetching explore feed:", err);
    res.status(500).json({ error: "Failed to fetch explore feed" });
  }
});

// ===== JWT AUTH MIDDLEWARE =====
app.use((req, res, next) => {
  // Allow CORS preflight requests through without auth
  if (req.method === "OPTIONS") return next();

  const authHeader =
    req.headers.authorization ||
    req.headers["x-authorization"] ||
    req.headers["x-access-token"];

  console.log("Authorization header I got:", authHeader);
  if (!authHeader) return res.status(401).json({ error: "Missing token" });

  const parts = String(authHeader).split(" ");
  const token =
    parts.length === 2 && parts[0].toLowerCase() === "bearer"
      ? parts[1]
      : String(authHeader);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
});

// ===== Helper: Aggregate posts with user data =====
async function aggregatePostsWithUsers(postIds) {
  if (postIds.length === 0) return [];

  // First pipeline: Fetch all posts
  const postPipeline = redis.pipeline();
  for (const postId of postIds) {
    postPipeline.hgetall(`post:${postId}`);
  }
  const postResults = await postPipeline.exec();

  // Collect user_id values and build unique set
  const userIds = new Set();
  const posts = [];

  for (let i = 0; i < postIds.length; i++) {
    const [err, postData] = postResults[i];
    if (err || !postData || !postData.user_id) {
      posts.push(null);
      continue;
    }
    posts.push(postData);
    userIds.add(postData.user_id);
  }

  // Second pipeline: Fetch all unique users
  const userPipeline = redis.pipeline();
  const userIdArray = Array.from(userIds);
  for (const userId of userIdArray) {
    userPipeline.hgetall(`user:${userId}`);
  }
  const userResults = await userPipeline.exec();

  // Build map of user_id -> userData
  const userMap = {};
  for (let i = 0; i < userIdArray.length; i++) {
    const [err, userData] = userResults[i];
    if (!err && userData && Object.keys(userData).length > 0) {
      userMap[userIdArray[i]] = userData;
    }
  }

  // Iterate original postIds order and push { post, user } only when both exist
  const results = [];
  for (const postData of posts) {
    if (!postData) continue;
    const userData = userMap[postData.user_id];
    if (!userData) continue;

    results.push({
      post: postData,
      user: userData
    });
  }

  return results;
}

// ===== Read‑only Redis proxy endpoint =====
app.post("/", async (req, res) => {
  let commands = req.body;
  if (!Array.isArray(commands)) {
    if (Array.isArray(req.body.commands)) commands = req.body.commands;
    else
      return res
        .status(400)
        .json({ error: "Body must be an array of Redis commands" });
  }

  const results = [];
  const tokenUserId = req.user.user_id;

  for (const [cmdRaw, ...args] of commands) {
    const cmd = cmdRaw.toUpperCase();

    // disallow write ops
    const writeCommands = [
      "SET",
      "DEL",
      "HSET",
      "HINCRBY",
      "ZADD",
      "ZREM",
      "INCR",
      "DECR",
      "MSET",
      "APPEND",
      "EXPIRE"
    ];
    if (writeCommands.includes(cmd)) {
      results.push("ERR read-only mode");
      continue;
    }

    try {
      // Replace user:AUTH placeholders
      const argsProcessed = args.map((a) =>
        typeof a === "string" ? a.replace("user:AUTH", `user:${tokenUserId}`) : a
      );

      // Restrict user:<id>:following access
      if (
        argsProcessed.length > 0 &&
        typeof argsProcessed[0] === "string" &&
        /^user:[\w-]+:following$/.test(argsProcessed[0])
      ) {
        const idInKey = argsProcessed[0].split(":")[1];
        if (idInKey !== tokenUserId) {
          results.push("ERR forbidden: private resource");
          continue;
        }
      }

      // Block sensitive keys like otp:* and session*
      if (
        argsProcessed.length > 0 &&
        typeof argsProcessed[0] === "string"
      ) {
        const key = argsProcessed[0];
        if (/^otp:[\w-]+$/.test(key) || /^session[\w-]+$/.test(key)) {
          results.push("ERR forbidden: private key");
          continue;
        }
      }

      // Console logging for debug
      console.log("=== Redis Request ===");
      console.log("JWT user_id:", req.user.user_id);
      console.log("Command:", cmdRaw);
      console.log("Original args:", args);
      console.log("Resolved args:", argsProcessed);

      const result = await redis[cmd.toLowerCase()](...argsProcessed);

      console.log("Redis result:", result);
      console.log("=====================");

      results.push(result);
    } catch (err) {
      console.error("Redis error:", err);
      results.push(`ERR ${err.message}`);
    }
  }

  res.json(results);
});

// ===== GET /feed/following: Following feed with pagination =====
app.get("/feed/following", async (req, res) => {
  try {
    const userId = req.user.user_id;
    const offset = parseInt(req.query.offset) || 0;
    let limit = parseInt(req.query.limit) || 20;

    // Validate and cap limit at 100
    if (limit > 100) limit = 100;

    const cacheKey = `following_feed_${userId}_${offset}_${limit}`;

    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] ${cacheKey}`);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] ${cacheKey}`);

    // Get list of users being followed
    const followingIds = await redis.smembers(`user:${userId}:following`);

    console.log(`User ${userId} follows ${followingIds.length} users`);

    if (followingIds.length === 0) {
      const response = {
        posts: [],
        pagination: {
          offset,
          limit,
          count: 0
        }
      };
      setCache(cacheKey, response, 30);
      return res.json(response);
    }

    // Build keys for user:{id}:posts sorted sets
    const userPostKeys = followingIds.map(id => `user:${id}:posts`);

    // Verify existence of user:{id}:posts keys by checking a sample
    const sampleKey = userPostKeys[0];
    const sampleExists = await redis.exists(sampleKey);

    let posts = [];

    if (sampleExists === 0) {
      console.warn(`user:{uuid}:posts structure not found. Falling back to explore:feed filtering.`);

      // Fallback: Use explore:feed and filter by followed user_id
      const followingSet = new Set(followingIds);
      const bufferMultiplier = 3;
      let currentOffset = 0;
      let matched = 0;

      // Continue fetching until we have enough posts or run out of items
      while (posts.length < limit) {
        const bufferSize = limit * bufferMultiplier;
        const explorePosts = await redis.zrevrange("explore:feed", currentOffset, currentOffset + bufferSize - 1);

        console.log(`Fetched ${explorePosts.length} posts from explore:feed at offset ${currentOffset}`);

        // No more posts available
        if (explorePosts.length === 0) break;

        // Pipeline to get user_id for each post
        const pipeline = redis.pipeline();
        for (const postId of explorePosts) {
          pipeline.hget(`post:${postId}`, "user_id");
        }
        const userIdResults = await pipeline.exec();

        // Filter posts by followed users
        const filteredPostIds = [];
        for (let i = 0; i < explorePosts.length; i++) {
          const [err, postUserId] = userIdResults[i];
          if (err || !postUserId) continue;

          if (followingSet.has(postUserId)) {
            matched++;
            // Apply offset and limit
            if (matched > offset && posts.length < limit) {
              filteredPostIds.push(explorePosts[i]);
            }
          }
        }

        // Aggregate the filtered posts
        if (filteredPostIds.length > 0) {
          const aggregated = await aggregatePostsWithUsers(filteredPostIds);
          posts.push(...aggregated);
        }

        // If we've collected enough posts, trim to exact limit
        if (posts.length >= limit) {
          posts = posts.slice(0, limit);
          break;
        }

        // Move offset forward for next iteration
        currentOffset += explorePosts.length;

        // Safety limit to prevent infinite loops
        if (currentOffset > 10000) break;
      }

      console.log(`Filtered to ${posts.length} posts from followed users`);
    } else {
      // Use ZUNIONSTORE to merge all followed users' posts into temporary sorted set
      const tmpKey = `tmp:home:${userId}`;
      await redis.zunionstore(tmpKey, userPostKeys.length, ...userPostKeys);

      // Set short expiration (15 seconds)
      await redis.expire(tmpKey, 15);

      console.log(`Created temporary union set ${tmpKey}`);

      // Fetch a buffer to account for missing posts/users
      const bufferMultiplier = 2;
      const bufferSize = limit * bufferMultiplier;
      let currentOffset = offset;

      // Continue fetching until we have enough posts or run out of items
      while (posts.length < limit) {
        const fetchedIds = await redis.zrevrange(tmpKey, currentOffset, currentOffset + bufferSize - 1);

        console.log(`Fetched ${fetchedIds.length} post IDs from ${tmpKey} at offset ${currentOffset}`);

        // No more posts available
        if (fetchedIds.length === 0) break;

        // Aggregate posts with user data
        const aggregated = await aggregatePostsWithUsers(fetchedIds);
        posts.push(...aggregated);

        // If we've collected enough posts, trim to exact limit
        if (posts.length >= limit) {
          posts = posts.slice(0, limit);
          break;
        }

        // Move offset forward for next iteration
        currentOffset += fetchedIds.length;
      }

      console.log(`Found ${posts.length} valid posts in following feed`);
    }

    const response = {
      posts,
      pagination: {
        offset,
        limit,
        count: posts.length
      }
    };

    // Cache the result for 30 seconds
    setCache(cacheKey, response, 30);

    res.json(response);
  } catch (err) {
    console.error("Error fetching following feed:", err);
    res.status(500).json({ error: "Failed to fetch following feed" });
  }
});

// ===== /debug-auth: shows resolved Redis key =====
app.all("/debug-auth", async (req, res) => {
  try {
    const tokenUserId = req.user.user_id;
    const resolvedKey = `user:${tokenUserId}`;
    const data = await redis.hgetall(resolvedKey);

    console.log("=== /debug-auth ===");
    console.log("Token user_id:", tokenUserId);
    console.log("Resolved key:", resolvedKey);
    console.log("Redis data:", data);
    console.log("===================");

    res.json({
      user_id: tokenUserId,
      resolved_key: resolvedKey,
      redis_data: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== /whoami: return JWT payload =====
app.all("/whoami", (req, res) => {
  res.json({
    jwt_payload: req.user,
    resolved_user_key: `user:${req.user.user_id}`
  });
});

// ===== Error / crash logging =====
process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
