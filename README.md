# Redis Microservice

A secure Redis-backed social media API with JWT-based authentication, denormalized data structures, and comprehensive feed/interaction endpoints.

## Quick Links

📚 **[Redis Key Structure Reference](./docs/REDIS_KEYS.md)** - Complete guide to all Redis keys, data types, and relationships

🔄 **[Xano Sync Guide](./docs/XANO_SYNC_GUIDE.md)** - Step-by-step guide for syncing data from Xano to Redis

💻 **[Frontend Integration Guide](./docs/FRONTEND_GUIDE.md)** - Guide for frontend developers using JWT authentication

🔒 **[TLS Setup Guide](./docs/TLS_SETUP.md)** - Certificate generation and TLS configuration

☁️ **[Redis Cloud TLS Guide](./docs/REDIS_CLOUD_TLS.md)** - Connecting to Redis Cloud with TLS

## Overview

This microservice provides a comprehensive social media backend with:

- **JWT Authentication**: Secure endpoint access with JWT tokens and role-based authorization
- **Post Management**: Create, delete, like, bookmark posts with denormalized user data
- **User Management**: Follow/unfollow, profile updates with automatic denormalization
- **Feed Endpoints**: Explore, following, hashtag (chronological & ranked) feeds
- **Search Functionality**: User search by role, top posts by hashtag, top models by engagement
- **Privacy Controls**: Automatic user data sanitization based on viewer relationship
- **Interaction Tracking**: isLiked/isBookmarked flags on all feed responses
- **Multi-Layer Caching**: Post, user, and feed caching for optimal performance
- **Time-Decayed Ranking**: Engagement-based scoring with 2-week TTL for trending content

## Quick Start

**For Frontend Developers:** Get started with JWT authentication and the `user:me` placeholder → [Frontend Integration Guide](./docs/FRONTEND_GUIDE.md)

**For Backend/Xano Sync:** Learn how to sync data from Xano to Redis using API key authentication → [Xano Sync Guide](./docs/XANO_SYNC_GUIDE.md)

