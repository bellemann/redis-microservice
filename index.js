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

// ===== Redis Request Counter =====
const requestCounters = new Map();

function getRequestId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function initRedisCounter(requestId) {
  requestCounters.set(requestId, { commands: 0, pipelines: 0 });
}

function incrementRedisCounter(requestId, type = 'command') {
  const counter = requestCounters.get(requestId);
  if (counter) {
    if (type === 'pipeline') {
      counter.pipelines++;
    } else {
      counter.commands++;
    }
  }
}

function getRedisCounter(requestId) {
  return requestCounters.get(requestId) || { commands: 0, pipelines: 0 };
}

function cleanupRedisCounter(requestId) {
  requestCounters.delete(requestId);
}

// Wrap Redis commands to count them
const originalRedis = {
  zrevrange: redis.zrevrange.bind(redis),
  smembers: redis.smembers.bind(redis),
  exists: redis.exists.bind(redis),
  zunionstore: redis.zunionstore.bind(redis),
  expire: redis.expire.bind(redis),
  hgetall: redis.hgetall.bind(redis),
  hget: redis.hget.bind(redis),
  pipeline: redis.pipeline.bind(redis)
};

function wrapRedisCommand(commandName, originalFn, requestId) {
  return function(...args) {
    incrementRedisCounter(requestId, 'command');
    return originalFn(...args);
  };
}

function createTrackedRedis(requestId) {
  return {
    zrevrange: wrapRedisCommand('zrevrange', originalRedis.zrevrange, requestId),
    smembers: wrapRedisCommand('smembers', originalRedis.smembers, requestId),
    exists: wrapRedisCommand('exists', originalRedis.exists, requestId),
    zunionstore: wrapRedisCommand('zunionstore', originalRedis.zunionstore, requestId),
    expire: wrapRedisCommand('expire', originalRedis.expire, requestId),
    hgetall: wrapRedisCommand('hgetall', originalRedis.hgetall, requestId),
    hget: wrapRedisCommand('hget', originalRedis.hget, requestId),
    pipeline: function() {
      const pipeline = originalRedis.pipeline();
      const originalExec = pipeline.exec.bind(pipeline);
      pipeline.exec = async function() {
        incrementRedisCounter(requestId, 'pipeline');
        return await originalExec();
      };
      return pipeline;
    }
  };
}

// ===== In-Memory Cache =====
const cache = {};
const userCache = {}; // Separate aggressive cache for user data
const postCache = {}; // Global aggressive cache for post data

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

function getUserCached(userId) {
  const entry = userCache[userId];
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    delete userCache[userId];
    return null;
  }
  return entry.data;
}

function setUserCache(userId, data, ttlSeconds = 300) { // 5 minutes default for users
  userCache[userId] = {
    data,
    expires: Date.now() + ttlSeconds * 1000
  };
}

function getPostCached(postId) {
  const entry = postCache[postId];
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    delete postCache[postId];
    return null;
  }
  return entry.data;
}

function setPostCache(postId, data, ttlSeconds = 600) { // 10 minutes default for posts
  postCache[postId] = {
    data,
    expires: Date.now() + ttlSeconds * 1000
  };
}

// ===== User Data Sanitization =====
const SENSITIVE_USER_FIELDS = [
  'first_name',
  'last_name',
  'phone',
  'email',
  'password',
  'password_hash',
  'phone_number',
  'address',
  'date_of_birth',
  'birth_date',
  'ssn',
  'credit_card',
  'bank_account',
  'ip_address',
  'device_id'
];

