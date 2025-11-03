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
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
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
  sismember: redis.sismember.bind(redis),
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
    sismember: wrapRedisCommand('sismember', originalRedis.sismember, requestId),
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

  // Removed auth header logging for security
  if (!authHeader) return res.status(401).json({ error: "Missing token" });

  const parts = String(authHeader).split(" ");
  const token =
    parts.length === 2 && parts[0].toLowerCase() === "bearer"
      ? parts[1]
      : String(authHeader);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Validate role field
    const role = decoded.role;
    const validRoles = ['admin', 'user', 'model'];
    if (!role || !validRoles.includes(role)) {
      return res.status(401).json({ error: "Invalid or missing role in token" });
    }

    // Assign validated role to req.user
    req.user = decoded;
    req.user.role = role;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
});

// ===== Helper: Extract hashtags from content =====
function extractHashtags(content) {
  if (!content) return [];
  const matches = content.match(/#(\w+)/g) || [];
  // Normalize: remove duplicates, lowercase
  const uniqueTags = [...new Set(matches.map(tag => tag.substring(1).toLowerCase()))];
  return uniqueTags;
}

// ===== Helper: Invalidate feed caches =====
function invalidateFeedCaches() {
  const feedPrefixes = [
    'explore_feed_',
    'following_feed_',
    'hashtag_feed_',
    'hashtag_ranked_',
    'bookmarked_',
    'search_users_newest_',
    'search_hashtags_top_',
    'search_models_top_'
  ];

  for (const key in cache) {
    for (const prefix of feedPrefixes) {
      if (key.startsWith(prefix)) {
        delete cache[key];
        break;
      }
    }
  }
}

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

  // Check interaction status (liked/bookmarked) if user is authenticated
  const interactionMap = {}; // Map of postId -> { isLiked, isBookmarked }

  if (authenticatedUserId) {
    const validPostIds = posts.filter(p => p).map(p => p.id);
    if (validPostIds.length > 0) {
      const interactionPipeline = trackedRedis.pipeline();

      for (const postId of validPostIds) {
        interactionPipeline.sismember(`post:${postId}:likes`, authenticatedUserId);
        interactionPipeline.sismember(`post:${postId}:bookmarks`, authenticatedUserId);
      }

      const interactionResults = await interactionPipeline.exec();

      for (let i = 0; i < validPostIds.length; i++) {
        const postId = validPostIds[i];
        const likeIndex = i * 2;
        const bookmarkIndex = i * 2 + 1;

        const [, isLiked] = interactionResults[likeIndex];
        const [, isBookmarked] = interactionResults[bookmarkIndex];

        // Redis SISMEMBER returns 1 if member exists, 0 if not
        const isLikedNum = parseInt(isLiked) || 0;
        const isBookmarkedNum = parseInt(isBookmarked) || 0;

        interactionMap[postId] = {
          isLiked: isLikedNum === 1,
          isBookmarked: isBookmarkedNum === 1
        };
      }
    }
  }

  // Iterate original postIds order and push results
  const results = [];
  for (const postData of posts) {
    if (!postData) continue;

    // Add interaction status to post data
    const postWithInteractions = {
      ...postData,
      isLiked: interactionMap[postData.id]?.isLiked || false,
      isBookmarked: interactionMap[postData.id]?.isBookmarked || false
    };

    if (includeUser) {
      // Include user data (sanitized if not own user)
      let userData = postData.user_id ? (userMap[postData.user_id] || {}) : {};

      // Sanitize user data based on authenticated user
      if (postData.user_id) {
        userData = sanitizeUserData(userData, postData.user_id, authenticatedUserId);
      }

      results.push({
        post: postWithInteractions,
        user: userData
      });
    } else {
      // Only post data, no user
      results.push({
        post: postWithInteractions
      });
    }
  }

  console.log(`[aggregatePostsWithUsers] Returning ${results.length} aggregated posts${includeUser ? ' with users' : ' (no users)'}${authenticatedUserId ? ' with interactions' : ''}`);
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

// ===== POST /redis/write: Write-enabled Redis proxy with AUTH placeholder =====
app.post("/redis/write", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const tokenUserId = req.user.user_id;
    const commands = req.body;

    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: "Request body must be a non-empty array of commands" });
    }

    // Whitelist of allowed write commands
    const allowedWriteCommands = ["HSET", "HDEL", "HINCRBY"];

    // Fields that cannot be modified directly (require PATCH /users/:id for denormalization)
    const blockedFields = [
      "username", "display_name", "avatar",  // Require denormalization to posts
      "role", "postCount", "followerCount", "followingCount"  // System-managed
    ];

    const results = [];

    for (let command of commands) {
      if (!Array.isArray(command) || command.length === 0) {
        results.push("ERR invalid command format");
        continue;
      }

      const [cmdRaw, ...args] = command;
      const cmd = cmdRaw.toUpperCase();

      // Check command whitelist
      if (!allowedWriteCommands.includes(cmd)) {
        results.push("ERR command not allowed in write mode");
        continue;
      }

      try {
        // Replace user:AUTH placeholders
        const argsProcessed = args.map((a) =>
          typeof a === "string" ? a.replace("user:AUTH", `user:${tokenUserId}`) : a
        );

        // Authorization check: validate key ownership
        if (argsProcessed.length > 0 && typeof argsProcessed[0] === "string") {
          const key = argsProcessed[0];

          // Check if key matches user:<id> or user:<id>:* pattern
          const userKeyMatch = key.match(/^user:([\w-]+)(?::.*)?$/);

          if (!userKeyMatch) {
            results.push("ERR invalid key format");
            continue;
          }

          const keyUserId = userKeyMatch[1];

          // Ensure user can only modify their own data
          if (keyUserId !== tokenUserId) {
            results.push("ERR forbidden: can only modify your own user data");
            continue;
          }
        }

        // Field restriction check for HSET and HDEL commands
        if (cmd === "HSET" && argsProcessed.length >= 2) {
          const fieldName = argsProcessed[1];
          if (blockedFields.includes(fieldName)) {
            results.push(`ERR field '${fieldName}' cannot be modified directly, use PATCH /users/:id`);
            continue;
          }
        }

        if (cmd === "HDEL") {
          // HDEL can have multiple fields: HDEL key field1 field2 ...
          const fieldsToDelete = argsProcessed.slice(1);
          const blockedFieldAttempt = fieldsToDelete.find(f => blockedFields.includes(f));
          if (blockedFieldAttempt) {
            results.push(`ERR field '${blockedFieldAttempt}' cannot be modified directly, use PATCH /users/:id`);
            continue;
          }
        }

        if (cmd === "HINCRBY" && argsProcessed.length >= 2) {
          const fieldName = argsProcessed[1];
          if (blockedFields.includes(fieldName)) {
            results.push(`ERR field '${fieldName}' cannot be modified directly, use PATCH /users/:id`);
            continue;
          }
        }

        // Console logging for debug
        console.log("=== Redis Write Request ===");
        console.log("JWT user_id:", req.user.user_id);
        console.log("Command:", cmdRaw);
        console.log("Original args:", args);
        console.log("Resolved args:", argsProcessed);

        // Execute Redis command
        const trackedRedis = createTrackedRedis(requestId);
        const result = await trackedRedis[cmd.toLowerCase()](...argsProcessed);

        console.log("Redis result:", result);
        console.log("===========================");

        // Cache invalidation after successful write
        delete userCache[tokenUserId];

        // Invalidate user profile cache for all viewers
        const profileCacheKeys = Object.keys(cache).filter(key =>
          key.startsWith(`user_profile_${tokenUserId}_`)
        );
        profileCacheKeys.forEach(key => delete cache[key]);

        // Invalidate feed caches (conservative approach)
        invalidateFeedCaches();

        results.push(result);
      } catch (err) {
        console.error("Redis write error:", err);
        results.push(`ERR ${err.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    logRequest("POST", "/redis/write", 200, elapsed, requestId);

    res.json({
      results: results,
      user_id: tokenUserId
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error("Redis write endpoint error:", err);
    logRequest("POST", "/redis/write", 500, elapsed, requestId);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===== POST /posts: Create a new post =====
app.post("/posts", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const userId = req.user.user_id;
    const { content, media_url } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: "Content is required" });
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch user data for denormalization
    const userData = await trackedRedis.hgetall(`user:${userId}`);

    if (!userData || Object.keys(userData).length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate post ID and timestamp
    const postId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const timestamp = Date.now();

    // Build post data with denormalized user info
    const postData = {
      id: postId,
      user_id: userId,
      username: userData.username || '',
      avatar: userData.avatar || '',
      display_name: userData.display_name || userData.username || '',
      user_role: userData.role || 'user',
      content: content.trim(),
      media_url: media_url || '',
      created_at: timestamp,
      likesCount: 0,
      commentsCount: 0,
      bookmarksCount: 0
    };

    // Extract hashtags from content using helper function
    const extractedHashtags = extractHashtags(content);

    // Use Redis transaction for atomicity
    const multi = redis.multi();

    // Store post hash
    multi.hset(`post:${postId}`, postData);

    // Add to explore feed
    multi.zadd('explore:feed', timestamp, postId);

    // Add to user's posts
    multi.zadd(`user:${userId}:posts`, timestamp, postId);

    // Add to hashtag feeds using extracted hashtags from content
    for (const hashtagId of extractedHashtags) {
      multi.zadd(`hashtag:${hashtagId}:posts`, timestamp, postId);
      // Initialize ranked feed with score 0
      multi.zadd(`hashtag:${hashtagId}:ranked`, 0, postId);
    }

    // Increment user's post count
    multi.hincrby(`user:${userId}`, 'postCount', 1);

    await multi.exec();

    // Invalidate relevant caches
    delete cache[`user_profile_${userId}_${userId}`];
    invalidateFeedCaches();

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [POST /posts] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.status(201).json({ post: postData });
  } catch (err) {
    console.error("Error creating post:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [POST /posts] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to create post" });
  }
});

// ===== DELETE /posts/:id: Delete a post =====
app.delete("/posts/:id", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const postId = req.params.id;
    const userId = req.user.user_id;
    const userRole = req.user.role;

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch post data
    const postData = await trackedRedis.hgetall(`post:${postId}`);

    if (!postData || Object.keys(postData).length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check authorization (owner or admin)
    if (postData.user_id !== userId && userRole !== 'admin') {
      return res.status(403).json({ error: "Not authorized to delete this post" });
    }

    // Get hashtags from post content (simple regex match)
    const hashtagMatches = postData.content.match(/#(\w+)/g) || [];
    const hashtags = hashtagMatches.map(tag => tag.substring(1));

    // Get all users who bookmarked this post to remove from their user:*:bookmarked
    const bookmarkedBy = await trackedRedis.smembers(`post:${postId}:bookmarks`);

    // Use Redis transaction for atomicity
    const multi = redis.multi();

    // Remove from explore feed
    multi.zrem('explore:feed', postId);

    // Remove from user's posts
    multi.zrem(`user:${postData.user_id}:posts`, postId);

    // Remove from hashtag feeds
    for (const hashtagId of hashtags) {
      multi.zrem(`hashtag:${hashtagId}:posts`, postId);
      multi.zrem(`hashtag:${hashtagId}:ranked`, postId);
    }

    // Remove post from each user's bookmarked list
    for (const bookmarkUserId of bookmarkedBy) {
      multi.zrem(`user:${bookmarkUserId}:bookmarked`, postId);
    }

    // Delete interaction sets
    multi.del(`post:${postId}:likes`);
    multi.del(`post:${postId}:bookmarks`);
    multi.del(`post:${postId}:comments`);

    // Delete post hash
    multi.del(`post:${postId}`);

    // Decrement user's post count
    multi.hincrby(`user:${postData.user_id}`, 'postCount', -1);

    await multi.exec();

    // Invalidate post cache
    delete postCache[postId];
    invalidateFeedCaches();

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [DELETE /posts/:id] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json({ message: "Post deleted successfully" });
  } catch (err) {
    console.error("Error deleting post:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [DELETE /posts/:id] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// ===== PATCH /posts/:id/ban: Ban a post (admin only) =====
app.patch("/posts/:id/ban", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const postId = req.params.id;
    const userRole = req.user.role;

    // Only allow admins to ban posts
    if (userRole !== 'admin') {
      return res.status(403).json({ error: "Only admins can ban posts" });
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch post data
    const postData = await trackedRedis.hgetall(`post:${postId}`);

    if (!postData || Object.keys(postData).length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    console.log(`[PATCH /posts/:id/ban] Admin banning post ${postId}`);

    // Get all users who bookmarked this post to remove from their user:*:bookmarked
    const bookmarkedBy = await trackedRedis.smembers(`post:${postId}:bookmarks`);

    // Add banned flag for audit trail
    await redis.hset(`post:${postId}`, 'banned', 'true');
    await redis.hset(`post:${postId}`, 'banned_at', Date.now().toString());
    await redis.hset(`post:${postId}`, 'banned_by', req.user.user_id);

    // Get hashtags from post content
    const hashtagMatches = postData.content.match(/#(\w+)/g) || [];
    const hashtags = hashtagMatches.map(tag => tag.substring(1));

    // Use Redis transaction for atomicity
    const multi = redis.multi();

    // Remove from explore feed
    multi.zrem('explore:feed', postId);

    // Remove from user's posts
    multi.zrem(`user:${postData.user_id}:posts`, postId);

    // Remove from hashtag feeds
    for (const hashtagId of hashtags) {
      multi.zrem(`hashtag:${hashtagId}:posts`, postId);
      multi.zrem(`hashtag:${hashtagId}:ranked`, postId);
    }

    // Remove post from each user's bookmarked list
    for (const bookmarkUserId of bookmarkedBy) {
      multi.zrem(`user:${bookmarkUserId}:bookmarked`, postId);
    }

    // Delete interaction sets (post remains for audit but interactions are removed)
    multi.del(`post:${postId}:likes`);
    multi.del(`post:${postId}:bookmarks`);
    multi.del(`post:${postId}:comments`);

    // Decrement user's post count
    multi.hincrby(`user:${postData.user_id}`, 'postCount', -1);

    await multi.exec();

    // Invalidate post cache
    delete postCache[postId];
    invalidateFeedCaches();

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [PATCH /posts/:id/ban] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json({ message: "Post banned successfully", postId });
  } catch (err) {
    console.error("Error banning post:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [PATCH /posts/:id/ban] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to ban post" });
  }
});

// ===== POST /posts/:id/like: Like a post =====
app.post("/posts/:id/like", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const postId = req.params.id;
    const userId = req.user.user_id;

    const trackedRedis = createTrackedRedis(requestId);

    // Check if post exists
    const postExists = await trackedRedis.exists(`post:${postId}`);
    if (postExists === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if already liked
    const alreadyLiked = await trackedRedis.sismember(`post:${postId}:likes`, userId);
    if (alreadyLiked) {
      return res.status(400).json({ error: "Post already liked" });
    }

    // Get post data for ranking updates
    const postData = await trackedRedis.hgetall(`post:${postId}`);

    // Use Redis transaction
    const multi = redis.multi();

    // Add user to likes set
    multi.sadd(`post:${postId}:likes`, userId);

    // Increment likes count
    multi.hincrby(`post:${postId}`, 'likesCount', 1);

    // Update ranked feeds if post has hashtags
    const hashtags = extractHashtags(postData.content);
    if (hashtags.length > 0) {
      const currentTime = Date.now();
      const createdAt = parseInt(postData.created_at);
      const likesCount = parseInt(postData.likesCount || 0) + 1;
      const commentsCount = parseInt(postData.commentsCount || 0);
      const bookmarksCount = parseInt(postData.bookmarksCount || 0);

      // Calculate time-decayed score
      const engagementScore = (likesCount * 3 + commentsCount * 5 + bookmarksCount * 4);
      const ageInHours = (currentTime - createdAt) / 3600000;
      const score = engagementScore / (ageInHours + 1);

      // Check if post is older than 2 weeks
      const twoWeeksInMs = 14 * 24 * 3600 * 1000;
      const finalScore = (currentTime - createdAt) > twoWeeksInMs ? 0 : score;

      for (const tag of hashtags) {
        multi.zadd(`hashtag:${tag}:ranked`, finalScore, postId);
      }
    }

    // Update models:top:engagement if post owner is a model
    const authorRole = postData.user_role || await trackedRedis.hget(`user:${postData.user_id}`, 'role');
    if (authorRole === 'model') {
      multi.zincrby('models:top:engagement', 1, postData.user_id);
    }

    await multi.exec();

    // Invalidate post cache
    delete postCache[postId];
    invalidateFeedCaches();

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [POST /posts/:id/like] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json({ message: "Post liked successfully" });
  } catch (err) {
    console.error("Error liking post:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [POST /posts/:id/like] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to like post" });
  }
});

// ===== DELETE /posts/:id/like: Unlike a post =====
app.delete("/posts/:id/like", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const postId = req.params.id;
    const userId = req.user.user_id;

    const trackedRedis = createTrackedRedis(requestId);

    // Check if post exists
    const postExists = await trackedRedis.exists(`post:${postId}`);
    if (postExists === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if liked
    const isLiked = await trackedRedis.sismember(`post:${postId}:likes`, userId);
    if (!isLiked) {
      return res.status(400).json({ error: "Post not liked" });
    }

    // Get post data for ranking updates
    const postData = await trackedRedis.hgetall(`post:${postId}`);

    // Use Redis transaction
    const multi = redis.multi();

    // Remove user from likes set
    multi.srem(`post:${postId}:likes`, userId);

    // Decrement likes count
    multi.hincrby(`post:${postId}`, 'likesCount', -1);

    // Update ranked feeds if post has hashtags
    const hashtags = extractHashtags(postData.content);
    if (hashtags.length > 0) {
      const currentTime = Date.now();
      const createdAt = parseInt(postData.created_at);
      const likesCount = Math.max(0, parseInt(postData.likesCount || 0) - 1);
      const commentsCount = parseInt(postData.commentsCount || 0);
      const bookmarksCount = parseInt(postData.bookmarksCount || 0);

      const engagementScore = (likesCount * 3 + commentsCount * 5 + bookmarksCount * 4);
      const ageInHours = (currentTime - createdAt) / 3600000;
      const score = engagementScore / (ageInHours + 1);

      const twoWeeksInMs = 14 * 24 * 3600 * 1000;
      const finalScore = (currentTime - createdAt) > twoWeeksInMs ? 0 : score;

      for (const tag of hashtags) {
        multi.zadd(`hashtag:${tag}:ranked`, finalScore, postId);
      }
    }

    // Update models:top:engagement if post owner is a model
    const authorRole = postData.user_role || await trackedRedis.hget(`user:${postData.user_id}`, 'role');
    if (authorRole === 'model') {
      multi.zincrby('models:top:engagement', -1, postData.user_id);
    }

    await multi.exec();

    // Invalidate post cache
    delete postCache[postId];
    invalidateFeedCaches();

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [DELETE /posts/:id/like] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json({ message: "Post unliked successfully" });
  } catch (err) {
    console.error("Error unliking post:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [DELETE /posts/:id/like] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to unlike post" });
  }
});

// ===== POST /posts/:id/bookmark: Bookmark a post =====
app.post("/posts/:id/bookmark", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const postId = req.params.id;
    const userId = req.user.user_id;

    const trackedRedis = createTrackedRedis(requestId);

    // Check if post exists
    const postExists = await trackedRedis.exists(`post:${postId}`);
    if (postExists === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if already bookmarked
    const alreadyBookmarked = await trackedRedis.sismember(`post:${postId}:bookmarks`, userId);
    if (alreadyBookmarked) {
      return res.status(400).json({ error: "Post already bookmarked" });
    }

    // Get post data for ranking updates
    const postData = await trackedRedis.hgetall(`post:${postId}`);
    const timestamp = Date.now();

    // Use Redis transaction
    const multi = redis.multi();

    // Add user to bookmarks set
    multi.sadd(`post:${postId}:bookmarks`, userId);

    // Add to user's bookmarked sorted set
    multi.zadd(`user:${userId}:bookmarked`, timestamp, postId);

    // Increment bookmarks count
    multi.hincrby(`post:${postId}`, 'bookmarksCount', 1);

    // Update ranked feeds if post has hashtags
    const hashtags = extractHashtags(postData.content);
    if (hashtags.length > 0) {
      const currentTime = Date.now();
      const createdAt = parseInt(postData.created_at);
      const likesCount = parseInt(postData.likesCount || 0);
      const commentsCount = parseInt(postData.commentsCount || 0);
      const bookmarksCount = parseInt(postData.bookmarksCount || 0) + 1;

      const engagementScore = (likesCount * 3 + commentsCount * 5 + bookmarksCount * 4);
      const ageInHours = (currentTime - createdAt) / 3600000;
      const score = engagementScore / (ageInHours + 1);

      const twoWeeksInMs = 14 * 24 * 3600 * 1000;
      const finalScore = (currentTime - createdAt) > twoWeeksInMs ? 0 : score;

      for (const tag of hashtags) {
        multi.zadd(`hashtag:${tag}:ranked`, finalScore, postId);
      }
    }

    // Update models:top:engagement if post owner is a model
    const authorRole = postData.user_role || await trackedRedis.hget(`user:${postData.user_id}`, 'role');
    if (authorRole === 'model') {
      multi.zincrby('models:top:engagement', 1, postData.user_id);
    }

    await multi.exec();

    // Invalidate post cache
    delete postCache[postId];
    invalidateFeedCaches();

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [POST /posts/:id/bookmark] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json({ message: "Post bookmarked successfully" });
  } catch (err) {
    console.error("Error bookmarking post:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [POST /posts/:id/bookmark] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to bookmark post" });
  }
});

// ===== DELETE /posts/:id/bookmark: Remove bookmark from a post =====
app.delete("/posts/:id/bookmark", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const postId = req.params.id;
    const userId = req.user.user_id;

    const trackedRedis = createTrackedRedis(requestId);

    // Check if post exists
    const postExists = await trackedRedis.exists(`post:${postId}`);
    if (postExists === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if bookmarked
    const isBookmarked = await trackedRedis.sismember(`post:${postId}:bookmarks`, userId);
    if (!isBookmarked) {
      return res.status(400).json({ error: "Post not bookmarked" });
    }

    // Get post data for ranking updates
    const postData = await trackedRedis.hgetall(`post:${postId}`);

    // Use Redis transaction
    const multi = redis.multi();

    // Remove user from bookmarks set
    multi.srem(`post:${postId}:bookmarks`, userId);

    // Remove from user's bookmarked sorted set
    multi.zrem(`user:${userId}:bookmarked`, postId);

    // Decrement bookmarks count
    multi.hincrby(`post:${postId}`, 'bookmarksCount', -1);

    // Update ranked feeds if post has hashtags
    const hashtags = extractHashtags(postData.content);
    if (hashtags.length > 0) {
      const currentTime = Date.now();
      const createdAt = parseInt(postData.created_at);
      const likesCount = parseInt(postData.likesCount || 0);
      const commentsCount = parseInt(postData.commentsCount || 0);
      const bookmarksCount = Math.max(0, parseInt(postData.bookmarksCount || 0) - 1);

      const engagementScore = (likesCount * 3 + commentsCount * 5 + bookmarksCount * 4);
      const ageInHours = (currentTime - createdAt) / 3600000;
      const score = engagementScore / (ageInHours + 1);

      const twoWeeksInMs = 14 * 24 * 3600 * 1000;
      const finalScore = (currentTime - createdAt) > twoWeeksInMs ? 0 : score;

      for (const tag of hashtags) {
        multi.zadd(`hashtag:${tag}:ranked`, finalScore, postId);
      }
    }

    // Update models:top:engagement if post owner is a model
    const authorRole = postData.user_role || await trackedRedis.hget(`user:${postData.user_id}`, 'role');
    if (authorRole === 'model') {
      multi.zincrby('models:top:engagement', -1, postData.user_id);
    }

    await multi.exec();

    // Invalidate post cache
    delete postCache[postId];
    invalidateFeedCaches();

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [DELETE /posts/:id/bookmark] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json({ message: "Bookmark removed successfully" });
  } catch (err) {
    console.error("Error removing bookmark:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [DELETE /posts/:id/bookmark] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to remove bookmark" });
  }
});

// ===== GET /users/:id/bookmarked: Get user's bookmarked posts =====
app.get("/users/:id/bookmarked", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const userId = req.params.id;
    const authenticatedUserId = req.user.user_id;

    // Only allow users to view their own bookmarks
    if (userId !== authenticatedUserId) {
      return res.status(403).json({ error: "Not authorized to view bookmarks" });
    }

    const offset = parseInt(req.query.offset) || 0;
    let limit = parseInt(req.query.limit) || 20;
    const includeUser = req.query.includeUser !== 'false';

    if (limit > 100) limit = 100;

    const cacheKey = `bookmarked_${userId}_${offset}_${limit}_${includeUser}`;

    const cached = getCached(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      console.log(`✅ [GET /users/:id/bookmarked] CACHE HIT | Duration: ${duration}ms | Redis: 0 commands, 0 pipelines`);
      cleanupRedisCounter(requestId);
      return res.json(cached);
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch bookmarked posts with pagination
    const bufferMultiplier = 2;
    const bufferSize = limit * bufferMultiplier;
    let currentOffset = offset;
    let posts = [];

    while (posts.length < limit) {
      const postIds = await trackedRedis.zrevrange(
        `user:${userId}:bookmarked`,
        currentOffset,
        currentOffset + bufferSize - 1
      );

      if (postIds.length === 0) break;

      const aggregated = await aggregatePostsWithUsers(postIds, requestId, includeUser, authenticatedUserId);
      posts.push(...aggregated);

      if (posts.length >= limit) {
        posts = posts.slice(0, limit);
        break;
      }

      currentOffset += postIds.length;
    }

    const response = {
      posts,
      pagination: {
        offset,
        limit,
        count: posts.length
      }
    };

    setCache(cacheKey, response, 30);

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [GET /users/:id/bookmarked] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json(response);
  } catch (err) {
    console.error("Error fetching bookmarked posts:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [GET /users/:id/bookmarked] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to fetch bookmarked posts" });
  }
});

// ===== POST /users/:id/follow: Follow a user =====
app.post("/users/:id/follow", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const targetUserId = req.params.id;
    const userId = req.user.user_id;

    if (targetUserId === userId) {
      return res.status(400).json({ error: "Cannot follow yourself" });
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Check if target user exists
    const targetUserExists = await trackedRedis.exists(`user:${targetUserId}`);
    if (targetUserExists === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if already following
    const alreadyFollowing = await trackedRedis.sismember(`user:${userId}:following`, targetUserId);
    if (alreadyFollowing) {
      return res.status(400).json({ error: "Already following this user" });
    }

    // Use Redis transaction
    const multi = redis.multi();

    // Add to following set
    multi.sadd(`user:${userId}:following`, targetUserId);

    // Add to target's followers set
    multi.sadd(`user:${targetUserId}:followers`, userId);

    // Increment counts
    multi.hincrby(`user:${userId}`, 'followingCount', 1);
    multi.hincrby(`user:${targetUserId}`, 'followerCount', 1);

    await multi.exec();

    // Invalidate relevant caches
    delete cache[`user_profile_${userId}_${userId}`];
    delete cache[`user_profile_${targetUserId}_${targetUserId}`];
    delete userCache[userId];
    delete userCache[targetUserId];
    invalidateFeedCaches();

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [POST /users/:id/follow] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json({ message: "User followed successfully" });
  } catch (err) {
    console.error("Error following user:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [POST /users/:id/follow] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to follow user" });
  }
});

// ===== DELETE /users/:id/follow: Unfollow a user =====
app.delete("/users/:id/follow", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const targetUserId = req.params.id;
    const userId = req.user.user_id;

    if (targetUserId === userId) {
      return res.status(400).json({ error: "Cannot unfollow yourself" });
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Check if following
    const isFollowing = await trackedRedis.sismember(`user:${userId}:following`, targetUserId);
    if (!isFollowing) {
      return res.status(400).json({ error: "Not following this user" });
    }

    // Use Redis transaction
    const multi = redis.multi();

    // Remove from following set
    multi.srem(`user:${userId}:following`, targetUserId);

    // Remove from target's followers set
    multi.srem(`user:${targetUserId}:followers`, userId);

    // Decrement counts
    multi.hincrby(`user:${userId}`, 'followingCount', -1);
    multi.hincrby(`user:${targetUserId}`, 'followerCount', -1);

    await multi.exec();

    // Invalidate relevant caches
    delete cache[`user_profile_${userId}_${userId}`];
    delete cache[`user_profile_${targetUserId}_${targetUserId}`];
    delete userCache[userId];
    delete userCache[targetUserId];
    invalidateFeedCaches();

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [DELETE /users/:id/follow] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json({ message: "User unfollowed successfully" });
  } catch (err) {
    console.error("Error unfollowing user:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [DELETE /users/:id/follow] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to unfollow user" });
  }
});

// ===== PATCH /users/:id: Update user profile =====
app.patch("/users/:id", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const userId = req.params.id;
    const authenticatedUserId = req.user.user_id;

    // Only allow users to update their own profile
    if (userId !== authenticatedUserId) {
      return res.status(403).json({ error: "Not authorized to update this profile" });
    }

    const { username, display_name, bio, avatar, links } = req.body;

    const trackedRedis = createTrackedRedis(requestId);

    // Get current user data
    const currentUserData = await trackedRedis.hgetall(`user:${userId}`);

    if (!currentUserData || Object.keys(currentUserData).length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const oldUsername = currentUserData.username;
    const usernameChanged = username && username !== oldUsername;

    // Build update object
    const updates = {};
    if (username !== undefined) updates.username = username;
    if (display_name !== undefined) updates.display_name = display_name;
    if (bio !== undefined) updates.bio = bio;
    if (avatar !== undefined) updates.avatar = avatar;
    if (links !== undefined) updates.links = links;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // Use Redis transaction
    const multi = redis.multi();

    // Update user hash
    for (const [key, value] of Object.entries(updates)) {
      multi.hset(`user:${userId}`, key, value);
    }

    // If username changed, need to denormalize to all posts
    if (usernameChanged) {
      // Get all user's posts
      const postIds = await trackedRedis.zrevrange(`user:${userId}:posts`, 0, -1);

      console.log(`Username changed from ${oldUsername} to ${username}. Updating ${postIds.length} posts.`);

      // Update denormalized username in all posts
      for (const postId of postIds) {
        multi.hset(`post:${postId}`, 'username', username);
        if (display_name) {
          multi.hset(`post:${postId}`, 'display_name', display_name);
        }
        // Invalidate post cache
        delete postCache[postId];
      }
    }

    // If avatar changed, update all posts
    if (avatar !== undefined) {
      const postIds = await trackedRedis.zrevrange(`user:${userId}:posts`, 0, -1);
      for (const postId of postIds) {
        multi.hset(`post:${postId}`, 'avatar', avatar);
        delete postCache[postId];
      }
    }

    // If display_name changed, update all posts
    if (display_name !== undefined) {
      const postIds = await trackedRedis.zrevrange(`user:${userId}:posts`, 0, -1);
      for (const postId of postIds) {
        multi.hset(`post:${postId}`, 'display_name', display_name);
        delete postCache[postId];
      }
    }

    await multi.exec();

    // Invalidate user cache
    delete userCache[userId];
    invalidateFeedCaches();
    for (const key in cache) {
      if (key.includes(`user_profile_${userId}`)) {
        delete cache[key];
      }
    }

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [PATCH /users/:id] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json({ message: "Profile updated successfully", updates });
  } catch (err) {
    console.error("Error updating profile:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [PATCH /users/:id] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// ===== DELETE /users/:id: Delete user account with cascading cleanup =====
app.delete("/users/:id", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const userId = req.params.id;
    const authenticatedUserId = req.user.user_id;
    const userRole = req.user.role;

    // Only allow self-deletion or admin deletion
    if (userId !== authenticatedUserId && userRole !== 'admin') {
      return res.status(403).json({ error: "Not authorized to delete this user" });
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Get user data
    const userData = await trackedRedis.hgetall(`user:${userId}`);

    if (!userData || Object.keys(userData).length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    console.log(`[DELETE /users/:id] Starting deletion for user ${userId}`);

    // Get all user's posts
    const userPostIds = await trackedRedis.zrevrange(`user:${userId}:posts`, 0, -1);
    console.log(`[DELETE /users/:id] Found ${userPostIds.length} posts to delete`);

    // Delete each post (reuse post deletion logic)
    for (const postId of userPostIds) {
      const postData = await trackedRedis.hgetall(`post:${postId}`);
      if (postData && Object.keys(postData).length > 0) {
        const hashtagMatches = postData.content.match(/#(\w+)/g) || [];
        const hashtags = hashtagMatches.map(tag => tag.substring(1));

        const multi = redis.multi();

        // Remove from feeds
        multi.zrem('explore:feed', postId);
        multi.zrem(`user:${userId}:posts`, postId);

        for (const hashtagId of hashtags) {
          multi.zrem(`hashtag:${hashtagId}:posts`, postId);
          multi.zrem(`hashtag:${hashtagId}:ranked`, postId);
        }

        // Delete interaction sets and post
        multi.del(`post:${postId}:likes`);
        multi.del(`post:${postId}:bookmarks`);
        multi.del(`post:${postId}:comments`);
        multi.del(`post:${postId}`);

        await multi.exec();

        // Invalidate post cache
        delete postCache[postId];
      }
    }

    // Get all liked posts and remove user from likes sets
    const explorePosts = await trackedRedis.zrevrange('explore:feed', 0, 999);
    console.log(`[DELETE /users/:id] Checking ${explorePosts.length} posts for user interactions`);

    const cleanupMulti = redis.multi();

    // Check which posts the user actually liked to decrement likesCount
    const likeCheckPipeline = trackedRedis.pipeline();
    for (const postId of explorePosts) {
      likeCheckPipeline.sismember(`post:${postId}:likes`, userId);
    }
    const likeCheckResults = await likeCheckPipeline.exec();

    for (let i = 0; i < explorePosts.length; i++) {
      const postId = explorePosts[i];
      const [err, wasLiked] = likeCheckResults[i];

      if (!err && wasLiked === 1) {
        cleanupMulti.hincrby(`post:${postId}`, 'likesCount', -1);
      }

      cleanupMulti.srem(`post:${postId}:likes`, userId);
      cleanupMulti.srem(`post:${postId}:bookmarks`, userId);
    }

    // Get bookmarked posts for cleanup
    const bookmarkedPosts = await trackedRedis.zrevrange(`user:${userId}:bookmarked`, 0, -1);
    for (const postId of bookmarkedPosts) {
      cleanupMulti.hincrby(`post:${postId}`, 'bookmarksCount', -1);
    }

    // Delete all user keys
    cleanupMulti.del(`user:${userId}`);
    cleanupMulti.del(`user:${userId}:posts`);
    cleanupMulti.del(`user:${userId}:bookmarked`);
    cleanupMulti.del(`user:${userId}:following`);
    cleanupMulti.del(`user:${userId}:followers`);

    // Remove from role-based sorted sets
    const role = userData.role || 'user';
    if (role === 'model') {
      cleanupMulti.zrem('users:models', userId);
      cleanupMulti.zrem('models:top:engagement', userId);
    } else {
      cleanupMulti.zrem('users:regular', userId);
    }

    await cleanupMulti.exec();

    // Invalidate all caches
    delete userCache[userId];
    invalidateFeedCaches();
    for (const key in cache) {
      if (key.includes(userId)) {
        delete cache[key];
      }
    }

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [DELETE /users/:id] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines | Deleted ${userPostIds.length} posts`);
    cleanupRedisCounter(requestId);

    res.json({ message: "User deleted successfully", postsDeleted: userPostIds.length });
  } catch (err) {
    console.error("Error deleting user:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [DELETE /users/:id] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ===== GET /users/:id: Get user profile with privacy controls =====
app.get("/users/:id", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const userId = req.params.id;
    const authenticatedUserId = req.user.user_id;

    // Build viewer-specific cache key
    const cacheKey = `user_profile_${userId}_${authenticatedUserId}`;

    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      console.log(`✅ [GET /users/:id] CACHE HIT | Duration: ${duration}ms | Redis: 0 commands, 0 pipelines`);
      cleanupRedisCounter(requestId);
      return res.json(cached);
    }

    console.log(`[CACHE MISS] ${cacheKey}`);

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch user data from Redis
    const userData = await trackedRedis.hgetall(`user:${userId}`);

    if (!userData || Object.keys(userData).length === 0) {
      const duration = Date.now() - startTime;
      const counter = getRedisCounter(requestId);
      console.log(`❌ [GET /users/:id] User not found | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
      cleanupRedisCounter(requestId);
      return res.status(404).json({ error: "User not found" });
    }

    // Apply privacy controls
    const sanitized = sanitizeUserData(userData, userId, authenticatedUserId);

    const response = { user: sanitized };

    // Cache the sanitized data for ~300s
    setCache(cacheKey, response, 300);

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [GET /users/:id] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines | Total: ${counter.commands + counter.pipelines} roundtrips`);
    cleanupRedisCounter(requestId);

    res.json(response);
  } catch (err) {
    console.error("Error fetching user profile:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [GET /users/:id] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

// ===== GET /feed/hashtag/:id: Hashtag feed with chronological order =====
app.get("/feed/hashtag/:id", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const hashtagId = req.params.id;
    const offset = parseInt(req.query.offset) || 0;
    let limit = parseInt(req.query.limit) || 20;
    const includeUser = req.query.includeUser !== 'false';

    if (limit > 100) limit = 100;

    const cacheKey = `hashtag_feed_${hashtagId}_${offset}_${limit}_${includeUser}`;

    const cached = getCached(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      console.log(`✅ [GET /feed/hashtag/:id] CACHE HIT | Duration: ${duration}ms | Redis: 0 commands, 0 pipelines`);
      cleanupRedisCounter(requestId);
      return res.json(cached);
    }

    const trackedRedis = createTrackedRedis(requestId);

    const bufferMultiplier = 2;
    const bufferSize = limit * bufferMultiplier;
    let currentOffset = offset;
    let posts = [];

    while (posts.length < limit) {
      const postIds = await trackedRedis.zrevrange(
        `hashtag:${hashtagId}:posts`,
        currentOffset,
        currentOffset + bufferSize - 1
      );

      if (postIds.length === 0) break;

      const authenticatedUserId = req.user ? req.user.user_id : null;
      const aggregated = await aggregatePostsWithUsers(postIds, requestId, includeUser, authenticatedUserId);
      posts.push(...aggregated);

      if (posts.length >= limit) {
        posts = posts.slice(0, limit);
        break;
      }

      currentOffset += postIds.length;
    }

    const response = {
      posts,
      pagination: {
        offset,
        limit,
        count: posts.length
      }
    };

    setCache(cacheKey, response, 30);

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [GET /feed/hashtag/:id] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json(response);
  } catch (err) {
    console.error("Error fetching hashtag feed:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [GET /feed/hashtag/:id] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to fetch hashtag feed" });
  }
});

// ===== GET /feed/hashtag/:id/ranked: Hashtag feed with time-decayed ranking =====
app.get("/feed/hashtag/:id/ranked", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const hashtagId = req.params.id;
    const offset = parseInt(req.query.offset) || 0;
    let limit = parseInt(req.query.limit) || 20;
    const includeUser = req.query.includeUser !== 'false';

    if (limit > 100) limit = 100;

    const cacheKey = `hashtag_ranked_${hashtagId}_${offset}_${limit}_${includeUser}`;

    const cached = getCached(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      console.log(`✅ [GET /feed/hashtag/:id/ranked] CACHE HIT | Duration: ${duration}ms | Redis: 0 commands, 0 pipelines`);
      cleanupRedisCounter(requestId);
      return res.json(cached);
    }

    const trackedRedis = createTrackedRedis(requestId);

    const bufferMultiplier = 2;
    const bufferSize = limit * bufferMultiplier;
    let currentOffset = offset;
    let posts = [];

    while (posts.length < limit) {
      // Fetch posts sorted by engagement score (descending)
      const postIds = await trackedRedis.zrevrange(
        `hashtag:${hashtagId}:ranked`,
        currentOffset,
        currentOffset + bufferSize - 1
      );

      if (postIds.length === 0) break;

      const authenticatedUserId = req.user ? req.user.user_id : null;
      const aggregated = await aggregatePostsWithUsers(postIds, requestId, includeUser, authenticatedUserId);
      posts.push(...aggregated);

      if (posts.length >= limit) {
        posts = posts.slice(0, limit);
        break;
      }

      currentOffset += postIds.length;
    }

    const response = {
      posts,
      pagination: {
        offset,
        limit,
        count: posts.length
      }
    };

    setCache(cacheKey, response, 30);

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [GET /feed/hashtag/:id/ranked] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json(response);
  } catch (err) {
    console.error("Error fetching ranked hashtag feed:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [GET /feed/hashtag/:id/ranked] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to fetch ranked hashtag feed" });
  }
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

        // Safety limit to prevent infinite loops (reduced for performance)
        if (currentOffset > 3000) break;
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

// ===== GET /search/users/newest: Get newest users by role =====
app.get("/search/users/newest", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const role = req.query.role || 'user';
    let limit = parseInt(req.query.limit) || 10;

    if (limit > 100) limit = 100;

    const validRoles = ['user', 'model'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: "Invalid role. Must be 'user' or 'model'" });
    }

    const cacheKey = `search_users_newest_${role}_${limit}`;

    const cached = getCached(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      console.log(`✅ [GET /search/users/newest] CACHE HIT | Duration: ${duration}ms | Redis: 0 commands, 0 pipelines`);
      cleanupRedisCounter(requestId);
      return res.json(cached);
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch from sorted set (score = timestamp)
    const setKey = role === 'model' ? 'users:models' : 'users:regular';
    const userIds = await trackedRedis.zrevrange(setKey, 0, limit - 1);

    // Fetch user data
    const users = [];
    if (userIds.length > 0) {
      const pipeline = trackedRedis.pipeline();
      for (const userId of userIds) {
        pipeline.hgetall(`user:${userId}`);
      }
      const results = await pipeline.exec();

      for (let i = 0; i < userIds.length; i++) {
        const [, userData] = results[i];
        if (userData && Object.keys(userData).length > 0) {
          // Sanitize user data for public search
          const sanitized = sanitizeUserData(userData, userIds[i], null);
          users.push(sanitized);
        }
      }
    }

    const response = { users, count: users.length };

    setCache(cacheKey, response, 60);

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [GET /search/users/newest] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json(response);
  } catch (err) {
    console.error("Error searching users:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [GET /search/users/newest] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to search users" });
  }
});

