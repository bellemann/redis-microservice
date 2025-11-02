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

### Protected Routes (JWT Authentication Required)

- **`POST /`** - Redis proxy endpoint for executing Redis commands
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

The JWT token must contain a `user_id` field:
```json
{
  "user_id": "123",
  "iat": 1234567890
}
```

The token must be signed with the `JWT_SECRET` configured in your `.env` file.

## Placeholder Replacement

The service automatically replaces `user:AUTH` with `user:{user_id}` in Redis commands, where `{user_id}` is extracted from the JWT token.

**Example:**
- Request: `[["GET", "user:AUTH:following"]]`
- Resolves to: `["GET", "user:123:following"]` (if user_id is "123")

This allows clients to query their own data without knowing their user_id in advance.

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
  "error": "Invalid token",
  "details": "jwt malformed"
}
```

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
node generate-test-token.js <user_id>
```

Example:
```bash
node generate-test-token.js 123
```

This will output a JWT token you can use for testing.

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

## Logging

The service logs all requests to the console with the following information:
- Timestamp
- HTTP method and path
- Authenticated user_id (for protected routes)
- Original and resolved Redis commands (for proxy requests)

Example log output:
```
[2024-01-01T12:00:00.000Z] POST / - User: 123
Original command: ["GET","user:AUTH:following"]
Resolved command: ["GET","user:123:following"]
```

## License

MIT
