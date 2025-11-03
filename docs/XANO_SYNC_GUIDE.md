# Xano Synchronization Guide

A comprehensive guide for syncing data from Xano (your source of truth) to Redis (your cache layer) using API key authentication.

## Introduction

This microservice uses a two-tier data architecture:
- **Xano (SQL Database):** Source of truth for all data
- **Redis (Cache Layer):** High-performance cache optimized for social media queries

**Sync Workflow:**
```
Xano Backend → Redis Microservice → Redis Cloud
   (SQL)      (API Key Auth)      (Cache)
```

**Benefits:**
- ⚡ **Fast queries:** Redis provides sub-millisecond response times
- 📉 **Reduced SQL load:** Offload read-heavy operations to Redis
- 🎯 **Optimized for feeds:** Sorted sets and time-based queries excel at social media patterns
- 🔄 **Real-time updates:** Sync data instantly when changes occur in Xano

## Prerequisites

Before you begin, ensure you have:
- ✅ Xano account with backend configured
- ✅ Redis microservice deployed and running
- ✅ API key configured in environment variables
- ✅ Network connectivity between Xano and Redis microservice
- ✅ HTTPS enabled on Redis microservice (recommended for production)

## Setup: Generate API Key

### Step 1: Generate a Secure Random API Key

Use OpenSSL to generate a cryptographically secure API key:

```bash
openssl rand -hex 32
```

**Example output:**
```
a7f3e9d2c1b4f6a8e9d7c2b5f3a1e8d6c4b7f9a2e5d8c1b3f6a9e2d5c8b1f4a7
```

### Step 2: Add to `.env` File

Add the generated key to your Redis microservice's `.env` file:

```env
XANO_API_KEY=a7f3e9d2c1b4f6a8e9d7c2b5f3a1e8d6c4b7f9a2e5d8c1b3f6a9e2d5c8b1f4a7
```

**Important:** Keep this key secret! Never commit it to version control.

### Step 3: Restart the Redis Microservice

Restart the service to load the new environment variable:

```bash
npm restart
# or
pm2 restart redis-microservice
```

### Step 4: Verify the Key is Loaded

Check the startup logs to confirm the API key is loaded:

```
✓ API key authentication enabled
✓ Server running on port 3000
```

## Authentication: Using the API Key

The API key grants **admin-level access** and bypasses all JWT authentication and ownership checks.

### Include in HTTP Requests

Add the API key as a custom header in all requests:

```bash
curl -X POST https://your-redis-service.com/redis/write \
  -H "X-API-Key: a7f3e9d2c1b4f6a8e9d7c2b5f3a1e8d6c4b7f9a2e5d8c1b3f6a9e2d5c8b1f4a7" \
  -H "Content-Type: application/json" \
  -d '[["HSET", "user:alice", "bio", "Updated bio from Xano"]]'
```

