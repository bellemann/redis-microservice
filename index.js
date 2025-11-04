import express from "express";
import cors from "cors";
import Redis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import fs from "fs";
import { randomUUID } from "crypto";

dotenv.config();

/**
 * ==================================================================================
 * IMPORTANT: USERNAME AS PRIMARY KEY
 * ==================================================================================
 *
 * This system uses USERNAME as the primary identifier for users, NOT UUID.
 *
 * Key Design Decisions:
 * 1. All user keys follow pattern: user:<username> (e.g., user:alice)
 * 2. All related keys use username: user:<username>:posts, user:<username>:following, etc.
 * 3. Interaction sets (likes, bookmarks) store usernames instead of UUIDs
 * 4. Role-based sets (users:models, users:regular) store usernames
 * 5. JWT tokens MUST contain a "username" field for authentication
 *
 * USERNAME IMMUTABILITY:
 * - Usernames are IMMUTABLE and cannot be changed after account creation
 * - Changing a username would require:
 *   - Renaming all user keys (user:<old> → user:<new>)
 *   - Updating all post.user_id fields across all posts
 *   - Updating all follower/following sets
 *   - Updating all interaction sets (likes, bookmarks)
 *   - Updating all role-based sorted sets
 * - This is extremely complex and error-prone, so username changes are blocked
 *
 * See PATCH /users/:id endpoint for username change handling.
 * ==================================================================================
 */

/**
 * ==================================================================================
 * SENSITIVE USER FIELDS & PRIVACY CONTROLS
 * ==================================================================================
 *
 * User profiles contain both PUBLIC and PRIVATE fields. The system automatically
 * filters sensitive fields based on who is viewing the profile.
 *
 * PRIVATE FIELDS (only visible when viewing your own profile):
 * - Personal Identity: first_name, last_name, date_of_birth, birth_date
 * - Contact Info: email, phone, phone_number, address
 * - Security: password, password_hash, ssn, credit_card, bank_account
 * - Technical: ip_address, device_id
 *
 * PUBLIC FIELDS (visible to everyone):
 * - username, display_name, bio, avatar, links
 * - role, postCount, followerCount, followingCount
 * - created_at, updated_at
 * - Any custom fields not in the sensitive list
 *
 * IMPLEMENTATION:
 * - Sensitive fields are defined in SENSITIVE_USER_FIELDS array (line 234)
 * - Filtering is done by sanitizeUserData() function (line 252)
 * - Applied automatically in GET /users/:id endpoint (line 1990)
 * - Applied in all feed endpoints when includeUser=true
 * - Applied in search endpoints (newest users, top models)
 *
 * WHEN TO SHOW ALL FIELDS:
 * - When username === authenticatedUsername (viewing own profile)
 * - When using API key authentication (admin access for Xano sync)
 *
 * WHEN TO FILTER FIELDS:
 * - When viewing another user's profile
 * - In public feeds (explore feed)
 * - In search results
 *
 * TO ADD NEW SENSITIVE FIELDS:
 * 1. Add field name to SENSITIVE_USER_FIELDS array (line 234)
 * 2. No other changes needed - sanitization is automatic
 *
 * TO ADD NEW PUBLIC FIELDS:
 * - Just add to user hash - any field not in SENSITIVE_USER_FIELDS is public
 * ==================================================================================
 */

const app = express();
app.use(cors());
app.options("*", cors()); // Preflight support for all routes
app.use(express.json());

// ===== Redis connection with TLS support =====
function createRedisConnection() {
  const redisUrl = process.env.REDIS_URL;
  const useTLS = process.env.USE_REDIS_TLS === 'true';

  const options = {
    enableReadyCheck: false
  };

  // If TLS is enabled and certificate files are provided
  if (useTLS) {
    const tlsConfig = {};

    // Load CA certificate if provided (optional for Redis Cloud managed certs)
    if (process.env.REDIS_TLS_CA_CERT && fs.existsSync(process.env.REDIS_TLS_CA_CERT)) {
      tlsConfig.ca = fs.readFileSync(process.env.REDIS_TLS_CA_CERT);
      console.log('✓ Loaded Redis TLS CA certificate');
    }

    // Load client certificate if provided (for mutual TLS)
    if (process.env.REDIS_TLS_CLIENT_CERT && fs.existsSync(process.env.REDIS_TLS_CLIENT_CERT)) {
      tlsConfig.cert = fs.readFileSync(process.env.REDIS_TLS_CLIENT_CERT);
      console.log('✓ Loaded Redis TLS client certificate');
    }

    // Load client key if provided (for mutual TLS)
    if (process.env.REDIS_TLS_CLIENT_KEY && fs.existsSync(process.env.REDIS_TLS_CLIENT_KEY)) {
      tlsConfig.key = fs.readFileSync(process.env.REDIS_TLS_CLIENT_KEY);
      console.log('✓ Loaded Redis TLS client key');
    }

    // Enable TLS with client certificates (for Redis Cloud client auth)
    // Redis Cloud manages server certificates, we only provide client certs
    if (Object.keys(tlsConfig).length > 0) {
      options.tls = {
        ...tlsConfig,
        // For Redis Cloud: trust system CA certificates for server verification
        // Client certificates are provided above for client authentication
        rejectUnauthorized: true
      };
      console.log('✓ Redis TLS enabled with client certificates');
    } else {
      console.warn('⚠ USE_REDIS_TLS=true but no certificate files found. Connecting without client certificates.');
    }
  }

  return new Redis(redisUrl, options);
}