// ===== GET /search/hashtags/top-posts: Get top posts from multiple hashtags =====
app.get("/search/hashtags/top-posts", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const hashtagIds = req.query.hashtags ? req.query.hashtags.split(',') : [];
    let postsPerHashtag = parseInt(req.query.postsPerHashtag) || 5;

    // Validate postsPerHashtag (limit to reasonable range)
    if (postsPerHashtag > 50) postsPerHashtag = 50;
    if (postsPerHashtag < 1) postsPerHashtag = 1;

    if (hashtagIds.length === 0) {
      return res.status(400).json({ error: "Provide hashtags query parameter (comma-separated)" });
    }

    if (hashtagIds.length > 12) {
      return res.status(400).json({ error: "Maximum 12 hashtags allowed" });
    }

    const cacheKey = `search_hashtags_top_${hashtagIds.join('_')}_${postsPerHashtag}`;

    const cached = getCached(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      console.log(`✅ [GET /search/hashtags/top-posts] CACHE HIT | Duration: ${duration}ms | Redis: 0 commands, 0 pipelines`);
      cleanupRedisCounter(requestId);
      return res.json(cached);
    }

    const trackedRedis = createTrackedRedis(requestId);
    const authenticatedUserId = req.user ? req.user.user_id : null;

    const hashtagResults = {};

    for (const hashtagId of hashtagIds) {
      // Fetch top posts from ranked feed
      const postIds = await trackedRedis.zrevrange(
        `hashtag:${hashtagId}:ranked`,
        0,
        postsPerHashtag - 1
      );

      if (postIds.length > 0) {
        const posts = await aggregatePostsWithUsers(postIds, requestId, true, authenticatedUserId);
        hashtagResults[hashtagId] = posts;
      } else {
        hashtagResults[hashtagId] = [];
      }
    }

    const response = { hashtags: hashtagResults };

    setCache(cacheKey, response, 60);

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [GET /search/hashtags/top-posts] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json(response);
  } catch (err) {
    console.error("Error searching hashtag top posts:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [GET /search/hashtags/top-posts] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to search hashtag top posts" });
  }
});