**For Understanding Redis Keys:** Explore the complete Redis key structure and relationships → [Redis Key Structure Reference](./docs/REDIS_KEYS.md)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
cp .env.example .env
```

3. Edit `.env` with your configuration:
```
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key-here
XANO_API_KEY=your-xano-api-key-here
PORT=3000
```

**Generate a secure API key with:**
```bash
openssl rand -hex 32
```

**Note:** The API key is for server-to-server communication (Xano sync). See [Xano Sync Guide](./docs/XANO_SYNC_GUIDE.md) for detailed setup.

## Available Routes

### Public Routes (No Authentication Required)

- **`GET /`** - Welcome message and service info
- **`GET /ping`** - Simple health check, returns "pong"
- **`GET /healthz`** - Health status check
- **`GET /feed/explore`** - Explore feed (public posts, paginated)

### Protected Routes (JWT Authentication Required)

#### Post Endpoints
- **`POST /posts`** - Create a new post with denormalized user data
- **`DELETE /posts/:id`** - Delete a post (owner or admin)
- **`POST /posts/:id/like`** - Like a post
- **`DELETE /posts/:id/like`** - Unlike a post
- **`POST /posts/:id/bookmark`** - Bookmark a post
- **`DELETE /posts/:id/bookmark`** - Remove bookmark from a post
- **`PATCH /posts/:id/ban`** - Ban a post (admin only)

#### User Endpoints

**Note:** The `:id` parameter is a username (not UUID). You can use `me` as the `:id` parameter to reference yourself (e.g., `/users/me`, `/users/me/bookmarked`).

- **`GET /users/:id`** - Get user profile with privacy controls
- **`PATCH /users/:id`** - Update user profile (self only)
- **`DELETE /users/:id`** - Delete user account with cascading cleanup (self or admin)
- **`POST /users/:id/follow`** - Follow a user
- **`DELETE /users/:id/follow`** - Unfollow a user
- **`GET /users/:id/bookmarked`** - Get user's bookmarked posts (self only)

#### Feed Endpoints
- **`GET /feed/following`** - Following feed (posts from followed users, paginated)
- **`GET /feed/hashtag/:id`** - Hashtag feed (chronological order)
- **`GET /feed/hashtag/:id/ranked`** - Hashtag feed (engagement-ranked with time decay)

#### Search Endpoints
- **`GET /search/users/newest`** - Get newest users by role (user/model)
- **`GET /search/hashtags/top-posts`** - Get top posts from multiple hashtags
- **`GET /search/models/top`** - Get top models by engagement score

#### Utility Endpoints
- **`POST /`** - Redis proxy endpoint for executing read-only Redis commands
- **`POST /redis/write`** - Write-enabled Redis proxy for safe user data modifications
- **`GET/POST /whoami`** - Returns the decoded JWT payload
- **`GET/POST /debug-auth`** - Tests Redis key resolution with placeholder replacement

## JWT Authentication

All protected routes require a valid JWT token. The token can be provided in three ways:

1. **Authorization header** (recommended):
   ```
   Authorization: Bearer <token>
   ```

2. **x-authorization header**:
   ```
   x-authorization: <token>
   ```

3. **x-access-token header**:
   ```
   x-access-token: <token>
   ```

### JWT Payload Requirements

The JWT token must contain `user_id`, `username`, and `role` fields:
```json
{
  "user_id": "123",
  "username": "alice",
  "role": "user",
  "iat": 1234567890,
  "exp": 1234568790
}
```

**Required Fields:**
- `user_id` - Legacy identifier (kept for backward compatibility)
- `username` - **Username of the user (immutable, used as primary key)**
- `role` - User role, must be one of: `admin`, `user`, or `model`

**Note:** The `username` field is the primary identifier for users in Redis. User keys use the pattern `user:<username>` instead of `user:<uuid>`.

The token must be signed with the `JWT_SECRET` configured in your `.env` file.

**Token Expiration:** Tokens expire after 900 seconds (15 minutes). The service automatically validates the expiration time.

**Role Validation:** If the `role` field is missing or contains an invalid value, authentication will fail with a 401 error.

### API Key Authentication (Xano Sync)

For server-to-server communication, the service supports API key authentication as an alternative to JWT tokens.

**Header Format:**
```
X-API-Key: your-api-key-here
```

**Key Features:**
- Grants admin-level access and bypasses JWT authentication
- Bypasses ownership checks on writes (can modify any user data via `/redis/write`)
- GET endpoints still apply privacy sanitization (sensitive fields removed) unless viewing own profile
- Used primarily for Xano synchronization operations
- Should never be exposed in frontend code

**Security Warning:** Keep the API key secret. Only use it from trusted backend services.

For detailed setup and usage, see [Xano Sync Guide](./docs/XANO_SYNC_GUIDE.md).

## Placeholder Replacement (`user:AUTH` and `user:me`)

The service automatically replaces `user:AUTH` and `user:me` placeholders with `user:<username>` in Redis commands, where `<username>` is extracted from the JWT token.

**Both Placeholders Supported:**
- `user:me` - Recommended (more intuitive, follows REST conventions)
- `user:AUTH` - Alternative (legacy support)

**Examples:**
- Request: `[["GET", "user:me:following"]]` or `[["GET", "user:AUTH:following"]]`
- Resolves to: `["GET", "user:alice:following"]` (if username is "alice")

**Note:** `user:me` is recommended for frontend developers as it's more intuitive and follows common REST API patterns (similar to `/users/me` endpoints).

Both placeholders resolve to `user:<username>` from your JWT token, allowing clients to query their own data without hardcoding their username.

## User Profile Endpoint

### GET /users/:id

Retrieves a user profile by ID with automatic privacy controls. Sensitive fields are automatically filtered based on the relationship between the authenticated user and the requested profile.

**Authentication:** Requires JWT token.

**URL Parameters:**
- `id` - Username to retrieve (e.g., 'alice', not UUID). You can also use `me` as a shortcut to get your own profile.

**Privacy Controls:**
- When viewing **your own profile** (`id` matches authenticated `user_id`): All fields are returned
- When viewing **other users' profiles**: Sensitive fields are automatically removed

**Sensitive Fields (removed for other users):**
- `first_name`, `last_name`
- `email`, `phone`, `phone_number`
- `address`, `date_of_birth`, `birth_date`
- `password`, `password_hash`
- `ssn`, `credit_card`, `bank_account`
- `ip_address`, `device_id`

**Response Format:**
```json
{
  "user": {
    "uuid": "user-uuid-123",
    "username": "johndoe",
    "display_name": "John Doe",
    "bio": "Software developer",
    "avatar": "https://example.com/avatar.jpg"
  }
}
```

**Caching:** Results are cached for 300 seconds (5 minutes) with viewer-specific cache keys to ensure privacy.

**Status Codes:**
- `200 OK` - User found and returned
- `404 Not Found` - User does not exist
- `401 Unauthorized` - Invalid or missing JWT token
- `500 Internal Server Error` - Server error

**Example Requests:**
```bash
# Get your own profile (all fields visible) - using 'me' shortcut
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/users/me