const redis = createRedisConnection();

// ===== Environment validation =====
if (!process.env.XANO_API_KEY) {
  console.warn('WARNING: XANO_API_KEY is not set. API key authentication will not work.');
}

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
  hset: redis.hset.bind(redis),
  hdel: redis.hdel.bind(redis),
  hincrby: redis.hincrby.bind(redis),
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
    hset: wrapRedisCommand('hset', originalRedis.hset, requestId),
    hdel: wrapRedisCommand('hdel', originalRedis.hdel, requestId),
    hincrby: wrapRedisCommand('hincrby', originalRedis.hincrby, requestId),
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
// IMPORTANT: These fields are automatically removed when viewing other users' profiles.
// See header comment for full privacy documentation.
// To add a new sensitive field, simply add it to this array.
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
  'device_id',
  // User preference/privacy settings (only visible to self)
  'language',
  'email_notifications',
  'allowed_last_online',
  'allowed_mark_read'
  // ADD YOUR CUSTOM SENSITIVE FIELDS HERE
  // Examples: 'tax_id', 'passport_number', 'driver_license', 'medical_info'
  // Any field added here will be automatically filtered from other users' views
];

function sanitizeUserData(userData, username, authenticatedUsername) {
  if (!userData || Object.keys(userData).length === 0) return userData;

  // PRIVACY CHECK: If viewing own profile, return all data (including sensitive fields)
  if (username === authenticatedUsername) {
    return userData;
  }

  // PRIVACY FILTER: For other users, remove all sensitive fields defined in SENSITIVE_USER_FIELDS
  // This protects: email, phone, password, SSN, credit cards, addresses, etc.
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

// ===== API KEY AUTHENTICATION HELPER =====
// WARNING: API key grants unrestricted Redis access. Ensure it's kept secret and only used by trusted backend services (Xano).
// Consider implementing rate limiting for API key requests in production.
function authenticateApiKey(req) {
  // Check for X-API-Key header (case-insensitive)
  const apiKey = req.headers['x-api-key'] || req.headers['X-API-Key'];

  if (!apiKey || !process.env.XANO_API_KEY) {
    return false;
  }

  return apiKey === process.env.XANO_API_KEY;
}

// ===== DUAL AUTHENTICATION MIDDLEWARE (JWT OR API KEY) =====
// JWT authentication: For REST endpoints (users, posts, feeds, etc.) - frontend clients
// API key authentication: For Redis proxy endpoints (Xano sync only) - backend services
app.use((req, res, next) => {
  // Allow CORS preflight requests through without auth
  if (req.method === "OPTIONS") return next();

  // 1. Attempt API Key Authentication First
  // API key grants access to Redis proxy endpoints for backend sync operations
  // Frontend clients use JWT for REST endpoints only
  const apiKeyHeader = req.headers['x-api-key'] || req.headers['X-API-Key'];

  if (apiKeyHeader) {
    // X-API-Key header is present - validate it
    if (authenticateApiKey(req)) {
      // Log successful API key authentication (without revealing key)
      console.log(`✓ API Key authentication successful for ${req.method} ${req.path}`);

      // Set special admin user object for API key requests
      // API KEY PRIVILEGE: Bypasses ownership checks for writes
      // Note: GET endpoints still enforce privacy via sanitizeUserData() unless explicitly changed
      // Used for Xano sync to read/write any user data
      req.user = {
        user_id: 'xano_sync',
        username: 'xano_sync',
        role: 'admin',
        isApiKey: true  // This flag bypasses ownership checks on writes
      };
      return next();
    } else {
      // X-API-Key header present but invalid - return 401 immediately
      console.warn(`⚠ Invalid API key attempt for ${req.method} ${req.path}`);
      return res.status(401).json({ error: "Invalid API key" });
    }
  }

  // 2. Fall Back to JWT Authentication
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

    // Validate username field (required for username-based user keys)
    if (!decoded.username) {
      return res.status(401).json({ error: "Missing username in token" });
    }

    // Validate role field
    const role = decoded.role;
    const validRoles = ['admin', 'user', 'model'];
    if (!role || !validRoles.includes(role)) {
      return res.status(401).json({ error: "Invalid or missing role in token" });
    }

    // Assign validated role to req.user with isApiKey flag
    req.user = decoded;
    req.user.role = role;
    req.user.isApiKey = false;
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
async function aggregatePostsWithUsers(postIds, requestId, includeUser = true, authenticatedUsername = null) {
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

  if (authenticatedUsername) {
    const validPostIds = posts.filter(p => p).map(p => p.id);
    if (validPostIds.length > 0) {
      const interactionPipeline = trackedRedis.pipeline();

      for (const postId of validPostIds) {
        interactionPipeline.sismember(`post:${postId}:likes`, authenticatedUsername);
        interactionPipeline.sismember(`post:${postId}:bookmarks`, authenticatedUsername);
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

      // PRIVACY: Sanitize user data in feed responses
      // Users in feeds only show public fields (username, display_name, bio, avatar, etc.)
      // Sensitive fields (email, phone, etc.) are automatically removed
      if (postData.user_id) {
        userData = sanitizeUserData(userData, postData.user_id, authenticatedUsername);
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

  console.log(`[aggregatePostsWithUsers] Returning ${results.length} aggregated posts${includeUser ? ' with users' : ' (no users)'}${authenticatedUsername ? ' with interactions' : ''}`);
  return results;
}

// ===== Read‑only Redis proxy endpoint (API key only) =====
// Frontend clients should use REST endpoints instead
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
  const tokenUsername = req.user.username;
  const isApiKeyAuth = req.user.isApiKey === true;

  // SECURITY: Restrict Redis proxy to API key authentication only
  // Frontend clients must use REST endpoints for proper authorization and validation
  if (!isApiKeyAuth) {
    return res.status(403).json({
      error: "Redis proxy access requires API key authentication",
      message: "Frontend clients should use REST endpoints instead",
      availableEndpoints: [
        "GET /users/:id - Get user profile",
        "PATCH /users/:id - Update profile",
        "POST /posts - Create post",
        "GET /feed/explore - Get explore feed",
        "GET /feed/following - Get following feed"
      ],
      documentation: "See docs/FRONTEND_GUIDE.md for frontend integration"
    });
  }

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
      // Replace user:me placeholder in key positions (API key only, resolves to user:xano_sync)
      // Note: Since only API key reaches this point, placeholder support is minimal
      // Multi-key commands that accept multiple keys as arguments
      const multiKeyCommands = ["MGET", "DEL", "EXISTS", "TOUCH", "UNLINK", "SUNION", "SINTER", "SDIFF", "ZUNION", "ZINTER", "ZDIFF"];

      const argsProcessed = args.map((a, index) => {
        if (typeof a !== "string") {
          return a;
        }

        // For multi-key commands, apply replacement to all string arguments (they're all keys)
        if (multiKeyCommands.includes(cmd)) {
          return a.replace(/^user:me(?=$|:)/, `user:${tokenUsername}`);
        }

        // For single-key commands, only replace the first argument (the key)
        if (index === 0) {
          return a.replace(/^user:me(?=$|:)/, `user:${tokenUsername}`);
        }

        return a;
      });

      // Restrict user:<username>:following access
      if (
        argsProcessed.length > 0 &&
        typeof argsProcessed[0] === "string" &&
        /^user:[^:]+:following$/.test(argsProcessed[0])
      ) {
        const usernameInKey = argsProcessed[0].split(":")[1];
        if (usernameInKey !== tokenUsername) {
          results.push("ERR forbidden: private resource");
          continue;
        }
      }

      // Note: API key authentication allows reading any user data for backend sync operations
      // Validation of key formats is still performed below

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
      console.log("=== Redis Request (API Key) ===");
      console.log("Username:", req.user.username);
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

// ===== POST /redis/write: Write-enabled Redis proxy (API key only) =====
// Frontend clients should use REST endpoints for writes
app.post("/redis/write", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const tokenUsername = req.user.username;
    const isApiKeyAuth = req.user.isApiKey === true;
    const commands = req.body;

    // Normalize single command array to array of commands for Upstash-style compatibility
    // Supports both formats:
    // - Single command: ["HSET", "user:123", "email", "test@example.com"]
    // - Array of commands: [["HSET", "user:123", "email", "test@example.com"], ["HDEL", "user:123", "tmpField"]]
    let commandsNormalized;
    if (Array.isArray(commands) && commands.length > 0 && typeof commands[0] === 'string') {
      commandsNormalized = [commands];
    } else {
      commandsNormalized = commands;
    }

    if (!Array.isArray(commandsNormalized) || commandsNormalized.length === 0) {
      return res.status(400).json({ error: "Request body must be a non-empty array of commands" });
    }

    // SECURITY: Restrict Redis write proxy to API key authentication only
    // Frontend clients must use REST endpoints for proper authorization and validation
    if (!isApiKeyAuth) {
      return res.status(403).json({
        error: "Redis write proxy requires API key authentication",
        message: "Frontend clients should use REST endpoints like PATCH /users/:id instead",
        availableEndpoints: [
          "PATCH /users/:id - Update user profile",
          "POST /posts - Create post",
          "POST /posts/:id/like - Like post",
          "POST /posts/:id/bookmark - Bookmark post",
          "POST /users/:username/follow - Follow user"
        ],
        documentation: "See docs/FRONTEND_GUIDE.md for frontend integration"
      });
    }

    // Whitelist of allowed write commands
    const allowedWriteCommands = ["HSET", "HDEL", "HINCRBY"];

    // FIELD RESTRICTIONS: Certain fields require denormalization or are system-managed
    // Blocked fields that require PATCH /users/:id (denormalization):
    // - username, display_name, avatar (must update all user's posts)
    // System-managed fields (auto-calculated):
    // - role, postCount, followerCount, followingCount
    // Allowed fields:
    // - bio, links, and any custom fields
    // - Sensitive fields (email, phone, etc.) can be updated
    const blockedFields = [
      "username", "display_name", "avatar",  // Require denormalization to posts
      "role", "postCount", "followerCount", "followingCount"  // System-managed
    ];

    const results = [];

    for (let command of commandsNormalized) {
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
        // Replace user:me placeholder in key argument only (API key only, resolves to user:xano_sync)
        // Note: Since only API key reaches this point, recommend using explicit usernames instead
        const argsProcessed = args.map((a, index) =>
          index === 0 && typeof a === "string"
            ? a.replace(/^user:me(?=$|:)/, `user:${tokenUsername}`)
            : a
        );

        // Authorization check: validate key format
        if (argsProcessed.length > 0 && typeof argsProcessed[0] === "string") {
          const key = argsProcessed[0];

          // Check if key matches user:<username> or user:<username>:* pattern
          const userKeyMatch = key.match(/^user:([^:]+)(?::.*)?$/);

          if (!userKeyMatch) {
            results.push("ERR invalid key format");
            continue;
          }

          // API key authentication allows modifying any user data (for backend sync operations)
        }

        // Field restriction check for HSET and HDEL commands
        // NOTE: These restrictions apply to API key requests to ensure data consistency
        // Could be relaxed in the future if needed for Xano sync edge cases

        // HSET supports multiple field-value pairs: HSET key f1 v1 f2 v2 ...
        // Validate all field names, not just the first one
        if (cmd === "HSET" && argsProcessed.length >= 2) {
          // Validate argument count: must have key + field-value pairs (odd total count)
          if (argsProcessed.length % 2 === 0) {
            results.push("ERR HSET requires field-value pairs (odd number of arguments after key)");
            continue;
          }

          // Extract all field names (at odd indices: 1, 3, 5, ...)
          const fieldNames = [];
          for (let i = 1; i < argsProcessed.length; i += 2) {
            fieldNames.push(argsProcessed[i]);
          }

          // Check each field against blocked list
          const blockedFieldsFound = fieldNames.filter(f => blockedFields.includes(f));
          if (blockedFieldsFound.length > 0) {
            const fieldList = blockedFieldsFound.map(f => `'${f}'`).join(", ");
            results.push(`ERR field${blockedFieldsFound.length > 1 ? 's' : ''} ${fieldList} cannot be modified directly, use PATCH /users/:id`);
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
            // Allow API key sync to increment count fields (followerCount, followingCount, postCount)
            const allowedCountFields = ['followerCount', 'followingCount', 'postCount'];
            const isAllowedForApiKey = req.user.isApiKey === true && allowedCountFields.includes(fieldName);

            if (!isAllowedForApiKey) {
              results.push(`ERR field '${fieldName}' cannot be modified directly, use PATCH /users/:id`);
              continue;
            }

            // Optionally validate that the increment value is numeric
            if (argsProcessed.length >= 3 && isNaN(Number(argsProcessed[2]))) {
              results.push(`ERR HINCRBY increment must be numeric`);
              continue;
            }
          }
        }

        // Console logging for debug
        console.log("=== Redis Write Request (API Key - Admin) ===");
        console.log("Username:", req.user.username);
        console.log("Command:", cmdRaw);
        console.log("Original args:", args);
        console.log("Resolved args:", argsProcessed);

        // Log multi-field HSET operations
        if (cmd === "HSET" && argsProcessed.length > 3) {
          const fieldCount = Math.floor((argsProcessed.length - 1) / 2);
          const fieldNames = [];
          for (let i = 1; i < argsProcessed.length; i += 2) {
            fieldNames.push(argsProcessed[i]);
          }
          console.log(`Multi-field HSET: ${fieldCount} fields (${fieldNames.join(", ")})`);
        }

        // Execute Redis command
        const trackedRedis = createTrackedRedis(requestId);
        const result = await trackedRedis[cmd.toLowerCase()](...argsProcessed);

        console.log("Redis result:", result);
        console.log("===========================");

        // Cache invalidation after successful write
        // Parse the key to determine which user's data was affected
        const key = argsProcessed[0];
        const userKeyMatch = key.match(/^user:([^:]+)/);

        if (userKeyMatch) {
          const affectedUser = userKeyMatch[1];

          // Invalidate the affected user's cache
          delete userCache[affectedUser];

          // Invalidate user profile cache for all viewers of this user
          const profileCacheKeys = Object.keys(cache).filter(key =>
            key.startsWith(`user_profile_${affectedUser}_`)
          );
          profileCacheKeys.forEach(key => delete cache[key]);
        }

        // Invalidate feed caches (conservative approach)
        invalidateFeedCaches();

        results.push(result);
      } catch (err) {
        console.error("Redis write error:", err);
        results.push(`ERR ${err.message}`);
      }
    }

    const elapsed = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.log(`[POST /redis/write] 200 ${elapsed}ms (Redis: ${counter.commands} commands, ${counter.pipelines} pipelines) [${requestId}]`);

    res.json({
      results: results,
      username: tokenUsername
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const counter = getRedisCounter(requestId);
    console.error("Redis write endpoint error:", err);
    console.log(`[POST /redis/write] 500 ${elapsed}ms (Redis: ${counter.commands} commands, ${counter.pipelines} pipelines) [${requestId}]`);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===== POST /posts: Create a new post =====
// NOTE: API key requests will work here with user_id='xano_sync' and role='admin'
app.post("/posts", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const username = req.user.username;
    const { content, media_url } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: "Content is required" });
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch user data for denormalization
    const userData = await trackedRedis.hgetall(`user:${username}`);

    if (!userData || Object.keys(userData).length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Generate post ID (UUID) and timestamp
    const postId = randomUUID();
    const timestamp = Date.now();

    // Build post data with denormalized user info
    const postData = {
      id: postId,
      user_id: username,
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
    multi.zadd(`user:${username}:posts`, timestamp, postId);

    // Add to hashtag feeds using extracted hashtags from content
    for (const hashtagId of extractedHashtags) {
      multi.zadd(`hashtag:${hashtagId}:posts`, timestamp, postId);
      // Initialize ranked feed with score 0
      multi.zadd(`hashtag:${hashtagId}:ranked`, 0, postId);
    }

    // Increment user's post count
    multi.hincrby(`user:${username}`, 'postCount', 1);

    await multi.exec();

    // Invalidate relevant caches
    delete cache[`user_profile_${username}_${username}`];
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
// NOTE: API key requests have role='admin' and will bypass ownership check
app.delete("/posts/:id", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    const postId = req.params.id;
    const username = req.user.username;
    const userRole = req.user.role;

    const trackedRedis = createTrackedRedis(requestId);

    // Fetch post data
    const postData = await trackedRedis.hgetall(`post:${postId}`);

    if (!postData || Object.keys(postData).length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check authorization (owner or admin)
    // API key requests will have role='admin' and will bypass this check
    if (postData.user_id !== username && userRole !== 'admin') {
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

    // Remove post from each user's bookmarked list (bookmarkedBy now contains usernames)
    for (const bookmarkUsername of bookmarkedBy) {
      multi.zrem(`user:${bookmarkUsername}:bookmarked`, postId);
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
    await redis.hset(`post:${postId}`, 'banned_by', req.user.username);

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

    // Remove post from each user's bookmarked list (bookmarkedBy now contains usernames)
    for (const bookmarkUsername of bookmarkedBy) {
      multi.zrem(`user:${bookmarkUsername}:bookmarked`, postId);
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
    const username = req.user.username;

    const trackedRedis = createTrackedRedis(requestId);

    // Check if post exists
    const postExists = await trackedRedis.exists(`post:${postId}`);
    if (postExists === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if already liked
    const alreadyLiked = await trackedRedis.sismember(`post:${postId}:likes`, username);
    if (alreadyLiked) {
      return res.status(400).json({ error: "Post already liked" });
    }

    // Get post data for ranking updates
    const postData = await trackedRedis.hgetall(`post:${postId}`);

    // Use Redis transaction
    const multi = redis.multi();

    // Add user to likes set
    multi.sadd(`post:${postId}:likes`, username);

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
    const username = req.user.username;

    const trackedRedis = createTrackedRedis(requestId);

    // Check if post exists
    const postExists = await trackedRedis.exists(`post:${postId}`);
    if (postExists === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if liked
    const isLiked = await trackedRedis.sismember(`post:${postId}:likes`, username);
    if (!isLiked) {
      return res.status(400).json({ error: "Post not liked" });
    }

    // Get post data for ranking updates
    const postData = await trackedRedis.hgetall(`post:${postId}`);

    // Use Redis transaction
    const multi = redis.multi();

    // Remove user from likes set
    multi.srem(`post:${postId}:likes`, username);

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
    const username = req.user.username;

    const trackedRedis = createTrackedRedis(requestId);

    // Check if post exists
    const postExists = await trackedRedis.exists(`post:${postId}`);
    if (postExists === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if already bookmarked
    const alreadyBookmarked = await trackedRedis.sismember(`post:${postId}:bookmarks`, username);
    if (alreadyBookmarked) {
      return res.status(400).json({ error: "Post already bookmarked" });
    }

    // Get post data for ranking updates
    const postData = await trackedRedis.hgetall(`post:${postId}`);
    const timestamp = Date.now();

    // Use Redis transaction
    const multi = redis.multi();

    // Add user to bookmarks set
    multi.sadd(`post:${postId}:bookmarks`, username);

    // Add to user's bookmarked sorted set
    multi.zadd(`user:${username}:bookmarked`, timestamp, postId);

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
    const username = req.user.username;

    const trackedRedis = createTrackedRedis(requestId);

    // Check if post exists
    const postExists = await trackedRedis.exists(`post:${postId}`);
    if (postExists === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if bookmarked
    const isBookmarked = await trackedRedis.sismember(`post:${postId}:bookmarks`, username);
    if (!isBookmarked) {
      return res.status(400).json({ error: "Post not bookmarked" });
    }

    // Get post data for ranking updates
    const postData = await trackedRedis.hgetall(`post:${postId}`);

    // Use Redis transaction
    const multi = redis.multi();

    // Remove user from bookmarks set
    multi.srem(`post:${postId}:bookmarks`, username);

    // Remove from user's bookmarked sorted set
    multi.zrem(`user:${username}:bookmarked`, postId);

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
// Supports 'me' as :id parameter to fetch own bookmarks
app.get("/users/:id/bookmarked", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    let username = req.params.id;
    const authenticatedUsername = req.user.username;

    // Resolve 'me' placeholder to authenticated username
    if (username === 'me') {
      username = authenticatedUsername;
    }

    // Only allow users to view their own bookmarks
    if (username !== authenticatedUsername) {
      return res.status(403).json({ error: "Not authorized to view bookmarks" });
    }

    const offset = parseInt(req.query.offset) || 0;
    let limit = parseInt(req.query.limit) || 20;
    const includeUser = req.query.includeUser !== 'false';

    if (limit > 100) limit = 100;

    const cacheKey = `bookmarked_${username}_${offset}_${limit}_${includeUser}`;

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
        `user:${username}:bookmarked`,
        currentOffset,
        currentOffset + bufferSize - 1
      );

      if (postIds.length === 0) break;

      const aggregated = await aggregatePostsWithUsers(postIds, requestId, includeUser, authenticatedUsername);
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
// Supports 'me' as :id parameter (will fail with appropriate error since you cannot follow yourself)
app.post("/users/:id/follow", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    let targetUsername = req.params.id;
    const username = req.user.username;

    // Resolve 'me' placeholder to authenticated username (will fail self-follow check)
    if (targetUsername === 'me') {
      targetUsername = username;
    }

    if (targetUsername === username) {
      return res.status(400).json({ error: "Cannot follow yourself" });
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Check if target user exists
    const targetUserExists = await trackedRedis.exists(`user:${targetUsername}`);
    if (targetUserExists === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if already following
    const alreadyFollowing = await trackedRedis.sismember(`user:${username}:following`, targetUsername);
    if (alreadyFollowing) {
      return res.status(400).json({ error: "Already following this user" });
    }

    // Use Redis transaction
    const multi = redis.multi();

    // Add to following set
    multi.sadd(`user:${username}:following`, targetUsername);

    // Add to target's followers set
    multi.sadd(`user:${targetUsername}:followers`, username);

    // Increment counts
    multi.hincrby(`user:${username}`, 'followingCount', 1);
    multi.hincrby(`user:${targetUsername}`, 'followerCount', 1);

    await multi.exec();

    // Invalidate relevant caches
    delete cache[`user_profile_${username}_${username}`];
    delete cache[`user_profile_${targetUsername}_${targetUsername}`];
    delete userCache[username];
    delete userCache[targetUsername];
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
// Supports 'me' as :id parameter (will fail with appropriate error since you cannot unfollow yourself)
app.delete("/users/:id/follow", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    let targetUsername = req.params.id;
    const username = req.user.username;

    // Resolve 'me' placeholder to authenticated username (will fail self-unfollow check)
    if (targetUsername === 'me') {
      targetUsername = username;
    }

    if (targetUsername === username) {
      return res.status(400).json({ error: "Cannot unfollow yourself" });
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Check if following
    const isFollowing = await trackedRedis.sismember(`user:${username}:following`, targetUsername);
    if (!isFollowing) {
      return res.status(400).json({ error: "Not following this user" });
    }

    // Use Redis transaction
    const multi = redis.multi();

    // Remove from following set
    multi.srem(`user:${username}:following`, targetUsername);

    // Remove from target's followers set
    multi.srem(`user:${targetUsername}:followers`, username);

    // Decrement counts
    multi.hincrby(`user:${username}`, 'followingCount', -1);
    multi.hincrby(`user:${targetUsername}`, 'followerCount', -1);

    await multi.exec();

    // Invalidate relevant caches
    delete cache[`user_profile_${username}_${username}`];
    delete cache[`user_profile_${targetUsername}_${targetUsername}`];
    delete userCache[username];
    delete userCache[targetUsername];
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
// Supports 'me' as :id parameter to update own profile
// NOTE: API key requests will fail this ownership check since user_id='xano_sync' won't match the target userId
// If Xano needs to update user profiles directly, consider adding role='admin' bypass or use /redis/write
app.patch("/users/:id", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    let username = req.params.id;
    const authenticatedUsername = req.user.username;

    // Resolve 'me' placeholder to authenticated username
    if (username === 'me') {
      username = authenticatedUsername;
    }

    // AUTHORIZATION: Users can only update their own profile
    // Exception: Admin role or API key can update any profile
    // API key requests (username='xano_sync') will be blocked unless username param is 'xano_sync'
    if (username !== authenticatedUsername) {
      return res.status(403).json({ error: "Not authorized to update this profile" });
    }

    // NOTE: Some fields have special handling:
    // - Sensitive fields (email, phone, etc.) can be updated freely
    // - System fields (postCount, followerCount, etc.) should not be modified directly
    // - Denormalized fields (username, display_name, avatar) trigger post updates

    const { username: newUsername, display_name, bio, avatar, links } = req.body;

    const trackedRedis = createTrackedRedis(requestId);

    // Get current user data
    const currentUserData = await trackedRedis.hgetall(`user:${username}`);

    if (!currentUserData || Object.keys(currentUserData).length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const oldUsername = currentUserData.username;
    const usernameChanged = newUsername && newUsername !== oldUsername;

    // Build update object
    const updates = {};
    if (newUsername !== undefined) updates.username = newUsername;
    if (display_name !== undefined) updates.display_name = display_name;
    if (bio !== undefined) updates.bio = bio;
    if (avatar !== undefined) updates.avatar = avatar;
    if (links !== undefined) updates.links = links;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // IMPORTANT: Username changes are extremely complex with username as primary key
    // This would require renaming all keys and updating all references
    // For now, we handle it but recommend making username immutable
    if (usernameChanged) {
      return res.status(400).json({
        error: "Username changes are not supported. Username is immutable as it serves as the primary key."
      });
    }

    // Use Redis transaction
    const multi = redis.multi();

    // Update user hash
    for (const [key, value] of Object.entries(updates)) {
      multi.hset(`user:${username}`, key, value);
    }

    // If avatar changed, update all posts
    if (avatar !== undefined) {
      const postIds = await trackedRedis.zrevrange(`user:${username}:posts`, 0, -1);
      for (const postId of postIds) {
        multi.hset(`post:${postId}`, 'avatar', avatar);
        delete postCache[postId];
      }
    }

    // If display_name changed, update all posts
    if (display_name !== undefined) {
      const postIds = await trackedRedis.zrevrange(`user:${username}:posts`, 0, -1);
      for (const postId of postIds) {
        multi.hset(`post:${postId}`, 'display_name', display_name);
        delete postCache[postId];
      }
    }

    await multi.exec();

    // Invalidate user cache
    delete userCache[username];
    invalidateFeedCaches();
    for (const key in cache) {
      if (key.includes(`user_profile_${username}`)) {
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
// Supports 'me' as :id parameter to delete own account
app.delete("/users/:id", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    let username = req.params.id;
    const authenticatedUsername = req.user.username;
    const userRole = req.user.role;

    // Resolve 'me' placeholder to authenticated username
    if (username === 'me') {
      username = authenticatedUsername;
    }

    // Only allow self-deletion or admin deletion
    if (username !== authenticatedUsername && userRole !== 'admin') {
      return res.status(403).json({ error: "Not authorized to delete this user" });
    }

    const trackedRedis = createTrackedRedis(requestId);

    // Get user data
    const userData = await trackedRedis.hgetall(`user:${username}`);

    if (!userData || Object.keys(userData).length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    console.log(`[DELETE /users/:id] Starting deletion for user ${username}`);

    // Get all user's posts
    const userPostIds = await trackedRedis.zrevrange(`user:${username}:posts`, 0, -1);
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
        multi.zrem(`user:${username}:posts`, postId);

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

    // Get all liked posts and remove user from likes sets (username now stored in interaction sets)
    const explorePosts = await trackedRedis.zrevrange('explore:feed', 0, 999);
    console.log(`[DELETE /users/:id] Checking ${explorePosts.length} posts for user interactions`);

    const cleanupMulti = redis.multi();

    // Check which posts the user actually liked to decrement likesCount
    const likeCheckPipeline = trackedRedis.pipeline();
    for (const postId of explorePosts) {
      likeCheckPipeline.sismember(`post:${postId}:likes`, username);
    }
    const likeCheckResults = await likeCheckPipeline.exec();

    for (let i = 0; i < explorePosts.length; i++) {
      const postId = explorePosts[i];
      const [err, wasLiked] = likeCheckResults[i];

      if (!err && wasLiked === 1) {
        cleanupMulti.hincrby(`post:${postId}`, 'likesCount', -1);
      }

      cleanupMulti.srem(`post:${postId}:likes`, username);
      cleanupMulti.srem(`post:${postId}:bookmarks`, username);
    }

    // Get bookmarked posts for cleanup
    const bookmarkedPosts = await trackedRedis.zrevrange(`user:${username}:bookmarked`, 0, -1);
    for (const postId of bookmarkedPosts) {
      cleanupMulti.hincrby(`post:${postId}`, 'bookmarksCount', -1);
    }

    // Delete all user keys
    cleanupMulti.del(`user:${username}`);
    cleanupMulti.del(`user:${username}:posts`);
    cleanupMulti.del(`user:${username}:bookmarked`);
    cleanupMulti.del(`user:${username}:following`);
    cleanupMulti.del(`user:${username}:followers`);

    // Remove from role-based sorted sets (now stores usernames instead of UUIDs)
    const role = userData.role || 'user';
    if (role === 'model') {
      cleanupMulti.zrem('users:models', username);
      cleanupMulti.zrem('models:top:engagement', username);
    } else {
      cleanupMulti.zrem('users:regular', username);
    }

    await cleanupMulti.exec();

    // Invalidate all caches
    delete userCache[username];
    invalidateFeedCaches();
    for (const key in cache) {
      if (key.includes(username)) {
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
// Supports 'me' as :id parameter to fetch own profile with all fields
app.get("/users/:id", async (req, res) => {
  const requestId = getRequestId();
  initRedisCounter(requestId);
  const startTime = Date.now();

  try {
    let username = req.params.id;
    const authenticatedUsername = req.user.username;

    console.log(`[DEBUG /users/:id] Original param: "${username}", Auth username: "${authenticatedUsername}"`);

    // Resolve 'me' placeholder to authenticated username
    if (username === 'me') {
      username = authenticatedUsername;
      console.log(`[DEBUG /users/:id] Resolved 'me' to: "${username}"`);
    }

    // Build viewer-specific cache key
    const cacheKey = `user_profile_${username}_${authenticatedUsername}`;

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
    const redisKey = `user:${username}`;
    console.log(`[DEBUG /users/:id] Fetching Redis key: "${redisKey}"`);
    const userData = await trackedRedis.hgetall(redisKey);

    if (!userData || Object.keys(userData).length === 0) {
      const duration = Date.now() - startTime;
      const counter = getRedisCounter(requestId);
      console.log(`❌ [GET /users/:id] User not found | Duration: ${duration}ms | Redis: ${counter.commands} commands, ${counter.pipelines} pipelines`);
      cleanupRedisCounter(requestId);
      return res.status(404).json({ error: "User not found" });
    }

    // PRIVACY: Sanitize user data based on viewer relationship
    // - If viewing own profile (username === authenticatedUsername): return all fields
    // - If viewing other user: remove sensitive fields (email, phone, etc.)
    // See SENSITIVE_USER_FIELDS array for complete list of protected fields
    const sanitized = sanitizeUserData(userData, username, authenticatedUsername);

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

      const authenticatedUsername = req.user ? req.user.username : null;
      const aggregated = await aggregatePostsWithUsers(postIds, requestId, includeUser, authenticatedUsername);
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

      const authenticatedUsername = req.user ? req.user.username : null;
      const aggregated = await aggregatePostsWithUsers(postIds, requestId, includeUser, authenticatedUsername);
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
    const username = req.user.username;
    const offset = parseInt(req.query.offset) || 0;
    let limit = parseInt(req.query.limit) || 20;
    const includeUser = req.query.includeUser !== 'false'; // default true

    // Validate and cap limit at 100
    if (limit > 100) limit = 100;

    const cacheKey = `following_feed_${username}_${offset}_${limit}_${includeUser}`;

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

    // Get list of users being followed (now stores usernames instead of UUIDs)
    const followingIds = await trackedRedis.smembers(`user:${username}:following`);

    console.log(`User ${username} follows ${followingIds.length} users`);

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

    // Build keys for user:{username}:posts sorted sets (followingIds now contains usernames)
    const userPostKeys = followingIds.map(username => `user:${username}:posts`);

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
          const aggregated = await aggregatePostsWithUsers(filteredPostIds, requestId, includeUser, username);
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
      const tmpKey = `tmp:home:${username}`;
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
        const aggregated = await aggregatePostsWithUsers(fetchedIds, requestId, includeUser, username);
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

    // Fetch from sorted set (score = timestamp, now stores usernames instead of UUIDs)
    const setKey = role === 'model' ? 'users:models' : 'users:regular';
    const usernames = await trackedRedis.zrevrange(setKey, 0, limit - 1);

    // Fetch user data
    const users = [];
    if (usernames.length > 0) {
      const pipeline = trackedRedis.pipeline();
      for (const username of usernames) {
        pipeline.hgetall(`user:${username}`);
      }
      const results = await pipeline.exec();

      for (let i = 0; i < usernames.length; i++) {
        const [, userData] = results[i];
        if (userData && Object.keys(userData).length > 0) {
          // PRIVACY: Sanitize all user data in search results
          // Search results never include sensitive fields (email, phone, etc.)
          const sanitized = sanitizeUserData(userData, usernames[i], null);
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
    const authenticatedUsername = req.user?.username ?? null;

    const hashtagResults = {};

    for (const hashtagId of hashtagIds) {
      // Fetch top posts from ranked feed
      const postIds = await trackedRedis.zrevrange(
        `hashtag:${hashtagId}:ranked`,
        0,
        postsPerHashtag - 1
      );

      if (postIds.length > 0) {
        const posts = await aggregatePostsWithUsers(postIds, requestId, true, authenticatedUsername);
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

    // Fetch top models from engagement sorted set (now stores usernames instead of UUIDs)
    const modelUsernames = await trackedRedis.zrevrange('models:top:engagement', 0, limit - 1, 'WITHSCORES');

    const models = [];
    if (modelUsernames.length > 0) {
      // modelUsernames contains [username1, score1, username2, score2, ...]
      const pipeline = trackedRedis.pipeline();
      for (let i = 0; i < modelUsernames.length; i += 2) {
        const modelUsername = modelUsernames[i];
        pipeline.hgetall(`user:${modelUsername}`);
      }
      const results = await pipeline.exec();

      for (let i = 0; i < modelUsernames.length; i += 2) {
        const modelUsername = modelUsernames[i];
        const score = parseFloat(modelUsernames[i + 1]);
        const [, userData] = results[i / 2];

        if (userData && Object.keys(userData).length > 0) {
          // PRIVACY: Sanitize model data in top models list
          // Only public fields are shown in leaderboards
          const sanitized = sanitizeUserData(userData, modelUsername, null);
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
    const tokenUsername = req.user.username;
    const isApiKeyAuth = req.user.isApiKey === true;
    const resolvedKey = `user:${tokenUsername}`;
    const data = await redis.hgetall(resolvedKey);

    console.log("=== /debug-auth ===");
    console.log("Token username:", tokenUsername);
    console.log("Resolved key:", resolvedKey);
    console.log("Redis data:", data);
    console.log("===================");

    res.json({
      username: tokenUsername,
      resolved_key: resolvedKey,
      redis_data: data,
      redisProxyAccess: isApiKeyAuth,
      authMethod: isApiKeyAuth ? "API Key" : "JWT"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== /whoami: return JWT payload =====
app.all("/whoami", (req, res) => {
  res.json({
    jwt_payload: req.user,
    resolved_user_key: `user:${req.user.username}`
  });
});

// ===== POST /seed: Seed test data (TESTING ONLY) =====
app.post("/seed", async (req, res) => {
  try {
    console.log("[SEED] Starting database seed...");

    const multi = redis.multi();
    const now = Date.now();

    // Create 3 test users (username is now the primary key)
    const users = [
      {
        username: 'alice',
        uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
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
        username: 'bobmodel',
        uuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
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
        username: 'charlie',
        uuid: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
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

    // Create users (use username as key)
    for (const user of users) {
      multi.hset(`user:${user.username}`, user);
      multi.set(`username_to_uuid:${user.username}`, user.uuid);
      const userTimestamp = now - (Math.random() * 86400000); // Random within last day
      if (user.role === 'model') {
        multi.zadd('users:models', userTimestamp, user.username);
        multi.zadd('models:top:engagement', 0, user.username);
      } else {
        multi.zadd('users:regular', userTimestamp, user.username);
      }
    }

    // Alice follows Bob (use usernames in sets)
    multi.sadd('user:alice:following', 'bobmodel');
    multi.sadd('user:bobmodel:followers', 'alice');
    multi.hincrby('user:alice', 'followingCount', 1);
    multi.hincrby('user:bobmodel', 'followerCount', 1);

    // Create test posts (user_id now stores username)
    const posts = [
      {
        id: `${now}-post1`,
        user_id: 'alice',
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
        user_id: 'bobmodel',
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
        user_id: 'alice',
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
        note: "Use these usernames to generate JWT tokens for testing",
        users: users.map(u => ({ username: u.username, role: u.role }))
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
