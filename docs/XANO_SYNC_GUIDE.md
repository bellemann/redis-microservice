# Xano Synchronization Guide

A comprehensive guide for syncing data from Xano (your source of truth) to Redis (your cache layer) using API key authentication.

## ⚠️ Important: API Key Required for Redis Proxy

**Redis proxy endpoints require API key authentication and are only available for backend synchronization.**

- ✅ API key grants admin-level access to Redis proxy endpoints
- ❌ JWT tokens will be rejected with 403 Forbidden error
- 🔒 Frontend clients cannot access Redis proxy - they must use REST endpoints

This guide is for backend synchronization (Xano → Redis) only. For frontend integration, see [Frontend Guide](FRONTEND_GUIDE.md).

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

**Authentication Model:**
- Backend sync (Xano) uses API key for Redis proxy access
- Frontend clients use JWT for REST endpoint access
- API key bypasses ownership checks for bulk operations

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

### Step 3: Store in Xano Environment Variables

Add the API key to your Xano environment variables:

1. Go to Xano Dashboard → Settings → Environment Variables
2. Add new variable: `REDIS_API_KEY`
3. Value: Your generated API key
4. Click Save

🔒 **Security Best Practices:**
- Never expose API key in frontend code or public repositories
- Store securely in Xano environment variables
- Rotate API key periodically (every 90 days recommended)
- Monitor API key usage for suspicious activity
- Use HTTPS only to prevent man-in-the-middle attacks

## Authentication: Using the API Key

### API Key Header

API key must be included in the `X-API-Key` header for all Redis proxy requests:

**Correct:**
```bash
curl -X POST https://your-redis-service.com/ \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[["HGETALL", "user:alice"]]'
```

**Incorrect (JWT will be rejected):**
```bash
# ❌ This will return 403 Forbidden
curl -X POST https://your-redis-service.com/ \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[["HGETALL", "user:alice"]]'
```

### Error Responses

**403 Forbidden - JWT Not Allowed:**
```json
{
  "error": "Redis proxy access requires API key authentication",
  "message": "Frontend clients should use REST endpoints instead",
  "availableEndpoints": [
    "GET /users/:id - Get user profile",
    "PATCH /users/:id - Update profile",
    ...
  ],
  "documentation": "See docs/FRONTEND_GUIDE.md for frontend integration"
}
```

**401 Unauthorized - Invalid API Key:**
```json
{
  "error": "Missing token"
}
```

### Xano Function Example

```javascript
// Get API key from environment variables
const apiKey = env.REDIS_API_KEY;

// Make request to Redis microservice
const response = await $fetch('https://your-redis-service.com/redis/write', {
  method: 'POST',
  headers: {
    'X-API-Key': apiKey,  // API key is REQUIRED - JWT tokens will be rejected
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ['HSET', 'user:alice', 'bio', 'Updated from Xano'],
    ['HSET', 'user:alice', 'email', 'alice@example.com']
  ])
});

// Handle errors
if (response.status === 403) {
  throw new Error('API key required for Redis proxy access');
}

return response.json();
```

## Redis Proxy Endpoints

### Read Proxy: `POST /`

Read-only Redis proxy for querying data (API key only).

**Endpoint:** `POST /`

**Authentication:** X-API-Key header (required)

**Request Body:** Array of Redis commands

**Example:**
```json
[
  ["HGETALL", "user:alice"],
  ["SMEMBERS", "user:alice:followers"],
  ["ZREVRANGE", "user:alice:posts", "0", "9"]
]
```

**Response:**
```json
[
  { "username": "alice", "bio": "...", ... },
  ["bob", "charlie", "david"],
  ["post-123", "post-124", "post-125"]
]
```

**Allowed Commands:**
- `HGETALL`, `HGET`, `HMGET` - Get hash fields
- `SMEMBERS`, `SISMEMBER` - Get set members
- `ZRANGE`, `ZREVRANGE`, `ZCARD` - Get sorted set members
- `GET`, `MGET` - Get string values
- `EXISTS` - Check key existence
- `TTL` - Check key expiration
- `TYPE` - Get key type

**Blocked Commands:**
- All write operations (SET, HSET, DEL, etc.)

