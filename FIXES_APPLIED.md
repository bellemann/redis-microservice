# Fixes Applied to index.js

## Completed Fixes

### ✅ Comment 7: Remove auth header logging (SECURITY FIX)
- **Location**: JWT Auth Middleware (line ~296)
- **Change**: Removed `console.log("Authorization header I got:", authHeader)`
- **Reason**: Prevents sensitive token data from appearing in logs

### ✅ Comment 19 (Additional): Create seed data endpoint
- **Location**: After /whoami endpoint (line ~2305)
- **Added**: POST /seed endpoint for testing
- **Features**:
  - Creates 3 test users (alice: user, bobmodel: model, charlie: admin)
  - Creates 3 test posts with hashtags
  - Sets up follow relationship (alice follows bob)
  - Uses extractHashtags() helper for consistency
  - Includes user_role in denormalized post data

### ✅ Helper Functions Added
- **extractHashtags(content)**: Normalizes hashtag extraction (lowercase, deduplicate)
- **invalidateFeedCaches()**: Invalidates all feed-related caches

## Critical Fixes Still Needed

Due to file size and complexity, the following fixes require manual application or a separate migration script:

### 1. Ranking Score Calculation (Comment 1) - CRITICAL
**Location**: POST/DELETE /posts/:id/like, POST/DELETE /posts/:id/bookmark

Current (WRONG):
```javascript
const currentTime = Date.now() / 1000;
const createdAt = parseInt(postData.created_at) / 1000;
const ageInHours = (currentTime - createdAt) / 3600;
```

Fixed (CORRECT):
```javascript
const currentTime = Date.now();
const createdAt = parseInt(postData.created_at);
const ageInHours = (currentTime - createdAt) / 3600000;
```

### 2. Engagement Tracking (Comment 2) - CRITICAL
**Location**: POST/DELETE /posts/:id/like, POST/DELETE /posts/:id/bookmark

Current (WRONG):
```javascript
if (postData.user_id && req.user.role === 'model') {
  multi.zincrby('models:top:engagement', 1, postData.user_id);
}
```

Fixed (CORRECT):
```javascript
// Fetch author role before updating engagement
const authorRole = await trackedRedis.hget(`user:${postData.user_id}`, 'role');
if (authorRole === 'model') {
  multi.zincrby('models:top:engagement', 1, postData.user_id);
}
```

### 3. Cache Invalidation (Comment 3)
**Location**: All mutation endpoints (POST/DELETE/PATCH)

Add after each mutation:
```javascript
invalidateFeedCaches();
```

### 4. isLiked/isBookmarked Conversion (Comment 4)
**Location**: aggregatePostsWithUsers() function

Current (WRONG):
```javascript
interactionMap[postId] = {
  isLiked: Boolean(isLiked),
  isBookmarked: Boolean(isBookmarked)
};
```

Fixed (CORRECT):
```javascript
const isLikedNum = parseInt(isLiked) || 0;
const isBookmarkedNum = parseInt(isBookmarked) || 0;
interactionMap[postId] = {
  isLiked: isLikedNum === 1,
  isBookmarked: isBookmarkedNum === 1
};
```

### 5. User Deletion Likes Decrement (Comment 5)
**Location**: DELETE /users/:id

Add in cleanup loop:
```javascript
for (const postId of explorePosts) {
  const wasLiked = await redis.sismember(`post:${postId}:likes`, userId);
  if (wasLiked) {
    cleanupMulti.hincrby(`post:${postId}`, 'likesCount', -1);
  }
  cleanupMulti.srem(`post:${postId}:likes`, userId);
  cleanupMulti.srem(`post:${postId}:bookmarks`, userId);
}
```

### 6. Post Deletion Bookmarks Cleanup (Comment 6)
**Location**: DELETE /posts/:id, PATCH /posts/:id/ban

Before deleting bookmarks set:
```javascript
const bookmarkedBy = await trackedRedis.smembers(`post:${postId}:bookmarks`);
for (const userId of bookmarkedBy) {
  multi.zrem(`user:${userId}:bookmarked`, postId);
}
multi.del(`post:${postId}:bookmarks`);
```

