# Redis Microservice

A secure, read-only Redis proxy microservice with JWT-based authentication and user-specific access control.

## Overview

This microservice provides a REST API interface to Redis with built-in security features:

- **JWT Authentication**: Secure endpoint access with JWT tokens
- **Read-Only Proxy**: Only allows safe Redis read commands (GET, HGETALL, SMEMBERS, etc.)
- **User-based Access Control**: Automatic key namespacing based on authenticated user_id
- **Placeholder Replacement**: `user:AUTH` automatically resolves to `user:{user_id}`
- **Security Checks**: Prevents unauthorized access to sensitive keys and other users' data

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
PORT=3000
```

## Available Routes

### Public Routes (No Authentication Required)

- **`GET /`** - Welcome message and service info
- **`GET /ping`** - Simple health check, returns "pong"
- **`GET /healthz`** - Health status check
- **`GET /feed/explore`** - Explore feed (public posts, paginated)

### Protected Routes (JWT Authentication Required)

- **`POST /`** - Redis proxy endpoint for executing Redis commands
- **`GET/POST /whoami`** - Returns the decoded JWT payload
- **`GET/POST /debug-auth`** - Tests Redis key resolution with placeholder replacement
- **`GET /users/:id`** - Get user profile with privacy controls
- **`GET /feed/following`** - Following feed (posts from followed users, paginated)

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

The JWT token must contain both `user_id` and `role` fields:
```json
{
  "user_id": "123",
  "role": "user",
  "iat": 1234567890,
  "exp": 1234568790
}
```

**Required Fields:**
- `user_id` - Unique identifier for the user
- `role` - User role, must be one of: `admin`, `user`, or `model`

The token must be signed with the `JWT_SECRET` configured in your `.env` file.

**Token Expiration:** Tokens expire after 900 seconds (15 minutes). The service automatically validates the expiration time.

**Role Validation:** If the `role` field is missing or contains an invalid value, authentication will fail with a 401 error.

## Placeholder Replacement

The service automatically replaces `user:AUTH` with `user:{user_id}` in Redis commands, where `{user_id}` is extracted from the JWT token.

**Example:**
- Request: `[["GET", "user:AUTH:following"]]`
- Resolves to: `["GET", "user:123:following"]` (if user_id is "123")

This allows clients to query their own data without knowing their user_id in advance.

## User Profile Endpoint

### GET /users/:id

Retrieves a user profile by ID with automatic privacy controls. Sensitive fields are automatically filtered based on the relationship between the authenticated user and the requested profile.

**Authentication:** Requires JWT token.

**URL Parameters:**
- `id` - User ID to retrieve

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
# Get your own profile (all fields visible)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/users/your-user-id

# Get another user's profile (sensitive fields removed)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:3000/users/other-user-id
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

**Optimization:** Uses Redis `ZUNIONSTORE` to efficiently merge posts from all followed users, with fallback to `explore:feed` filtering if `user:{uuid}:posts` structures are not available.

**Example Request:**
```bash
# With user data (default)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  "http://localhost:3000/feed/following?offset=0&limit=10"

# Without user data (faster, less data)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  "http://localhost:3000/feed/following?offset=0&limit=10&includeUser=false"
```

## Redis Data Structure

The feed endpoints expect the following Redis key structure:

- **`explore:feed`** - Sorted Set (Score = Timestamp, Member = Post UUID)
  - Contains post UUIDs for the global explore feed
  - Higher scores (timestamps) represent newer posts

- **`post:{uuid}`** - Hash
  - Contains post data including `user_id`, `content`, `created_at`, etc.

- **`user:{uuid}`** - Hash
  - Contains user profile data including `username`, `display_name`, etc.

- **`user:{uuid}:following`** - Set
  - Contains user IDs that the user follows

- **`user:{uuid}:posts`** - Sorted Set (Score = Timestamp, Member = Post UUID)
  - Contains post UUIDs for a specific user
  - **Required** for optimal following feed performance
  - If absent, the service will fall back to filtering `explore:feed` by followed users (less efficient)

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
- `user:{user_id}:*` - User-specific keys
- `user:{user_id}` - User profile keys
- Public keys (no "user:" prefix)

Attempts to access other users' keys (e.g., `user:456:*` when user_id is "123") are blocked with a 403 Forbidden error.

### 3. Sensitive Key Protection
The following key patterns are blocked:
- `otp:*` - One-time passwords
- `session*` - Session data
- Any key containing "password", "secret", "token", or "key"

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
  "user_id": "123",
  "resolved_key": "user:123",
  "redis_data": {
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

### 4. Execute Redis Command
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[["GET", "user:AUTH:following"]]' \
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
  -d '[["HGETALL", "user:AUTH"]]' \
  http://localhost:3000/
```

Response:
```json
[
  {
    "name": "John Doe",
    "email": "john@example.com",
    "created_at": "2024-01-01"
  }
]
```

### 6. Get Set Members
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[["SMEMBERS", "user:AUTH:followers"]]' \
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

### Generating Test JWT Tokens

Use the included `generate-test-token.js` script to create JWT tokens for testing:

```bash
node generate-test-token.js [user_id] [role]
```

**Parameters:**
- `user_id` (optional, default: `test-user-123`) - User identifier
- `role` (optional, default: `user`) - User role (`admin`, `user`, or `model`)

**Examples:**
```bash
# Generate token for regular user
node generate-test-token.js 123 user

# Generate token for admin
node generate-test-token.js 456 admin

# Generate token for model
node generate-test-token.js 789 model

# Use defaults (test-user-123, user)
node generate-test-token.js
```

The script will output:
- User ID and role
- JWT token (valid for 15 minutes)
- Decoded payload
- Example cURL commands for testing

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

## License

MIT