### Write Proxy: `POST /redis/write`

Write-enabled Redis proxy for syncing data (API key only).

**Endpoint:** `POST /redis/write`

**Authentication:** X-API-Key header (required)

**Request Body:** Array of Redis commands (supports both single-command and multi-command formats)

**Example (Single command - Upstash-style):**
```json
["HSET", "user:alice", "bio", "Updated bio"]
```

**Example (Multiple commands - Traditional):**
```json
[
  ["HSET", "user:alice", "bio", "Updated bio"],
  ["HSET", "user:alice", "email", "alice@example.com"]
]
```

**Example (Multi-field HSET - Efficient, Recommended):**
```json
[
  [
    "HSET", "user:alice",
    "bio", "Updated bio",
    "email", "alice@example.com",
    "phone", "+1-555-0123"
  ]
]
```

**Note:** Both single-command format (`["HSET", ...]`) and array-of-commands format (`[["HSET", ...]]`) are supported for Upstash compatibility.

**Response (Single-field):**
```json
{
  "results": [1, 1],
  "username": "xano_sync"
}
```

**Response (Multi-field):**
```json
{
  "results": [3],
  "username": "xano_sync"
}
```
Note: Multi-field HSET returns the number of fields set (e.g., 3 fields = result of 3)

**Allowed Commands:**
- `HSET` - Set one or more hash fields (supports multiple field-value pairs for efficiency)
- `HDEL` - Delete hash field
- `HINCRBY` - Increment hash field (API key sync can increment count fields: `followerCount`, `followingCount`, `postCount`)

**Blocked Fields (for data consistency):**
- `username` - Immutable (used as primary key)
- `display_name` - Requires denormalization to posts
- `avatar` - Requires denormalization to posts
- `role` - System-managed
- `postCount` - System-managed (exception: API key sync can use `HINCRBY` to increment)
- `followerCount` - System-managed (exception: API key sync can use `HINCRBY` to increment)
- `followingCount` - System-managed (exception: API key sync can use `HINCRBY` to increment)