### 7. Hashtag Extraction Harmonization (Comment 8)
**Location**: POST /posts, DELETE /posts/:id, PATCH /posts/:id/ban

Replace all instances of:
```javascript
const hashtagMatches = postData.content.match(/#(\w+)/g) || [];
const hashtags = hashtagMatches.map(tag => tag.substring(1));
```

With:
```javascript
const hashtags = extractHashtags(postData.content);
```

### 8. postsPerHashtag Validation (Comment 14)
**Location**: GET /search/hashtags/top-posts

Add validation:
```javascript
let postsPerHashtag = parseInt(req.query.postsPerHashtag) || 5;
if (postsPerHashtag > 50) postsPerHashtag = 50;
if (postsPerHashtag < 1) postsPerHashtag = 1;
```

### 9. Banned Posts Filtering (Comment 15)
**Location**: aggregatePostsWithUsers() function

After fetching posts:
```javascript
if (err || !postData || Object.keys(postData).length === 0 || postData.banned === 'true') {
  console.log(`[aggregatePostsWithUsers] Skipping post ${postId}: ${postData.banned === 'true' ? 'banned' : 'empty or error'}`);
  continue;
}
```

### 10. user_role Denormalization (Comment 16)
**Location**: POST /posts

Add to postData:
```javascript
const postData = {
  id: postId,
  user_id: userId,
  username: userData.username || '',
  avatar: userData.avatar || '',
  display_name: userData.display_name || userData.username || '',
  user_role: userData.role || 'user', // ADD THIS LINE
  content: content.trim(),
  // ... rest
};
```

### 11. Following Feed Fallback Limit (Comment 11)
**Location**: GET /feed/following (fallback path)

Change:
```javascript
// Safety limit to prevent infinite loops
if (currentOffset > 10000) break;
```

To:
```javascript
// Safety limit to prevent infinite loops (reduced for performance)
if (currentOffset > 3000) break;
```

### 12. Use Tracked Redis (Comment 18)
**Location**: All direct redis.sismember calls

Replace:
```javascript
const alreadyLiked = await redis.sismember(`post:${postId}:likes`, userId);
```

With:
```javascript
const alreadyLiked = await trackedRedis.sismember(`post:${postId}:likes`, userId);
```

## Testing Instructions

1. Start Redis: `redis-server`
2. Start the service: `npm start`
3. Seed the database: `curl -X POST http://localhost:3000/seed`
4. Generate test JWT tokens using the user IDs from seed response
5. Test all endpoints with the seeded data

## JWT Token Generation for Testing

```javascript
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-12345';

// Alice (regular user)
const aliceToken = jwt.sign({ user_id: 'user-1', role: 'user' }, JWT_SECRET, { expiresIn: '24h' });

// Bob (model)
const bobToken = jwt.sign({ user_id: 'user-2', role: 'model' }, JWT_SECRET, { expiresIn: '24h' });

// Charlie (admin)
const charlieToken = jwt.sign({ user_id: 'user-3', role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });

console.log('Alice Token:', aliceToken);
console.log('Bob Token:', bobToken);
console.log('Charlie Token:', charlieToken);
```

## Priority Implementation Order

1. **CRITICAL**: Ranking Score Calculation (Comment 1) - Affects all engagement metrics
2. **CRITICAL**: Engagement Tracking (Comment 2) - Wrong user role being checked
3. **HIGH**: isLiked/isBookmarked Conversion (Comment 4) - Affects all feed responses
4. **HIGH**: Banned Posts Filtering (Comment 15) - Security/integrity issue
5. **MEDIUM**: Cache Invalidation (Comment 3) - Performance/consistency
6. **MEDIUM**: Hashtag Harmonization (Comment 8) - Data consistency
7. **MEDIUM**: User/Post Deletion Cleanups (Comments 5, 6) - Data integrity
8. **LOW**: Validation & Limits (Comments 11, 14) - Performance optimization