# Get your own profile (using username)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/users/alice

# Get another user's profile (sensitive fields removed)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/users/bob
```

**Example Response (Own Profile):**
```json
{
  "user": {
    "uuid": "123",
    "username": "johndoe",
    "display_name": "John Doe",
    "email": "john@example.com",
    "phone": "+1234567890",
    "bio": "Software developer",
    "created_at": "2025-01-01T00:00:00Z"
  }
}
```

**Example Response (Other User's Profile):**
```json
{
  "user": {
    "uuid": "456",
    "username": "janedoe",
    "display_name": "Jane Doe",
    "bio": "Designer",
    "created_at": "2025-01-01T00:00:00Z"
  }
}
```
*Note: `email` and `phone` fields are removed for privacy*

## Feed Endpoints

The service provides two feed endpoints for retrieving posts with user data.

**Privacy & Data Sanitization:**
When viewing other users' profiles, sensitive fields are automatically removed for privacy protection. The following fields are only visible when viewing your own profile:
- `first_name`, `last_name`
- `email`, `phone`, `phone_number`
- `address`, `date_of_birth`, `birth_date`
- `password`, `password_hash`
- Other sensitive PII fields

Public fields (like `username`, `display_name`, `bio`, `avatar`, etc.) remain visible for all users.

### GET /feed/explore

Returns posts from the global `explore:feed` sorted set (newest first).

**Authentication:** None required - this is a public endpoint.

**Query Parameters:**
- `offset` (optional, default: 0) - Pagination offset
- `limit` (optional, default: 20, max: 100) - Number of posts to return
- `includeUser` (optional, default: true) - Include user data with posts. Set to `false` to return only post data without user information

**Response Format:**
```json
{
  "posts": [
    {
      "post": {
        "uuid": "post-uuid-123",
        "user_id": "user-uuid-456",
        "content": "Example post content",
        "created_at": "2025-11-02T10:30:00Z"
      },
      "user": {
        "uuid": "user-uuid-456",
        "username": "johndoe",
        "display_name": "John Doe"
      }
    }
  ],
  "pagination": {
    "offset": 0,
    "limit": 20,
    "count": 15
  }
}
```

**Caching:** Results are cached for 30 seconds to improve performance.

**Pagination Buffer:** Automatically fetches additional posts to ensure full pages even when some posts/users are missing.

**Example Request:**
```bash
# With user data (default)
curl "http://localhost:3000/feed/explore?offset=0&limit=10"