**Important Notes:**
- API key bypasses ownership checks (can modify any user's data)
- Field restrictions still apply for data consistency
- Use explicit usernames (`user:alice`) instead of placeholders
- Batch multiple operations for better performance
- **HSET supports multiple field-value pairs in a single command** (Upstash-style) for better efficiency

## Efficient HSET Syntax (Upstash-Style)

Redis HSET command supports setting multiple field-value pairs in a single operation, which is significantly more efficient than sending multiple HSET commands.

**Syntax Comparison:**

```javascript
// ❌ Inefficient: Multiple commands
[
  ["HSET", "user:alice", "bio", "Software developer"],
  ["HSET", "user:alice", "email", "alice@example.com"],
  ["HSET", "user:alice", "phone", "+1-555-0123"]
]
// 3 Redis commands, 3 network round trips

// ✅ Efficient: Single command with multiple fields
[
  [
    "HSET", "user:alice",
    "bio", "Software developer",
    "email", "alice@example.com",
    "phone", "+1-555-0123"
  ]
]
// 1 Redis command, 1 network round trip, atomic operation
```

**Benefits:**
- ✅ Fewer network round trips (faster)
- ✅ Fewer Redis operations (better performance)
- ✅ Atomic operation (all fields set together or none)
- ✅ Reduced request body size (less overhead)
- ✅ Easier to read and maintain

**Field Validation:**
- All field names are validated - if any blocked field is included, the entire command is rejected
- Blocked fields: `username`, `display_name`, `avatar`, `role`, `postCount`, `followerCount`, `followingCount`

## Syncing User Data

### Sync User Profile

When a user is created or updated in Xano, sync their profile to Redis:

**Xano Function Stack (Efficient - Recommended):**
```javascript
// Triggered by: User table update/insert

const apiKey = env.REDIS_API_KEY;
const username = user.username;

// Sync user hash to Redis using efficient single HSET command
const response = await $fetch('https://your-redis-service.com/redis/write', {
  method: 'POST',
  headers: {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    [
      'HSET', `user:${username}`,
      'username', user.username,
      'display_name', user.display_name,
      'bio', user.bio || '',
      'avatar', user.avatar || '',
      'email', user.email || '',
      'phone', user.phone || '',
      'links', user.links || '',
      'role', user.role,
      'created_at', user.created_at
    ]
  ])
});

return response.json();

// Performance: 1 Redis command instead of 9
// Result: 9x reduction in Redis operations and network overhead
```

### Batch Sync Multiple Users

For initial data load or bulk updates, sync multiple users in one request:

```javascript
const apiKey = env.REDIS_API_KEY;
const users = await $db.users.getAll(); // Your Xano query

// Build batch commands (one HSET per user with all fields)
const commands = [];
users.forEach(user => {
  commands.push([
    'HSET', `user:${user.username}`,
    'username', user.username,
    'display_name', user.display_name,
    'bio', user.bio || '',
    'avatar', user.avatar || '',
    'email', user.email || '',
    'phone', user.phone || '',
    'links', user.links || '',
    'role', user.role,
    'created_at', user.created_at
  ]);
});

// Send batch request (process in chunks of 50-100 users for large datasets)
// Note: Each user is now a single HSET command with multiple fields
const chunkSize = 50;
for (let i = 0; i < commands.length; i += chunkSize) {
  const chunk = commands.slice(i, i + chunkSize);

  await $fetch('https://your-redis-service.com/redis/write', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(chunk)
  });
}

// Performance: If syncing 100 users with 9 fields each:
// - Old way: 900 Redis commands
// - New way: 100 Redis commands
// Result: 9x reduction in operations
```

### Sync Relationships

Sync follower/following relationships:

```javascript
// When user A follows user B
const apiKey = env.REDIS_API_KEY;

await $fetch('https://your-redis-service.com/redis/write', {
  method: 'POST',
  headers: {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    // Add to user A's following set
    ['SADD', `user:${userA}:following`, userB],
    // Add to user B's followers set
    ['SADD', `user:${userB}:followers`, userA],
    // Increment follower/following counts
    ['HINCRBY', `user:${userA}`, 'followingCount', '1'],
    ['HINCRBY', `user:${userB}`, 'followerCount', '1']
  ])
});
```

**Note:** Incrementing `followerCount` and `followingCount` via API key is allowed for sync operations, but these fields are blocked for direct modification via REST endpoints.

### Sync Posts

Sync posts to Redis for feed queries:

```javascript
// When a post is created
const apiKey = env.REDIS_API_KEY;
const postId = `post-${generateUUID()}`;
const timestamp = Date.now();

await $fetch('https://your-redis-service.com/redis/write', {
  method: 'POST',
  headers: {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    // Update user profile fields
    [
      'HSET', `user:${post.username}`,
      'postCount', postCount.toString(),
      'lastPostAt', timestamp.toString()
    ]
  ])
});
```

**Note:** The Redis write proxy is scoped to `user:*` keys only for security. Post creation and feed management should use dedicated REST endpoints (`POST /posts`) which handle proper validation, denormalization, and feed updates.

## Use `user:me` Placeholder?

The `user:me` placeholder resolves to the authenticated username:
- **With JWT:** `user:me` → `user:alice` (from JWT username field)
- **With API key:** `user:me` → `user:xano_sync` (special sync user)

**Recommendation for Sync Operations:**
Use explicit usernames (`user:alice`) instead of `user:me` for clarity:

```javascript
// ✅ Recommended: Explicit username
['HSET', `user:${username}`, 'bio', 'New bio']

// ⚠️ Works but unclear: Placeholder resolves to 'xano_sync'
['HSET', 'user:me', 'bio', 'New bio']
```

The placeholder is primarily useful for REST endpoints where the user is determined by the JWT token.

## API Key vs JWT Authentication

| Feature | API Key | JWT Token |
|---------|---------|----------|
| **Redis Proxy Access** | ✅ Allowed | ❌ Blocked (403) |
| **REST Endpoints** | ✅ Allowed (admin) | ✅ Allowed (user) |
| **Ownership Checks** | ⚠️ Bypassed | ✅ Enforced |
| **Use Case** | Backend sync (Xano) | Frontend clients |
| **Access Level** | Admin (all data) | User (own data only) |
| **Security** | Must be kept secret | Can be short-lived |
| **Field Restrictions** | ✅ Applied | ✅ Applied |

**When to use API Key:**
- Syncing data from Xano to Redis
- Bulk operations on multiple users
- Backend-to-backend communication
- Initial data load / migration

**When to use JWT:**
- Frontend client requests
- User-specific operations (like, follow, etc.)
- REST endpoint access from web/mobile apps
- Real-time user interactions

## Error Handling

### Common Errors

**403 Forbidden - JWT Not Allowed:**
```json
{
  "error": "Redis proxy access requires API key authentication"
}
```
**Solution:** Use X-API-Key header instead of Authorization header

**401 Unauthorized - Invalid API Key:**
```json
{
  "error": "Missing token"
}
```
**Solution:** Check that API key matches the one in `.env` file

**Field Restriction Error:**
```json
{
  "results": ["ERR field 'username' cannot be modified directly, use PATCH /users/:id"]
}
```
**Solution:** Username, display_name, avatar, and system-managed fields have restrictions

**Network Error:**
```
Failed to fetch
```
**Solution:** Check network connectivity, HTTPS certificate, firewall rules

### Xano Error Handling Example

```javascript
const apiKey = env.REDIS_API_KEY;

try {
  const response = await $fetch('https://your-redis-service.com/redis/write', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([
      ['HSET', 'user:alice', 'bio', 'New bio']
    ])
  });

  if (response.status === 403) {
    throw new Error('API key required for Redis proxy access');
  }

  if (response.status === 401) {
    throw new Error('Invalid API key');
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  // Check individual command results
  data.results.forEach((result, index) => {
    if (typeof result === 'string' && result.startsWith('ERR')) {
      console.error(`Command ${index} failed: ${result}`);
    }
  });

  return data;
} catch (error) {
  console.error('Redis sync failed:', error);
  throw error;
}
```

## Testing Your Sync

### Step 1: Test API Key Authentication

```bash
# Test with valid API key (should succeed)
curl -X POST https://your-redis-service.com/ \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[["HGETALL", "user:alice"]]'

# Test with JWT (should fail with 403)
curl -X POST https://your-redis-service.com/ \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[["HGETALL", "user:alice"]]'
```

### Step 2: Sync Test User

```bash
# Efficient: All fields in one HSET command
curl -X POST https://your-redis-service.com/redis/write \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[[
    "HSET", "user:testuser",
    "username", "testuser",
    "display_name", "Test User",
    "bio", "Test bio from sync",
    "role", "user"
  ]]'
```

### Step 3: Verify Sync via REST Endpoint

```bash
# Verify data is accessible via REST endpoint (with JWT)
curl https://your-redis-service.com/users/testuser \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

This demonstrates the security model:
1. API key syncs data to Redis (write access)
2. JWT accesses data via REST endpoints (read access with authorization)
3. Frontend cannot access Redis proxy directly

## Best Practices

### Security

1. **Never use JWT for Redis proxy** - It will be rejected with 403 error
2. **Rotate API key periodically** - Every 90 days recommended
3. **Monitor API key usage** - Track requests for suspicious activity
4. **Use HTTPS only** - Prevent man-in-the-middle attacks
5. **Store API key securely** - Environment variables only, never in code

### Performance

1. **Use explicit usernames** - `user:alice` instead of `user:me` for clarity
2. **Batch operations** - Combine multiple commands in one request to reduce overhead
3. **Chunk large datasets** - Process in batches of 100-1000 commands
4. **Avoid redundant syncs** - Only sync when data changes, not on every read
5. **Use Redis pipelines** - The API automatically pipelines multiple commands

### Data Consistency

1. **Sync immediately on changes** - Update Redis when Xano data changes
2. **Validate data** - Check for required fields before syncing
3. **Handle errors gracefully** - Retry failed syncs with exponential backoff
4. **Monitor sync health** - Track success/failure rates
5. **Respect field restrictions** - Don't try to modify blocked fields

### Sync Triggers

Set up Xano triggers to automatically sync data:

```javascript
// On user table insert/update
afterSave: async (user) => {
  await syncUserToRedis(user);
}

// On follow relationship insert
afterSave: async (follow) => {
  await syncFollowToRedis(follow.follower_id, follow.following_id);
}

// On post insert
afterSave: async (post) => {
  await syncPostToRedis(post);
}
```

## Migration from JWT to API Key

If you were using JWT for sync operations, update your code:

### Before (JWT - No Longer Works)
```javascript
// ❌ This will return 403 Forbidden
await $fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([['HGETALL', 'user:alice']])
});
```

### After (API Key - Correct)
```javascript
// ✅ Use API key instead
await $fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'X-API-Key': env.REDIS_API_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([['HGETALL', 'user:alice']])
});
```

### Migration Checklist

- [ ] Generate API key using `openssl rand -hex 32`
- [ ] Add API key to `.env` file as `XANO_API_KEY`
- [ ] Add API key to Xano environment variables
- [ ] Update all Xano functions to use `X-API-Key` header
- [ ] Remove `Authorization: Bearer` headers from sync functions
- [ ] Replace `user:AUTH` and `user:me` with explicit usernames
- [ ] Test sync operations with API key
- [ ] Remove JWT token generation for sync operations
- [ ] Update error handling for 403 responses

## Complete Xano Integration Example

```javascript
// Xano Function: Sync User to Redis
async function syncUserToRedis(user) {
  const apiKey = env.REDIS_API_KEY;
  const redisUrl = env.REDIS_MICROSERVICE_URL;

  try {
    // Prepare efficient HSET command with all fields
    // Using single HSET with multiple field-value pairs for efficiency
    const commands = [
      [
        'HSET', `user:${user.username}`,
        'username', user.username,
        'display_name', user.display_name,
        'bio', user.bio || '',
        'avatar', user.avatar || '',
        'email', user.email || '',
        'phone', user.phone || '',
        'links', user.links || '',
        'role', user.role,
        'created_at', user.created_at,
        'postCount', user.post_count.toString(),
        'followerCount', user.follower_count.toString(),
        'followingCount', user.following_count.toString()
      ]
    ];

    // Send to Redis microservice
    const response = await $fetch(`${redisUrl}/redis/write`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commands)
    });

    // Validate response
    if (response.status === 403) {
      throw new Error('API key required for Redis proxy access');
    }

    if (!response.ok) {
      throw new Error(`Redis sync failed: ${response.status}`);
    }

    const data = await response.json();

    // Log success
    console.log(`✅ Synced user ${user.username} to Redis`);

    return {
      success: true,
      results: data.results,
      username: user.username
    };
  } catch (error) {
    console.error(`❌ Failed to sync user ${user.username}:`, error);

    // Don't fail the Xano operation if sync fails
    // Redis is a cache layer, not source of truth
    return {
      success: false,
      error: error.message,
      username: user.username
    };
  }
}
```

## Monitoring and Debugging

### Check Redis Data

Use the read proxy to verify synced data:

```bash
curl -X POST https://your-redis-service.com/ \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '[["HGETALL", "user:alice"]]'
```

### Common Issues

1. **403 Forbidden Error**
   - Cause: Using JWT instead of API key
   - Solution: Change `Authorization: Bearer` to `X-API-Key`

2. **401 Unauthorized Error**
   - Cause: Invalid or missing API key
   - Solution: Verify API key matches `.env` file

3. **Field Restriction Error**
   - Cause: Trying to modify blocked fields
   - Solution: Use allowed fields or REST endpoints for denormalization

4. **Network Timeout**
   - Cause: Slow network or large batch
   - Solution: Reduce batch size, increase timeout

5. **Data Not Appearing**
   - Cause: Sync failed silently
   - Solution: Check error handling, verify commands

## See Also

- [Frontend Guide](FRONTEND_GUIDE.md) - REST API for frontend developers (JWT authentication)
- [Redis Keys Documentation](REDIS_KEYS.md) - Understanding Redis data structure
- [Main README](../README.md) - Full API reference and deployment guide

**Remember:**
- API key is for backend sync (Xano → Redis) only
- Frontend clients use JWT for REST endpoints only
- Redis proxy requires API key - JWT will be rejected with 403