function sanitizeUserData(userData, userId, authenticatedUserId) {
  if (!userData || Object.keys(userData).length === 0) return userData;

  // If viewing own profile, return all data
  if (userId === authenticatedUserId) {
    return userData;
  }

  // For other users, remove sensitive fields
  const sanitized = { ...userData };
  for (const field of SENSITIVE_USER_FIELDS) {
    delete sanitized[field];
  }

  return sanitized;
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
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const offset = parseInt(req.query.offset) || 0;
    let limit = parseInt(req.query.limit) || 20;
    const includeUser = req.query.includeUser !== 'false'; // default true

    // Validate and cap limit at 100
    if (limit > 100) limit = 100;

    const cacheKey = `explore_feed_${offset}_${limit}_${includeUser}`;

    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      console.log(`✅ [GET /feed/explore] CACHE HIT | Duration: ${duration}ms | Redis: 0 commands, 0 pipelines | includeUser: ${includeUser}`);
      cleanupRedisCounter(requestId);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] ${cacheKey}`);

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch a buffer of post IDs to account for missing posts/users
    const bufferMultiplier = 2;
    const bufferSize = limit * bufferMultiplier;
    let currentOffset = offset;
    let posts = [];

    // Continue fetching until we have enough posts or run out of items
    while (posts.length < limit) {
      const postIds = await trackedRedis.zrevrange(
        "explore:feed",
        currentOffset,
        currentOffset + bufferSize - 1
      );

      console.log(`Fetched ${postIds.length} post IDs from explore:feed at offset ${currentOffset}`);

      // No more posts available
      if (postIds.length === 0) break;

      // Aggregate posts with optional user data (no authenticated user for public explore feed)
      const aggregated = await aggregatePostsWithUsers(postIds, requestId, includeUser, null);
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

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [GET /feed/explore] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines | Total: ${counter.commands + counter.pipelines} roundtrips | includeUser: ${includeUser}`);
    cleanupRedisCounter(requestId);

    res.json(response);
  } catch (err) {
    console.error("Error fetching explore feed:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [GET /feed/explore] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
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
async function aggregatePostsWithUsers(postIds, requestId, includeUser = true, authenticatedUserId = null) {
  if (postIds.length === 0) return [];

  console.log(`[aggregatePostsWithUsers] Processing ${postIds.length} post IDs (includeUser: ${includeUser})`);

  const trackedRedis = createTrackedRedis(requestId);

  // First: Check post cache and collect uncached post IDs
  const uncachedPostIds = [];
  const postMap = {}; // Map of postId -> postData

  for (const postId of postIds) {
    const cachedPost = getPostCached(postId);
    if (cachedPost) {
      console.log(`[aggregatePostsWithUsers] Post cache HIT for ${postId}`);
      postMap[postId] = cachedPost;
    } else {
      uncachedPostIds.push(postId);
    }
  }

  console.log(`[aggregatePostsWithUsers] ${Object.keys(postMap).length} posts from cache, ${uncachedPostIds.length} posts to fetch`);

  // Second pipeline: Fetch only uncached posts
  if (uncachedPostIds.length > 0) {
    const postPipeline = trackedRedis.pipeline();
    for (const postId of uncachedPostIds) {
      postPipeline.hgetall(`post:${postId}`);
    }
    const postResults = await postPipeline.exec();

    // Process fetched posts and cache them
    for (let i = 0; i < uncachedPostIds.length; i++) {
      const postId = uncachedPostIds[i];
      const [err, postData] = postResults[i];

      if (err || !postData || Object.keys(postData).length === 0) {
        console.log(`[aggregatePostsWithUsers] Skipping post ${postId}: empty or error`);
        continue;
      }

      // Cache the post for 10 minutes
      setPostCache(postId, postData, 600);
      postMap[postId] = postData;
    }
  }

  // Build posts array in original order
  const posts = [];
  for (const postId of postIds) {
    const postData = postMap[postId];
    if (postData) {
      posts.push(postData);
    } else {
      posts.push(null);
    }
  }

  // Collect user_id values and build unique set, check cache first
  const userIds = new Set();
  const userMap = {};

  for (const postData of posts) {
    if (!postData) continue;

    // Only fetch users if includeUser is true
    if (includeUser && postData.user_id) {
      // Check user cache first
      const cachedUser = getUserCached(postData.user_id);
      if (cachedUser) {
        console.log(`[aggregatePostsWithUsers] Cache HIT for user ${postData.user_id}`);
        userMap[postData.user_id] = cachedUser;
      } else {
        userIds.add(postData.user_id);
      }
    }
  }

  console.log(`[aggregatePostsWithUsers] Found ${posts.filter(p => p).length} valid posts`);

  if (includeUser) {
    console.log(`[aggregatePostsWithUsers] ${Object.keys(userMap).length} users from cache, ${userIds.size} users to fetch`);

    // Second pipeline: Fetch uncached users
    if (userIds.size > 0) {
      const userPipeline = trackedRedis.pipeline();
      const userIdArray = Array.from(userIds);

      for (const userId of userIdArray) {
        userPipeline.hgetall(`user:${userId}`);
      }
      const userResults = await userPipeline.exec();

      // Build map of user_id -> userData and cache them
      for (let i = 0; i < userIdArray.length; i++) {
        const userId = userIdArray[i];
        const [, userData] = userResults[i];
        const userDataObj = userData || {};

        console.log(`[aggregatePostsWithUsers] Fetched user ${userId}:`, Object.keys(userDataObj).length > 0 ? Object.keys(userDataObj) : 'EMPTY');

        userMap[userId] = userDataObj;
        // Cache user data for 5 minutes (cache unsanitized data)
        setUserCache(userId, userDataObj, 300);
      }
    }
  }

  // Iterate original postIds order and push results
  const results = [];
  for (const postData of posts) {
    if (!postData) continue;

    if (includeUser) {
      // Include user data (sanitized if not own user)
      let userData = postData.user_id ? (userMap[postData.user_id] || {}) : {};

      // Sanitize user data based on authenticated user
      if (postData.user_id) {
        userData = sanitizeUserData(userData, postData.user_id, authenticatedUserId);
      }

      results.push({
        post: postData,
        user: userData
      });
    } else {
      // Only post data, no user
      results.push({
        post: postData
      });
    }
  }

  console.log(`[aggregatePostsWithUsers] Returning ${results.length} aggregated posts${includeUser ? ' with users' : ' (no users)'}`);
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
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const userId = req.user.user_id;
    const offset = parseInt(req.query.offset) || 0;
    let limit = parseInt(req.query.limit) || 20;
    const includeUser = req.query.includeUser !== 'false'; // default true

    // Validate and cap limit at 100
    if (limit > 100) limit = 100;

    const cacheKey = `following_feed_${userId}_${offset}_${limit}_${includeUser}`;

    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      console.log(`✅ [GET /feed/following] CACHE HIT | Duration: ${duration}ms | Redis: 0 commands, 0 pipelines | includeUser: ${includeUser}`);
      cleanupRedisCounter(requestId);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] ${cacheKey}`);

    const trackedRedis = createTrackedRedis(requestId);

    // Get list of users being followed
    const followingIds = await trackedRedis.smembers(`user:${userId}:following`);

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
      const duration = Date.now() - startTime;
      const counter = getRedisCounter(requestId);
      console.log(`✅ [GET /feed/following] Success (empty) | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines | Total: ${counter.commands + counter.pipelines} roundtrips | includeUser: ${includeUser}`);
      cleanupRedisCounter(requestId);
      return res.json(response);
    }

    // Build keys for user:{id}:posts sorted sets
    const userPostKeys = followingIds.map(id => `user:${id}:posts`);

    // Verify existence of user:{id}:posts keys by checking a sample
    const sampleKey = userPostKeys[0];
    const sampleExists = await trackedRedis.exists(sampleKey);

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
        const explorePosts = await trackedRedis.zrevrange("explore:feed", currentOffset, currentOffset + bufferSize - 1);

        console.log(`Fetched ${explorePosts.length} posts from explore:feed at offset ${currentOffset}`);

        // No more posts available
        if (explorePosts.length === 0) break;

        // Pipeline to get user_id for each post
        const pipeline = trackedRedis.pipeline();
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
          const aggregated = await aggregatePostsWithUsers(filteredPostIds, requestId, includeUser, userId);
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
      await trackedRedis.zunionstore(tmpKey, userPostKeys.length, ...userPostKeys);

      // Set short expiration (15 seconds)
      await trackedRedis.expire(tmpKey, 15);

      console.log(`Created temporary union set ${tmpKey}`);

      // Fetch a buffer to account for missing posts/users
      const bufferMultiplier = 2;
      const bufferSize = limit * bufferMultiplier;
      let currentOffset = offset;

      // Continue fetching until we have enough posts or run out of items
      while (posts.length < limit) {
        const fetchedIds = await trackedRedis.zrevrange(tmpKey, currentOffset, currentOffset + bufferSize - 1);

        console.log(`Fetched ${fetchedIds.length} post IDs from ${tmpKey} at offset ${currentOffset}`);

        // No more posts available
        if (fetchedIds.length === 0) break;

        // Aggregate posts with user data
        const aggregated = await aggregatePostsWithUsers(fetchedIds, requestId, includeUser, userId);
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

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [GET /feed/following] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines | Total: ${counter.commands + counter.pipelines} roundtrips | includeUser: ${includeUser}`);
    cleanupRedisCounter(requestId);

    res.json(response);
  } catch (err) {
    console.error("Error fetching following feed:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [GET /feed/following] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines | includeUser: ${includeUser}`);
    cleanupRedisCounter(requestId);
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