# Without user data (faster, less data)
curl "http://localhost:3000/feed/explore?offset=0&limit=10&includeUser=false"
```

### GET /feed/following

Returns posts from users that the authenticated user follows, sorted by date (newest first).

**Authentication:** Requires JWT token. The `user_id` is extracted from the token to determine which users are followed.

**Query Parameters:**
- `offset` (optional, default: 0) - Pagination offset
- `limit` (optional, default: 20, max: 100) - Number of posts to return
- `includeUser` (optional, default: true) - Include user data with posts. Set to `false` to return only post data without user information

**Response Format:**
```json
{
  "posts": [
    {
      "post": {
        "uuid": "post-uuid-123",
        "user_id": "user-uuid-456",
        "content": "Example post content",
        "created_at": "2025-11-02T10:30:00Z"
      },
      "user": {
        "uuid": "user-uuid-456",
        "username": "johndoe",
        "display_name": "John Doe"
      }
    }
  ],
  "pagination": {
    "offset": 0,
    "limit": 20,
    "count": 15
  }
}
```

**Caching:** Results are cached for 30 seconds per user (user-specific cache).

**Pagination Buffer:** Automatically fetches additional posts to ensure full pages even when some posts/users are missing.

**Optimization:** Uses Redis `ZUNIONSTORE` to efficiently merge posts from all followed users. The system aggregates posts from all `user:<username>:posts` sorted sets, with fallback to `explore:feed` filtering if user post structures are not available.

**Example Request:**
```bash
# With user data (default)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  "http://localhost:3000/feed/following?offset=0&limit=10"