**Key Points:**
- ✅ Header name: `X-API-Key` (case-insensitive)
- ✅ Bypasses JWT authentication
- ✅ Bypasses ownership checks on writes (can modify any user's data via `/redis/write`)
- ✅ GET endpoints still apply privacy sanitization (use direct Redis reads via `POST /` for raw data)
- ✅ Full read/write access to all Redis data via proxy endpoints

## Syncing User Data

### Creating a User

Use the `/redis/write` endpoint to create a new user profile in Redis. **Note:** The write proxy has restrictions on certain fields to maintain data consistency.

**Endpoint:** `POST /redis/write`

**Allowed Fields:**
- `username` (required)
- `display_name`
- `bio`
- `avatar`
- `email`, `phone` (and other personal data)
- `links`
- `created_at`

**Blocked Fields (cannot be set via `/redis/write`):**
- `role` - Requires admin privileges (use admin-only endpoint if available)
- `postCount`, `followerCount`, `followingCount` - System-managed counters (auto-updated by API endpoints)

**Request:**
```json
[
  ["HSET", "user:alice", "username", "alice"],
  ["HSET", "user:alice", "display_name", "Alice Smith"],
  ["HSET", "user:alice", "bio", "Software developer and tech enthusiast"],
  ["HSET", "user:alice", "avatar", "https://example.com/avatars/alice.jpg"],
  ["HSET", "user:alice", "email", "alice@example.com"],
  ["HSET", "user:alice", "phone", "+1-555-0123"],
  ["HSET", "user:alice", "created_at", "1234567890123"]
]
```

**Full cURL Example:**
```bash
curl -X POST https://your-redis-service.com/redis/write \
  -H "X-API-Key: your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '[
    ["HSET", "user:alice", "username", "alice"],
    ["HSET", "user:alice", "display_name", "Alice Smith"],
    ["HSET", "user:alice", "bio", "Software developer"],
    ["HSET", "user:alice", "email", "alice@example.com"],
    ["HSET", "user:alice", "created_at", "1234567890123"]
  ]'
```

**Response:**
```json
{
  "results": [1, 1, 1, 1, 1],
  "username": "xano_sync"
}
```

**Important Notes:**

⚠️ **Role Management:**
- User roles (`admin`, `user`, `model`) cannot be set via `/redis/write`
- Use an admin-only endpoint for role changes (if available)
- Default role should be set during initial account creation outside Redis

⚠️ **Counter Fields:**
- `postCount`, `followerCount`, `followingCount` are system-managed
- These counters are automatically updated when using the REST API endpoints
- Do not manually set or increment these fields

### Updating a User

Update specific fields without affecting others:

**Request:**
```json
[
  ["HSET", "user:alice", "bio", "New bio from Xano"],
  ["HSET", "user:alice", "links", "https://alice.dev"],
  ["HSET", "user:alice", "phone", "+1-555-9999"]
]
```

**Important Notes:**

⚠️ **Username Must Match Key:**
- Key: `user:alice` must have `username: "alice"`
- Mismatches will cause data inconsistency

⚠️ **Username is Immutable:**
- Changing usernames requires migrating all related keys
- Pattern: `user:<username>:posts`, `user:<username>:followers`, etc.
- Use extreme caution when changing usernames

⚠️ **Denormalized Fields Require Extra Updates:**

When updating these fields, you **must** also update all user's posts:
- `username` (requires key migration)
- `display_name`
- `avatar`

**Example: Updating Display Name with Denormalization**
```json
[
  ["HSET", "user:alice", "display_name", "Alice M. Smith"],
  ["HSET", "post:post-id-1", "display_name", "Alice M. Smith"],
  ["HSET", "post:post-id-2", "display_name", "Alice M. Smith"],
  ["HSET", "post:post-id-3", "display_name", "Alice M. Smith"]
]
```

**Recommendation:** Use the `PATCH /users/:id` endpoint instead for profile updates, as it handles denormalization automatically.

## Syncing Post Data

### Creating a Post

**Recommended Method:** Use the high-level `POST /posts` endpoint to ensure proper denormalization and feed updates.

**Endpoint:** `POST /posts`

**Request with JWT Token (User-Specific):**

If you want the post to belong to a specific user, generate a JWT token for that user:

```bash
curl -X POST https://your-redis-service.com/posts \
  -H "Authorization: Bearer <jwt-token-for-alice>" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Hello world from Xano! #travel #adventure",
    "media_url": "https://example.com/images/sunset.jpg",
    "hashtags": ["travel", "adventure"]
  }'
```

**Request with API Key (Generic Sync User):**

Using API key will create the post as user `xano_sync`:

```bash
curl -X POST https://your-redis-service.com/posts \
  -H "X-API-Key: your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "System post from Xano sync",
    "media_url": "https://example.com/images/announcement.jpg",
    "hashtags": ["announcement"]
  }'
```

**What Happens Behind the Scenes:**
1. Post hash created with unique UUID
2. User data denormalized into post (username, avatar, display_name)
3. Post added to `user:<username>:posts` sorted set
4. Post added to `explore:feed` sorted set
5. Post added to `hashtag:<tag>:posts` and `hashtag:<tag>:ranked` for each hashtag
6. User's `postCount` incremented

### Alternative: Manual Post Creation

⚠️ **WARNING: Manual post creation via `/redis/write` is NOT SUPPORTED.**

The write proxy blocks the required commands for manual post creation:
- `ZADD` - Blocked (cannot add to feeds)
- `HINCRBY` on `postCount` - Blocked (system-managed field)

**You MUST use `POST /posts` endpoint for all post creation.** This ensures:
- Proper feed updates (`explore:feed`, hashtag feeds, user posts)
- Counter increments are handled correctly
- Denormalized user data is applied
- Hashtag indexing works properly

If you need to bulk-create posts from Xano, iterate and call `POST /posts` for each post.

## Syncing Relationships

### Follow Relationship

**Recommended Method:** Use the `POST /users/:username/follow` endpoint.

**Endpoint:** `POST /users/:username/follow`

**Request:**
```bash
curl -X POST https://your-redis-service.com/users/bob/follow \
  -H "Authorization: Bearer <jwt-token-for-alice>" \
  -H "Content-Type: application/json"
```

This makes `alice` follow `bob`.

**What Happens:**
1. `bob` added to `user:alice:following` set
2. `alice` added to `user:bob:followers` set
3. `user:alice:followingCount` incremented
4. `user:bob:followerCount` incremented

### Alternative: Manual Follow Sync

⚠️ **WARNING: Manual follow sync via `/redis/write` is NOT SUPPORTED.**

The write proxy blocks the required commands:
- `SADD` - Blocked (cannot modify sets)
- `HINCRBY` on counter fields - Blocked (system-managed fields)

**You MUST use `POST /users/:username/follow` endpoint.** This ensures both sides of the relationship and counters are updated correctly.

### Unfollow Relationship

**Endpoint:** `DELETE /users/:username/follow`

**Request:**
```bash
curl -X DELETE https://your-redis-service.com/users/bob/follow \
  -H "Authorization: Bearer <jwt-token-for-alice>"
```

**Manual Unfollow:**

⚠️ **NOT SUPPORTED** - Use `DELETE /users/:username/follow` endpoint instead. Manual unfollow via `/redis/write` is blocked (requires `SREM` and counter updates).

## Syncing Interactions

### Likes

**Recommended Method:** Use the `POST /posts/:id/like` endpoint.

**Endpoint:** `POST /posts/:id/like`

**Request:**
```bash
curl -X POST https://your-redis-service.com/posts/550e8400-e29b-41d4-a716-446655440000/like \
  -H "Authorization: Bearer <jwt-token-for-alice>"
```

**What Happens:**
1. `alice` added to `post:...:likes` set
2. `likesCount` incremented in post hash
3. Engagement score recalculated for ranked hashtag feeds

**Manual Like Sync:**

⚠️ **NOT SUPPORTED** - Use `POST /posts/:id/like` endpoint instead. Manual like sync via `/redis/write` is blocked (requires `SADD` and counter updates).

**Manual Unlike:**

⚠️ **NOT SUPPORTED** - Use `DELETE /posts/:id/like` endpoint instead.

### Bookmarks

**Recommended Method:** Use the `POST /posts/:id/bookmark` endpoint.

**Endpoint:** `POST /posts/:id/bookmark`

**Request:**
```bash
curl -X POST https://your-redis-service.com/posts/550e8400-e29b-41d4-a716-446655440000/bookmark \
  -H "Authorization: Bearer <jwt-token-for-alice>"
```

**What Happens:**
1. `alice` added to `post:...:bookmarks` set
2. Post added to `user:alice:bookmarked` sorted set
3. `bookmarksCount` incremented in post hash
4. Engagement score recalculated

**Manual Bookmark Sync:**

⚠️ **NOT SUPPORTED** - Use `POST /posts/:id/bookmark` endpoint instead. Manual bookmark sync via `/redis/write` is blocked (requires `SADD`, `ZADD`, and counter updates).

## Bulk Sync Strategy

### Initial Sync (Full Database)

When syncing your entire Xano database to Redis for the first time:

**Step 1: Export All Users from Xano**
- Query all users from your Xano users table
- Format data for Redis

**Step 2: Create User Hashes in Redis (Batch Requests)**
- Group users into batches of 50-100
- Send batch requests to `/redis/write`
- Include all user fields (username, email, bio, etc.)

**Example Batch:**
```json
[
  ["HSET", "user:alice", "username", "alice"],
  ["HSET", "user:alice", "email", "alice@example.com"],
  ["HSET", "user:bob", "username", "bob"],
  ["HSET", "user:bob", "email", "bob@example.com"],
  ...
]
```

**Step 3: Export All Posts from Xano**
- Query all posts from your Xano posts table
- Include user relationships (which user created each post)

**Step 4: Create Posts Using API Endpoints**
- Use `POST /posts` for each post (slower but handles denormalization)
- Or manually create via `/redis/write` (faster but requires managing relationships)

**Step 5: Export Relationships**
- Export follows from Xano (follower_id, following_id)
- Export likes from Xano (user_id, post_id)
- Export bookmarks from Xano (user_id, post_id)

**Step 6: Sync Relationships Using API Endpoints**
- Batch follow requests
- Batch like requests
- Batch bookmark requests

**Sync Order is Important:**
```
1. Users (must exist first)
2. Posts (requires user data)
3. Follows (requires users)
4. Likes/Bookmarks (requires posts and users)
```

### Incremental Sync (Changes Only)

After initial sync, only sync changes to reduce load.

**Option 1: Webhook-Based Sync (Recommended)**

Configure Xano webhooks to trigger sync on data changes:

**Xano Webhook Setup:**
1. Go to Xano workspace settings
2. Add webhook for user updates → `https://your-redis-service.com/webhooks/user-update`
3. Add webhook for post creation → `https://your-redis-service.com/webhooks/post-create`
4. Add webhook for follows → `https://your-redis-service.com/webhooks/follow`

**Webhook Handler Example:**
```javascript
// In your Xano function or external webhook handler
function handleUserUpdate(user) {
  const apiKey = env.REDIS_API_KEY;
  const redisUrl = env.REDIS_SERVICE_URL;

  const commands = [
    ["HSET", `user:${user.username}`, "bio", user.bio],
    ["HSET", `user:${user.username}`, "display_name", user.display_name],
    ["HSET", `user:${user.username}`, "avatar", user.avatar]
  ];

  fetch(`${redisUrl}/redis/write`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });
}
```

**Option 2: Polling-Based Sync**

Query Xano periodically for changed records:

1. Add `updated_at` timestamp to all Xano tables
2. Every 5-10 minutes, query: `SELECT * FROM users WHERE updated_at > last_sync_time`
3. Sync changed records to Redis
4. Update `last_sync_time`

**Cron Job Example:**
```javascript
// Run every 5 minutes
async function incrementalSync() {
  const lastSync = await getLastSyncTimestamp();
  const changedUsers = await xano.query(
    `SELECT * FROM users WHERE updated_at > ${lastSync}`
  );

  for (const user of changedUsers) {
    await syncUserToRedis(user);
  }

  await setLastSyncTimestamp(Date.now());
}
```

## Xano Function Template

Use this template as a starting point for your Xano sync functions.

### Template: Sync User to Redis

```javascript
// Xano Function: Sync User to Redis
// Trigger: After user insert/update

// Input: user object from Xano database
var user = $input.user;

// Environment variables (set in Xano workspace settings)
var apiKey = env.REDIS_API_KEY;
var redisUrl = env.REDIS_SERVICE_URL;

// Build Redis commands array
// NOTE: Exclude role and counter fields (blocked by write proxy)
var commands = [
  ["HSET", "user:" + user.username, "username", user.username],
  ["HSET", "user:" + user.username, "display_name", user.display_name || ""],
  ["HSET", "user:" + user.username, "bio", user.bio || ""],
  ["HSET", "user:" + user.username, "avatar", user.avatar || ""],
  ["HSET", "user:" + user.username, "email", user.email],
  ["HSET", "user:" + user.username, "created_at", user.created_at.toString()]
];

// NOTE: role, postCount, followerCount, and followingCount are NOT included
// These fields are blocked by the write proxy:
// - role: requires admin privileges (set outside Redis)
// - counters: system-managed (auto-updated by REST endpoints)

// Send to Redis microservice
var response = $http.post(redisUrl + "/redis/write", {
  headers: {
    "X-API-Key": apiKey,
    "Content-Type": "application/json"
  },
  body: commands
});

// Check for errors
if (response.status !== 200) {
  // Log error for debugging
  var errorLog = {
    message: "Redis sync failed",
    username: user.username,
    status: response.status,
    error: response.body
  };

  // You could insert this into an error log table in Xano
  // $table.insert('sync_errors', errorLog);

  return errorLog;
}

// Return success
return {
  success: true,
  username: user.username,
  synced_at: new Date().toISOString()
};
```

### Template: Sync Post to Redis

```javascript
// Xano Function: Sync Post to Redis
// Trigger: After post insert

var post = $input.post;
var user = $input.user; // Join user data in Xano query

var apiKey = env.REDIS_API_KEY;
var redisUrl = env.REDIS_SERVICE_URL;

// Use the high-level API endpoint for proper denormalization
var postData = {
  content: post.content,
  media_url: post.media_url || "",
  hashtags: post.hashtags || []
};

// Create JWT token for the user (if you have JWT generation in Xano)
// Or use API key (post will be created as xano_sync user)
var response = $http.post(redisUrl + "/posts", {
  headers: {
    "X-API-Key": apiKey,
    "Content-Type": "application/json"
  },
  body: postData
});

return {
  success: response.status === 201,
  post_id: response.body.post?.id
};
```

### Template: Sync Follow Relationship

⚠️ **Note:** Follow relationships CANNOT be synced via `/redis/write` (requires blocked commands: `SADD`, `HINCRBY`).

**You must use the high-level REST API endpoint instead:**

```javascript
// Xano Function: Sync Follow to Redis
// Trigger: After follow insert

var follow = $input.follow; // { follower_username, following_username }

var apiKey = env.REDIS_API_KEY;
var redisUrl = env.REDIS_SERVICE_URL;

// Use the high-level follow endpoint
// Note: This requires generating a JWT token for the follower user
// or implementing an admin-only bulk follow endpoint

// Option 1: Generate JWT for follower (recommended)
var followerToken = generateJwtToken(follow.follower_username);

var response = $http.post(redisUrl + "/users/" + follow.following_username + "/follow", {
  headers: {
    "Authorization": "Bearer " + followerToken,
    "Content-Type": "application/json"
  }
});

return {
  success: response.status === 200,
  follower: follow.follower_username,
  following: follow.following_username
};

// Option 2: Request an admin-only bulk follow endpoint from backend team
// This would bypass JWT requirements and allow API key-based follow operations
```

## Error Handling

### Common Errors and Solutions

**Error: `401 Unauthorized`**
- **Cause:** API key is missing or incorrect
- **Solution:**
  - Verify API key in Xano environment variables
  - Check header name is `X-API-Key` (case-insensitive)
  - Ensure API key matches `.env` file in Redis microservice

**Error: `403 Forbidden`**
- **Cause:** Trying to perform operation without proper permissions
- **Solution:**
  - API key should bypass all permission checks
  - Verify API key is loaded (check server logs)
  - Ensure you're using `X-API-Key` header, not `Authorization`

**Error: `ERR field cannot be modified: role`**
- **Cause:** Attempting to modify system-managed field via `/redis/write`
- **Solution:**
  - Use appropriate API endpoint instead
  - For role changes, requires admin privileges
  - For counters (postCount, etc.), use interaction endpoints

**Error: `ERR field cannot be modified: username`**
- **Cause:** Attempting to change username via `/redis/write`
- **Solution:**
  - Username changes require key migration (complex operation)
  - Usernames should be immutable in your system design
  - If absolutely necessary, contact system admin

**Error: Network timeout**
- **Cause:** Network connectivity issues or server overload
- **Solution:**
  - Check network connectivity between Xano and Redis microservice
  - Increase timeout settings in Xano HTTP request
  - Monitor Redis microservice performance
  - Consider batching smaller requests

**Error: `WRONGTYPE Operation against a key holding the wrong kind of value`**
- **Cause:** Trying to use wrong Redis command for key type
- **Solution:**
  - Verify key type (Hash, Set, Sorted Set)
  - Use correct command: HSET for hashes, SADD for sets, ZADD for sorted sets
  - See [REDIS_KEYS.md](./REDIS_KEYS.md) for key types

## Testing Your Sync

Follow these steps to test your sync implementation:

### Step 1: Sync a Test User from Xano

Create or update a test user in Xano and trigger the sync function:

```javascript
// In Xano, trigger this manually or via webhook
syncUserToRedis({
  username: "testuser",
  display_name: "Test User",
  bio: "Testing Xano sync",
  email: "test@example.com",
  role: "user"
});
```

### Step 2: Verify in Redis

Query Redis to confirm the data was synced:

```bash
curl -X POST https://your-redis-service.com/ \
  -H "X-API-Key: your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '[["HGETALL", "user:testuser"]]'
```

**Expected Response:**
```json
[{
  "username": "testuser",
  "display_name": "Test User",
  "bio": "Testing Xano sync",
  "email": "test@example.com",
  "role": "user"
}]
```

### Step 3: Test Frontend Can Access the Data

Generate a JWT token for `testuser` and query via frontend:

```javascript
const response = await fetch('https://your-redis-service.com/users/testuser', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});
const data = await response.json();
console.log(data.user); // Should show user profile
```

### Step 4: Update the User in Xano and Re-Sync

Update the bio in Xano:

```javascript
updateUserInXano("testuser", { bio: "Updated bio from Xano!" });
syncUserToRedis(updatedUser);
```

### Step 5: Verify Changes Appear in Redis

```bash
curl -X POST https://your-redis-service.com/ \
  -H "X-API-Key: your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '[["HGET", "user:testuser", "bio"]]'
```

**Expected Response:**
```json
["Updated bio from Xano!"]
```

## Best Practices

### Security

✅ **Store API key securely in Xano environment variables**
- Never hardcode API keys in functions
- Use `env.REDIS_API_KEY` to access

✅ **Use HTTPS for all requests**
- Protects API key in transit
- Prevents man-in-the-middle attacks

✅ **Rotate API keys periodically**
- Generate new keys every 3-6 months
- Update in both Xano and Redis microservice `.env`

✅ **Limit API key access**
- Only use API key from Xano backend (server-to-server)
- Never expose API key in frontend code
- Consider IP whitelisting in production

### Performance

✅ **Implement retry logic for failed syncs**
```javascript
async function syncWithRetry(syncFunction, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await syncFunction();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(1000 * (i + 1)); // Exponential backoff
    }
  }
}
```

✅ **Log all sync operations for debugging**
- Create a sync log table in Xano
- Record: timestamp, entity type, entity ID, success/failure, error message

✅ **Use batch requests to reduce network overhead**
- Group multiple HSET commands into one request
- Batch 50-100 commands per request
- Reduces HTTP round-trips

✅ **Sync in order: users → posts → relationships → interactions**
- Ensures dependencies exist before creating relationships
- Prevents "user not found" errors

### Data Integrity

✅ **Validate data before syncing**
- Check required fields are present (username, email, etc.)
- Validate data types (numbers, dates, booleans)
- Sanitize user input (remove special characters if needed)

✅ **Handle deleted records**
- When deleting a user in Xano, call DELETE endpoints in Redis
- Cascade deletions: delete user → delete all their posts → delete relationships
- Use Xano "before delete" hooks to trigger cleanup

✅ **Keep counters in sync**
- When syncing likes, ensure `likesCount` matches set cardinality
- Periodically verify counters: `SCARD post:id:likes` vs. `HGET post:id likesCount`
- Implement reconciliation job to fix discrepancies

✅ **Handle duplicate syncs gracefully**
- HSET is idempotent (safe to run multiple times)
- SADD is idempotent (adding same member twice is safe)
- ZADD with same score is idempotent
- Design sync functions to be idempotent

### Monitoring

✅ **Monitor sync success/failure rates**
- Track successful vs. failed sync operations
- Alert on high failure rates (> 5%)
- Dashboard showing sync latency and volume

✅ **Set up alerts for sync failures**
- Email/Slack notifications for critical failures
- Alert when sync lag exceeds threshold (e.g., > 5 minutes)

✅ **Keep a sync audit log in Xano**
- Table: `sync_logs`
- Columns: `id`, `timestamp`, `entity_type`, `entity_id`, `success`, `error_message`, `duration_ms`
- Retention: 30-90 days

✅ **Test sync in staging before production**
- Separate staging Redis instance
- Test bulk sync with production-like data volume
- Verify performance and data integrity

## Monitoring & Troubleshooting

### Logging

**Check Redis Microservice Logs:**
```bash
# If using PM2
pm2 logs redis-microservice

# If using Docker
docker logs redis-microservice-container

# Look for API key authentication logs
grep "API key" logs/app.log
```

**Enable Debug Logging:**

Add to `.env`:
```
LOG_LEVEL=debug
```

### Metrics to Monitor

**Sync Performance:**
- Sync duration (time to sync one entity)
- Sync throughput (entities synced per second)
- Sync lag (time between Xano update and Redis sync)

**Error Rates:**
- Failed syncs per hour
- 401/403 authentication errors
- Network timeout errors
- Redis command errors

**Data Consistency:**
- User count: Xano vs. Redis
- Post count: Xano vs. Redis
- Follow relationship count: Xano vs. Redis

### Troubleshooting Checklist

**Sync Not Working:**
- [ ] Verify API key is correct in both Xano and Redis `.env`
- [ ] Check Redis microservice is running (`curl https://your-redis-service.com/health`)
- [ ] Verify network connectivity from Xano to Redis microservice
- [ ] Check Xano function logs for errors
- [ ] Confirm HTTPS is working (certificate valid)

**Slow Sync Performance:**
- [ ] Reduce batch size (fewer commands per request)
- [ ] Increase Xano HTTP timeout settings
- [ ] Check Redis Cloud performance metrics
- [ ] Consider horizontal scaling (multiple sync workers)

**Data Inconsistencies:**
- [ ] Run data reconciliation script
- [ ] Check for race conditions (simultaneous updates)
- [ ] Verify sync order (users before posts, etc.)
- [ ] Review denormalization logic

---

**See Also:**
- [REDIS_KEYS.md](./REDIS_KEYS.md) - Complete Redis key structure reference
- [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md) - Frontend integration with JWT
- [README.md](../README.md) - Main project documentation