// ===== GET /search/models/top: Get top models by engagement =====
app.get("/search/models/top", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    let limit = parseInt(req.query.limit) || 5;

    if (limit > 100) limit = 100;

    const cacheKey = `search_models_top_${limit}`;

    const cached = getCached(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;
      console.log(`✅ [GET /search/models/top] CACHE HIT | Duration: ${duration}ms | Redis: 0 commands, 0 pipelines`);
      cleanupRedisCounter(requestId);
      return res.json(cached);
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch top models from engagement sorted set
    const modelIds = await trackedRedis.zrevrange('models:top:engagement', 0, limit - 1, 'WITHSCORES');

    const models = [];
    if (modelIds.length > 0) {
      // modelIds contains [id1, score1, id2, score2, ...]
      const pipeline = trackedRedis.pipeline();
      for (let i = 0; i < modelIds.length; i += 2) {
        const modelId = modelIds[i];
        pipeline.hgetall(`user:${modelId}`);
      }
      const results = await pipeline.exec();

      for (let i = 0; i < modelIds.length; i += 2) {
        const modelId = modelIds[i];
        const score = parseFloat(modelIds[i + 1]);
        const [, userData] = results[i / 2];

        if (userData && Object.keys(userData).length > 0) {
          const sanitized = sanitizeUserData(userData, modelId, null);
          models.push({
            ...sanitized,
            engagement_score: score
          });
        }
      }
    }

    const response = { models, count: models.length };

    setCache(cacheKey, response, 120);

    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`✅ [GET /search/models/top] Success | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);

    res.json(response);
  } catch (err) {
    console.error("Error searching top models:", err);
    const duration = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`❌ [GET /search/models/top] Error | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
    cleanupRedisCounter(requestId);
    res.status(500).json({ error: "Failed to search top models" });
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

// ===== POST /seed: Seed test data (TESTING ONLY) =====
app.post("/seed", async (req, res) => {
  try {
    console.log("[SEED] Starting database seed...");

    const multi = redis.multi();
    const now = Date.now();

    // Create 3 test users
    const users = [
      {
        id: 'user-1',
        username: 'alice',
        display_name: 'Alice Wonder',
        avatar: 'https://i.pravatar.cc/150?img=1',
        bio: 'Software engineer and cat lover',
        role: 'user',
        email: 'alice@example.com',
        postCount: 0,
        followerCount: 0,
        followingCount: 0
      },
      {
        id: 'user-2',
        username: 'bobmodel',
        display_name: 'Bob Model',
        avatar: 'https://i.pravatar.cc/150?img=2',
        bio: 'Professional model and fitness enthusiast',
        role: 'model',
        email: 'bob@example.com',
        postCount: 0,
        followerCount: 0,
        followingCount: 0
      },
      {
        id: 'user-3',
        username: 'charlie',
        display_name: 'Charlie Admin',
        avatar: 'https://i.pravatar.cc/150?img=3',
        bio: 'Platform administrator',
        role: 'admin',
        email: 'charlie@example.com',
        postCount: 0,
        followerCount: 0,
        followingCount: 0
      }
    ];

    // Create users
    for (const user of users) {
      multi.hset(`user:${user.id}`, user);
      const userTimestamp = now - (Math.random() * 86400000); // Random within last day
      if (user.role === 'model') {
        multi.zadd('users:models', userTimestamp, user.id);
        multi.zadd('models:top:engagement', 0, user.id);
      } else {
        multi.zadd('users:regular', userTimestamp, user.id);
      }
    }

    // Alice follows Bob
    multi.sadd('user:user-1:following', 'user-2');
    multi.sadd('user:user-2:followers', 'user-1');
    multi.hincrby('user:user-1', 'followingCount', 1);
    multi.hincrby('user:user-2', 'followerCount', 1);

    // Create test posts
    const posts = [
      {
        id: `${now}-post1`,
        user_id: 'user-1',
        username: 'alice',
        avatar: 'https://i.pravatar.cc/150?img=1',
        display_name: 'Alice Wonder',
        user_role: 'user',
        content: 'Hello world! #introduction #coding',
        media_url: '',
        created_at: now - 3600000, // 1 hour ago
        likesCount: 0,
        commentsCount: 0,
        bookmarksCount: 0
      },
      {
        id: `${now}-post2`,
        user_id: 'user-2',
        username: 'bobmodel',
        avatar: 'https://i.pravatar.cc/150?img=2',
        display_name: 'Bob Model',
        user_role: 'model',
        content: 'New photoshoot coming soon! #fashion #photography',
        media_url: 'https://picsum.photos/800/600',
        created_at: now - 7200000, // 2 hours ago
        likesCount: 0,
        commentsCount: 0,
        bookmarksCount: 0
      },
      {
        id: `${now}-post3`,
        user_id: 'user-1',
        username: 'alice',
        avatar: 'https://i.pravatar.cc/150?img=1',
        display_name: 'Alice Wonder',
        user_role: 'user',
        content: 'Just deployed my new app! #coding #nodejs',
        media_url: '',
        created_at: now - 10800000, // 3 hours ago
        likesCount: 0,
        commentsCount: 0,
        bookmarksCount: 0
      }
    ];

    for (const post of posts) {
      multi.hset(`post:${post.id}`, post);
      multi.zadd('explore:feed', post.created_at, post.id);
      multi.zadd(`user:${post.user_id}:posts`, post.created_at, post.id);
      multi.hincrby(`user:${post.user_id}`, 'postCount', 1);

      // Add to hashtag feeds
      const hashtags = extractHashtags(post.content);
      for (const tag of hashtags) {
        multi.zadd(`hashtag:${tag}:posts`, post.created_at, post.id);
        multi.zadd(`hashtag:${tag}:ranked`, 0, post.id); // Initial score 0
      }
    }

    await multi.exec();

    console.log("[SEED] Database seeded successfully");
    res.json({
      message: "Database seeded successfully",
      users: users.length,
      posts: posts.length,
      test_credentials: {
        note: "Use these user IDs to generate JWT tokens for testing",
        users: users.map(u => ({ id: u.id, username: u.username, role: u.role }))
      }
    });
  } catch (err) {
    console.error("[SEED] Error:", err);
    res.status(500).json({ error: "Failed to seed database", details: err.message });
  }
});

// ===== Error / crash logging =====
process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