# Without user data (faster, less data)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  "http://localhost:3000/feed/following?offset=0&limit=10&includeUser=false"
```

## API Endpoint Details

### Post Management

#### POST /posts
Create a new post with denormalized user data (username, avatar, display_name).

**Request Body:**
```json
{
  "content": "This is my post #hashtag",
  "media_url": "https://example.com/image.jpg",
  "hashtags": ["hashtag", "trending"]
}
```

**Response:** Created post object with denormalized user data.

**Side Effects:**
- Adds to `explore:feed`, `user:<username>:posts`, and `hashtag:{id}:posts` sorted sets
- Increments user's `postCount`
- Initializes `hashtag:{id}:ranked` with score 0

#### DELETE /posts/:id
Delete a post (owner or admin only).

**Authorization:** Owner or admin role required.

**Side Effects:**
- Removes from all feeds
- Deletes `post:{id}:likes`, `post:{id}:bookmarks`, `post:{id}:comments` sets
- Decrements user's `postCount`

#### POST /posts/:id/like
Like a post.

**Side Effects:**
- Adds user to `post:{id}:likes` set
- Increments `likesCount` on post
- Updates `hashtag:{id}:ranked` scores with time-decayed formula
- Increments `models:top:engagement` if post owner is a model

**Ranking Formula:**
```
score = (likes*3 + comments*5 + bookmarks*4) / ((current_time - created_at) / 3600 + 1)
```

Posts older than 2 weeks get score = 0.

#### POST /posts/:id/bookmark
Bookmark a post.

**Side Effects:**
- Adds user to `post:{id}:bookmarks` set
- Adds post to `user:<username>:bookmarked` sorted set
- Increments `bookmarksCount` on post
- Updates ranked feeds

#### PATCH /posts/:id/ban
Ban a post (admin only).

**Authorization:** Admin role required.

**Side Effects:**
- Marks post with `banned: true`, `banned_at`, `banned_by` fields
- Removes from all feeds
- Deletes interaction sets
- Post hash remains for audit trail

### User Management

#### PATCH /users/:id
Update user profile (username, display_name, bio, avatar, links).

**Authorization:** Self only.

**Request Body:**
```json
{
  "username": "newusername",
  "display_name": "New Name",
  "bio": "Updated bio",
  "avatar": "https://example.com/avatar.jpg",
  "links": "https://example.com"
}
```

**Denormalization:** If username, display_name, or avatar changes, updates all user's posts automatically.

**Note:** Username changes are not supported as username is immutable.

#### POST /users/:id/follow
Follow a user.

**Side Effects:**
- Adds to `user:<username>:following` set
- Adds to `user:<target_username>:followers` set
- Increments `followingCount` and `followerCount`

#### DELETE /users/:id
Delete user account with cascading cleanup.

**Authorization:** Self or admin.

**Side Effects:**
- Deletes all user's posts
- Removes user from all `post:{id}:likes` and `post:{id}:bookmarks` sets
- Deletes all user keys
- Removes from `users:models` or `users:regular` sorted sets

### Feed Endpoints

#### GET /feed/hashtag/:id
Returns posts with a specific hashtag in chronological order.

**Query Parameters:**
- `offset` (default: 0)
- `limit` (default: 20, max: 100)
- `includeUser` (default: true)

**Response:** Same format as `/feed/explore`.

#### GET /feed/hashtag/:id/ranked
Returns posts with a specific hashtag ranked by engagement score (time-decayed).

**Query Parameters:** Same as chronological endpoint.

**Ranking:** Posts sorted by engagement score calculated from likes, comments, bookmarks, and post age.

### Search Endpoints

#### GET /search/users/newest
Get newest users by role.

**Query Parameters:**
- `role` - "user" or "model" (default: "user")
- `limit` (default: 10, max: 100)

**Response:**
```json
{
  "users": [
    {
      "uuid": "user-id",
      "username": "johndoe",
      "display_name": "John Doe"
    }
  ],
  "count": 10
}
```

**Privacy:** User data is sanitized (sensitive fields removed).

#### GET /search/hashtags/top-posts
Get top posts from multiple hashtags.

**Query Parameters:**
- `hashtags` - Comma-separated hashtag IDs (max 12)
- `postsPerHashtag` (default: 5)

**Response:**
```json
{
  "hashtags": {
    "travel": [
      { "post": {...}, "user": {...} }
    ],
    "food": [
      { "post": {...}, "user": {...} }
    ]
  }
}
```

#### GET /search/models/top
Get top models by engagement score.

**Query Parameters:**
- `limit` (default: 5, max: 100)

**Response:**
```json
{
  "models": [
    {
      "uuid": "model-id",
      "username": "topmodel",
      "engagement_score": 1234.5
    }
  ],
  "count": 5
}
```

### Interaction Status

All feed endpoints return `isLiked` and `isBookmarked` flags on each post when user is authenticated:

```json
{
  "post": {
    "id": "post-id",
    "content": "Post content",
    "isLiked": true,
    "isBookmarked": false,
    ...
  }
}
```

These flags are computed via batched `SISMEMBER` checks using Redis pipelines.

## Redis Data Structure

**Note:** User keys use username as the primary identifier (immutable). The pattern is `user:<username>` instead of `user:<uuid>`.

### Core Data Keys

- **`post:{id}`** - Hash
  - Post data with denormalized user fields: `id`, `user_id` (username of post owner), `username`, `avatar`, `display_name`, `content`, `media_url`, `created_at`, `likesCount`, `commentsCount`, `bookmarksCount`
  - May include `banned`, `banned_at`, `banned_by` for banned posts

- **`user:<username>`** - Hash
  - User profile: `username`, `display_name`, `bio`, `avatar`, `links`, `role`, `postCount`, `followerCount`, `followingCount`
  - Sensitive fields (only visible to self): `first_name`, `last_name`, `email`, `phone`, etc.

### Feed Sorted Sets (Score = Timestamp)

- **`explore:feed`** - Global feed, all public posts
- **`user:<username>:posts`** - All posts by a specific user
- **`hashtag:{id}:posts`** - All posts with a specific hashtag (chronological)
- **`user:<username>:bookmarked`** - User's bookmarked posts

### Engagement Sorted Sets (Score = Engagement Score)

- **`hashtag:{id}:ranked`** - Hashtag posts ranked by time-decayed engagement
- **`models:top:engagement`** - Top models by total engagement (likes + comments + bookmarks)

### User Relationship Sets

- **`user:<username>:following`** - Set of usernames this user follows
- **`user:<username>:followers`** - Set of usernames following this user

### Interaction Sets

- **`post:{id}:likes`** - Set of usernames who liked this post
- **`post:{id}:bookmarks`** - Set of usernames who bookmarked this post
- **`post:{id}:comments`** - Set/list of comment IDs on this post

### User Registry Sorted Sets (Score = Timestamp)

- **`users:regular`** - All regular users (role = "user")
- **`users:models`** - All model users (role = "model")

**For detailed documentation of all Redis keys, see [Redis Key Structure Reference](./docs/REDIS_KEYS.md)**

## Performance Notes

- **Multi-Level Caching**:
  - **Feed Cache**: 30 seconds - Full feed response caching
  - **Post Cache**: 10 minutes - Individual post data cached globally across all requests
  - **User Cache**: 5 minutes - User profile data cached to reduce user lookups
- **Cache-First Strategy**: Posts and users are checked in memory cache before querying Redis, dramatically reducing roundtrips
- **Pagination Limit**: Maximum limit of 100 posts per request prevents excessive data transfer
- **Following Feed Optimization**: Uses Redis `ZUNIONSTORE` to efficiently merge posts from multiple followed users into a temporary sorted set
- **Fallback Mode**: If `user:{uuid}:posts` structures are missing, the following feed falls back to filtering `explore:feed`, which is less efficient but ensures functionality
- **Pipeline Optimization**: Only uncached posts/users are fetched via Redis pipelines

## Security Features

### 1. Read-Only Mode
The service operates on a deny-list basis, blocking the following write commands:
- SET, MSET, APPEND
- DEL
- HSET, HINCRBY
- ZADD, ZREM
- INCR, DECR
- EXPIRE

All other Redis read commands are allowed by default.

### 2. Access Control
Users can only access keys matching these patterns:
- `user:<your_username>:*` - User-specific keys (e.g., posts, followers, bookmarks)
- `user:<your_username>` - Your own user profile hash
- Public keys (no "user:" prefix)

**Important:** Direct reads of other users' profile hashes (e.g., `HGETALL user:bob`) are blocked to protect sensitive fields. To access other users' profiles, use the `GET /users/:id` endpoint which automatically sanitizes sensitive data.

Attempts to access other users' keys are blocked with a 403 Forbidden error.

### 3. Sensitive Key Protection
The following key patterns are blocked:
- `otp:*` - One-time passwords
- `session*` - Session data
- Any key containing "password", "secret", "token", or "key"

## Write-Enabled Redis Proxy

The `POST /redis/write` endpoint provides authenticated users with the ability to perform safe write operations on their own user data using the AUTH placeholder. This complements the read-only Redis proxy by enabling direct Redis writes for non-critical fields.

### Endpoint

**POST /redis/write**

### Authentication

Required (JWT token)

### Request Format

- **Body:** Array of Redis commands
- **Example:** `[["HSET", "user:AUTH", "bio", "My new bio"]]`

### Allowed Commands

Only the following write commands are permitted:

- `HSET` - Set hash field value
- `HDEL` - Delete hash field
- `HINCRBY` - Increment hash field by integer

### `user:AUTH` and `user:me` Placeholder

- Use `user:me` (recommended) or `user:AUTH` in commands to reference your own user data
- Automatically replaced with `user:<your_username>` from JWT token
- **Example:** `HSET user:me bio "value"` becomes `HSET user:alice bio "value"`
- **Note:** Both placeholders work identically, but `user:me` is more intuitive

### Security Restrictions

#### 1. Command Whitelist
Only HSET, HDEL, and HINCRBY commands are allowed. All other commands are blocked with:
```
ERR command not allowed in write mode
```

#### 2. Key Restriction
Users can only modify keys matching the `user:<your_username>` pattern. Attempting to modify other users' data returns:
```
ERR forbidden: can only modify your own user data
```

**Note:** API key authentication bypasses ownership checks and allows modifying any user data (used for Xano sync).

#### 3. Field Restrictions
Certain fields cannot be modified directly and require using `PATCH /users/:id` instead:

**Blocked Fields (require denormalization):**
- `username` - Requires updating all user's posts
- `display_name` - Requires updating all user's posts
- `avatar` - Requires updating all user's posts

**Blocked Fields (system-managed):**
- `role` - User role (admin/user/model)
- `postCount` - Automatically managed
- `followerCount` - Automatically managed
- `followingCount` - Automatically managed

**Allowed Fields:**
- `bio` - User biography
- `links` - User links/URLs
- Custom fields - Any other user-defined fields

Attempting to modify blocked fields returns:
```
ERR field '<field>' cannot be modified directly, use PATCH /users/:id
```

### Use Cases

- Update bio or links without full profile update
- Manage custom user metadata fields
- Increment custom counters (e.g., profile views)
- Quick field updates without denormalization overhead

### When to Use PATCH /users/:id Instead

Use the dedicated `PATCH /users/:id` endpoint when:
- Updating username, display_name, or avatar (requires denormalization to posts)
- Updating multiple fields that might affect feed display
- You need the full profile update workflow with validation

### Example Requests

#### Update Bio
```bash
curl -X POST http://localhost:3000/redis/write \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '[["HSET", "user:AUTH", "bio", "My new bio"]]'
```

**Response:**
```json
{
  "results": [1],
  "user_id": "abc-123"
}
```

#### Update Multiple Fields
```bash
curl -X POST http://localhost:3000/redis/write \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '[["HSET", "user:AUTH", "bio", "New bio"], ["HSET", "user:AUTH", "links", "https://example.com"]]'
```

**Response:**
```json
{
  "results": [1, 1],
  "user_id": "abc-123"
}
```

#### Increment Custom Counter
```bash
curl -X POST http://localhost:3000/redis/write \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '[["HINCRBY", "user:AUTH", "custom_counter", "1"]]'
```

**Response:**
```json
{
  "results": [5],
  "user_id": "abc-123"
}
```

### Response Format

The response is an object containing:
- `results` - Array of results matching input commands
- `user_id` - The resolved user ID from the JWT token (shows which user's data was modified)

**Success Example:**
```json
{
  "results": [1, 1],
  "user_id": "abc-123"
}
```

**Error Example:**
```json
{
  "results": ["ERR command not allowed in write mode"],
  "user_id": "abc-123"
}
```

### Error Messages

- `"ERR command not allowed in write mode"` - Command not in whitelist
- `"ERR forbidden: can only modify your own user data"` - Attempting to modify other user's data
- `"ERR field '<field>' cannot be modified directly, use PATCH /users/:id"` - Blocked field
- `"ERR invalid key format"` - Key doesn't match user:<id> pattern

### Cache Invalidation

Successful writes automatically invalidate:
- User data cache (`userCache[user_id]`)
- User profile cache for all viewers (`user_profile_<user_id>_*`)
- Feed caches (conservative approach)

This ensures data consistency across the application after write operations.

## Usage Examples

### 1. Health Check
```bash
curl http://localhost:3000/ping
```

Response:
```json
{"status":"ok","message":"pong"}
```

### 2. Get JWT Payload
```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/whoami
```

Response:
```json
{
  "jwt_payload": {
    "user_id": "123",
    "iat": 1234567890
  },
  "resolved_user_key": "user:123"
}
```

### 3. Test Key Resolution
```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/debug-auth
```

Response:
```json
{
  "user_id": "alice",
  "resolved_key": "user:alice",
  "redis_data": {
    "username": "alice",
    "display_name": "Alice Smith",
    "email": "alice@example.com"
  }
}
```

### 4. Execute Redis Command
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[["GET", "user:me:following"]]' \
  http://localhost:3000/
```

Response:
```json
[
  "user:456,user:789"
]
```

### 5. Get Hash Data
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[["HGETALL", "user:me"]]' \
  http://localhost:3000/
```

Response:
```json
[
  {
    "username": "alice",
    "display_name": "Alice Smith",
    "email": "alice@example.com",
    "created_at": "2024-01-01"
  }
]
```

### 6. Get Set Members
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[["SMEMBERS", "user:me:followers"]]' \
  http://localhost:3000/
```

### 7. Query Public Data (No user: prefix)
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[["ZRANGE", "leaderboard", "0", "10"]]' \
  http://localhost:3000/
```

## Error Responses

### 401 Unauthorized (Missing Token)
```json
{
  "error": "No token provided"
}
```

### 401 Unauthorized (Invalid Token)
```json
{
  "error": "Invalid token"
}
```

### 401 Unauthorized (Expired Token)
```json
{
  "error": "Invalid token"
}
```
Note: Tokens expire after 15 minutes (900 seconds).

### 401 Unauthorized (Invalid or Missing Role)
```json
{
  "error": "Invalid or missing role in token"
}
```
Note: JWT tokens must include a valid `role` field (admin, user, or model).

### 403 Forbidden (Access to Other User's Data)
```json
{
  "error": "Forbidden: You can only access your own user:ID:* keys"
}
```

### 400 Bad Request (Blocked Command)
```json
{
  "error": "Command SET is not allowed (read-only mode)"
}
```

### 403 Forbidden (Sensitive Key)
```json
{
  "error": "Access to key 'otp:123456' is forbidden"
}
```

## Development

Start the server:
```bash
npm start
```

The server will start on the port specified in your `.env` file (default: 3000).

## Docker

Build the Docker image:
```bash
docker build -t redis-microservice .
```

Run the container:
```bash
docker run -p 3000:3000 \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e JWT_SECRET=your-secret-key \
  redis-microservice
```

## Logging & Monitoring

The service provides detailed logging and Redis request tracking for all endpoints.

### Request Tracking

Every request is assigned a unique request ID and tracks:
- **Redis Commands** - Individual Redis operations (GET, HGETALL, etc.)
- **Redis Pipelines** - Batched Redis operations
- **Request Duration** - Total time in milliseconds
- **Cache Hits/Misses** - Memory cache effectiveness

### Log Format

**Feed Endpoints:**
```
✅ [GET /feed/explore] Success | Duration: 45ms | Redis: 2 commands, 1 pipelines | Total: 3 roundtrips | includeUser: true
✅ [GET /feed/explore] CACHE HIT | Duration: 2ms | Redis: 0 commands, 0 pipelines | includeUser: true
```

**User Profile Endpoint:**
```
✅ [GET /users/:id] Success | Duration: 12ms | Redis: 1 commands, 0 pipelines | Total: 1 roundtrips
✅ [GET /users/:id] CACHE HIT | Duration: 1ms | Redis: 0 commands, 0 pipelines
❌ [GET /users/:id] User not found | Duration: 8ms | Redis: 1 commands, 0 pipelines
```

**Redis Proxy Requests:**
```
=== Redis Request ===
JWT user_id: 123
Command: GET
Original args: ["user:AUTH:following"]
Resolved args: ["user:123:following"]
Redis result: ["456", "789"]
=====================
```

### Performance Insights

The logging helps identify:
- Cache hit rates (0 Redis commands = cache hit)
- Slow queries (high duration)
- Redis roundtrip optimization opportunities
- Endpoint usage patterns

## Documentation

📚 **[Redis Key Structure Reference](./docs/REDIS_KEYS.md)** - Complete reference of all Redis keys, data types, and relationships

🔄 **[Xano Synchronization Guide](./docs/XANO_SYNC_GUIDE.md)** - Step-by-step guide for syncing data from Xano to Redis

💻 **[Frontend Integration Guide](./docs/FRONTEND_GUIDE.md)** - Guide for frontend developers using JWT authentication

🔒 **[TLS Setup Guide](./docs/TLS_SETUP.md)** - Certificate generation and TLS configuration

☁️ **[Redis Cloud TLS Guide](./docs/REDIS_CLOUD_TLS.md)** - Connecting to Redis Cloud with TLS

## License

MIT
