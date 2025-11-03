# Redis Key Structure Reference

This document provides a comprehensive reference for all Redis key structures used in the social media platform microservice.

## Introduction

The platform uses Redis as a high-performance cache layer with carefully designed key structures to optimize for social media use cases. All keys follow consistent naming conventions and are case-sensitive.

**Key Principles:**
- **Username-based:** Usernames are the primary identifier for users (immutable)
- **Denormalized data:** User data is duplicated in posts for fast retrieval
- **Time-decayed ranking:** Engagement scores decay over time to surface fresh content
- **Case-sensitive:** All keys are case-sensitive (e.g., `user:Alice` ≠ `user:alice`)

## User Keys

### `user:<username>` (Hash)

Stores all user profile data as a Redis hash. Contains both public and private fields.

**Public Fields** (visible to everyone):
- `username` - Unique username (immutable, primary key)
- `display_name` - Display name shown in UI
- `bio` - User biography/description
- `avatar` - URL to avatar image
- `links` - External links (website, social media)
- `role` - User role: "user", "model", or "admin"
- `postCount` - Total number of posts (system-managed)
- `followerCount` - Total number of followers (system-managed)
- `followingCount` - Total number of users being followed (system-managed)
- `created_at` - Account creation timestamp

**Private Fields** (only visible to self):
- `first_name` - First name
- `last_name` - Last name
- `email` - Email address
- `phone` / `phone_number` - Phone number
- `address` - Physical address
- `date_of_birth` / `birth_date` - Date of birth
- `password` / `password_hash` - Password or password hash
- `ssn` - Social security number
- `credit_card` - Credit card information
- `bank_account` - Bank account information
- `ip_address` - IP address
- `device_id` - Device identifier

**System-Managed Fields** (cannot be modified directly):
- `role` - Requires admin privileges to change
- `postCount` - Auto-incremented when creating/deleting posts
- `followerCount` - Auto-incremented when gaining/losing followers
- `followingCount` - Auto-incremented when following/unfollowing

**Example:**
```
HGETALL user:alice
→ { username: "alice", display_name: "Alice Smith", bio: "Software developer",
    email: "alice@example.com", role: "user", postCount: "42", ... }
```

### `user:<username>:posts` (Sorted Set)

Stores all post IDs created by the user, sorted by creation timestamp.

- **Members:** Post IDs (UUIDs)
- **Score:** Unix timestamp (milliseconds) of post creation
- **Sorted:** Newest posts have highest scores

**Example:**
```
ZREVRANGE user:alice:posts 0 9
→ ["post-uuid-1", "post-uuid-2", "post-uuid-3", ...]
```

### `user:<username>:followers` (Set)

Stores usernames of all users who follow this user.

- **Members:** Usernames (strings)
- **Cardinality:** Equal to `followerCount` in user hash

**Example:**
```
SMEMBERS user:alice:followers
→ ["bob", "charlie", "david"]
```

### `user:<username>:following` (Set)

Stores usernames of all users this user follows.

- **Members:** Usernames (strings)
- **Cardinality:** Equal to `followingCount` in user hash

**Example:**
```
SMEMBERS user:alice:following
→ ["bob", "eve", "frank"]
```

### `user:<username>:bookmarked` (Sorted Set)

Stores post IDs the user has bookmarked, sorted by bookmark timestamp.

- **Members:** Post IDs (UUIDs)
- **Score:** Unix timestamp (milliseconds) of bookmark action
- **Sorted:** Most recently bookmarked have highest scores

**Example:**
```
ZREVRANGE user:alice:bookmarked 0 19 WITHSCORES
→ ["post-uuid-1", "1234567890123", "post-uuid-2", "1234567880123", ...]
```

## Post Keys

### `post:<id>` (Hash)

Stores all post data as a Redis hash. Post IDs are generated using `crypto.randomUUID()` (RFC 4122 compliant UUIDs).

**Core Fields:**
- `id` - Post UUID (unique identifier, e.g., `550e8400-e29b-41d4-a716-446655440000`)
- `user_id` - Username of post creator
- `content` - Post text content
- `media_url` - URL to media attachment (image, video)
- `created_at` - Post creation timestamp (Unix milliseconds)

**Denormalized User Data** (copied from user profile for performance):
- `username` - Creator's username
- `avatar` - Creator's avatar URL
- `display_name` - Creator's display name
- `user_role` - Creator's role ("user", "model", "admin")

**Engagement Counters:**
- `likesCount` - Total number of likes
- `commentsCount` - Total number of comments
- `bookmarksCount` - Total number of bookmarks

**Moderation Fields:**
- `banned` - Boolean string ("true" or absent)
- `banned_at` - Ban timestamp (Unix milliseconds)
- `banned_by` - Username of moderator who banned the post

**Example:**
```
HGETALL post:550e8400-e29b-41d4-a716-446655440000
→ { id: "550e8400-...", user_id: "alice", username: "alice",
    content: "Hello world! #travel", likesCount: "42", ... }
```

### `post:<id>:likes` (Set)

Stores usernames of users who liked this post.

- **Members:** Usernames (strings)
- **Cardinality:** Equal to `likesCount` in post hash

**Example:**
```
SMEMBERS post:550e8400-e29b-41d4-a716-446655440000:likes
→ ["bob", "charlie", "david"]
```

### `post:<id>:bookmarks` (Set)

Stores usernames of users who bookmarked this post.

- **Members:** Usernames (strings)
- **Cardinality:** Equal to `bookmarksCount` in post hash

**Example:**
```
SMEMBERS post:550e8400-e29b-41d4-a716-446655440000:bookmarks
→ ["alice", "eve"]
```

### `post:<id>:comments` (Set/List)

Reserved for future use. Will store comment IDs associated with this post.

## Feed Keys

### `explore:feed` (Sorted Set)

Global public feed containing all non-banned posts, sorted chronologically.

- **Members:** Post IDs (UUIDs)
- **Score:** Unix timestamp (milliseconds) of post creation
- **Sorted:** Newest posts have highest scores
- **Purpose:** Powers the main explore/discovery feed

**Example:**
```
ZREVRANGE explore:feed 0 19
→ ["newest-post-uuid", "second-newest-uuid", ...]
```

### `hashtag:<tag>:posts` (Sorted Set)

Chronological feed of all posts containing a specific hashtag.

- **Members:** Post IDs (UUIDs)
- **Score:** Unix timestamp (milliseconds) of post creation
- **Sorted:** Newest posts have highest scores
- **Note:** Hashtags are stored in lowercase

**Example:**
```
ZREVRANGE hashtag:travel:posts 0 19
→ ["post-uuid-1", "post-uuid-2", ...]
```

### `hashtag:<tag>:ranked` (Sorted Set)

Engagement-ranked feed of posts with a specific hashtag, using time-decayed scoring.

- **Members:** Post IDs (UUIDs)
- **Score:** Time-decayed engagement score (see formula below)
- **Sorted:** Highest engagement scores first
- **Note:** Posts older than 2 weeks get score = 0 (not shown)

**Engagement Score Formula:**
```
score = (likes*3 + comments*5 + bookmarks*4) / ((current_time - created_at) / 3600 + 1)
```

Where:
- `likes*3` - Each like contributes 3 points
- `comments*5` - Each comment contributes 5 points (more valuable)
- `bookmarks*4` - Each bookmark contributes 4 points
- Divided by `(hours_since_posted + 1)` - Older posts decay exponentially

**Example:**
```
ZREVRANGE hashtag:travel:ranked 0 19
→ ["trending-post-uuid", "popular-post-uuid", ...]
```

## User Registry Keys

### `users:regular` (Sorted Set)

Registry of all users with `role='user'`, sorted by account creation date.

- **Members:** Usernames (strings)
- **Score:** Unix timestamp (milliseconds) of account creation
- **Purpose:** Powers "newest users" search/discovery

**Example:**
```
ZREVRANGE users:regular 0 19
→ ["newest-user", "second-newest-user", ...]
```

### `users:models` (Sorted Set)

Registry of all users with `role='model'`, sorted by account creation date.

- **Members:** Usernames (strings)
- **Score:** Unix timestamp (milliseconds) of account creation
- **Purpose:** Powers "newest models" search/discovery

**Example:**
```
ZREVRANGE users:models 0 19
→ ["newest-model", "second-newest-model", ...]
```

### `models:top:engagement` (Sorted Set)

Leaderboard of top models ranked by total engagement score.

- **Members:** Usernames (strings)
- **Score:** Total engagement score (likes*3 + comments*5 + bookmarks*4)
- **Purpose:** Powers "top models" leaderboard

**Example:**
```
ZREVRANGE models:top:engagement 0 9 WITHSCORES
→ ["top-model-1", "15000", "top-model-2", "12500", ...]
```

## Temporary Keys

### `tmp:home:<username>` (Sorted Set)

Temporary key used to aggregate posts from all followed users into a personalized feed.

- **Members:** Post IDs (UUIDs)
- **Score:** Unix timestamp (milliseconds) of post creation
- **Lifecycle:** Created on-demand, auto-expires
- **Purpose:** Powers the "following feed" endpoint

**How it works:**
1. System runs `ZUNIONSTORE tmp:home:alice user:bob:posts user:charlie:posts ...` for all followed users
2. Temporary key contains merged posts sorted chronologically
3. Key expires automatically after a short TTL

**Example:**
```
ZREVRANGE tmp:home:alice 0 19
→ ["post-from-bob", "post-from-charlie", ...]
```

## Key Lifecycle

### When Keys Are Created

**User Registration:**
- `user:<username>` - Created with initial profile data
- `user:<username>:posts` - Created empty
- `user:<username>:followers` - Created empty
- `user:<username>:following` - Created empty
- `user:<username>:bookmarked` - Created empty
- `users:regular` or `users:models` - User added based on role

**Post Creation:**
- `post:<id>` - Created with post data and denormalized user info
- `post:<id>:likes` - Created empty
- `post:<id>:bookmarks` - Created empty
- `explore:feed` - Post ID added
- `hashtag:<tag>:posts` - Post ID added for each hashtag
- `hashtag:<tag>:ranked` - Post ID added with engagement score
- `user:<username>:posts` - Post ID added to creator's posts

**Follow Action:**
- `user:<follower>:following` - Target username added
- `user:<target>:followers` - Follower username added

**Interaction (Like/Bookmark):**
- `post:<id>:likes` or `post:<id>:bookmarks` - Username added
- `user:<username>:bookmarked` - Post ID added (for bookmarks only)

### When Keys Are Updated

**Profile Update:**
- `user:<username>` - Fields updated
- `post:<id>` - Denormalized fields updated for all user's posts (if username/avatar/display_name changed)

**Follow/Unfollow:**
- `user:<username>:followingCount` - Incremented/decremented
- `user:<target>:followerCount` - Incremented/decremented

**Like/Unlike:**
- `post:<id>:likesCount` - Incremented/decremented
- `hashtag:<tag>:ranked` - Engagement score recalculated

**Bookmark/Unbookmark:**
- `post:<id>:bookmarksCount` - Incremented/decremented
- `hashtag:<tag>:ranked` - Engagement score recalculated

### When Keys Are Deleted

**User Deletion:**
- `user:<username>` - Deleted
- `user:<username>:posts` - Deleted
- `user:<username>:followers` - Deleted
- `user:<username>:following` - Deleted
- `user:<username>:bookmarked` - Deleted
- `users:regular` or `users:models` - Username removed
- All user's posts deleted (cascading)

**Post Deletion:**
- `post:<id>` - Deleted
- `post:<id>:likes` - Deleted
- `post:<id>:bookmarks` - Deleted
- `explore:feed` - Post ID removed
- `hashtag:<tag>:posts` - Post ID removed
- `hashtag:<tag>:ranked` - Post ID removed
- `user:<username>:posts` - Post ID removed

**Unfollow:**
- Entry removed from `user:<follower>:following`
- Entry removed from `user:<target>:followers`

## Data Denormalization

User data is intentionally duplicated into post objects for performance optimization.

**Why Denormalize?**
- Reduces database queries when rendering feeds (no need to lookup user for each post)
- Trades storage space for query speed (critical for social media)
- Redis is fast but network round-trips are expensive

**Denormalized Fields:**
1. `username` - Copied from `user:<username>:username`
2. `avatar` - Copied from `user:<username>:avatar`
3. `display_name` - Copied from `user:<username>:display_name`
4. `user_role` - Copied from `user:<username>:role`

**When Denormalized Data Updates:**

When a user updates their `username`, `avatar`, or `display_name`:
1. Update `user:<username>` hash
2. Get all post IDs from `user:<username>:posts`
3. Update denormalized fields in each `post:<id>` hash
4. This ensures consistency across the platform

**Note:** Username changes require careful handling because the username is part of the key pattern. Changing usernames requires migrating all related keys.

## Examples

### User "alice" Key Patterns

```
user:alice                    # Profile hash
user:alice:posts              # Sorted set of post IDs
user:alice:followers          # Set of follower usernames
user:alice:following          # Set of following usernames
user:alice:bookmarked         # Sorted set of bookmarked post IDs
```

### Post Key Example

```
post:550e8400-e29b-41d4-a716-446655440000         # Post hash
post:550e8400-e29b-41d4-a716-446655440000:likes   # Set of liker usernames
post:550e8400-e29b-41d4-a716-446655440000:bookmarks  # Set of bookmarker usernames
```

### Hashtag Key Examples

```
hashtag:travel:posts     # Chronological posts with #travel
hashtag:travel:ranked    # Engagement-ranked posts with #travel
hashtag:food:posts       # Chronological posts with #food
hashtag:food:ranked      # Engagement-ranked posts with #food
```

## Best Practices

### Do's ✅

- **Use lowercase for hashtags:** Always convert hashtags to lowercase before storing
- **Use UUIDs for post IDs:** Prevents collisions and ensures uniqueness
- **Treat usernames as immutable:** Changing usernames requires complex key migration
- **Use API endpoints for modifications:** Ensures proper denormalization and counter updates
- **Batch Redis commands:** Reduces network overhead and improves performance
- **Let the system manage counters:** Don't manually modify `postCount`, `followerCount`, etc.

### ⚠️ Manual Redis Writes Not Supported

**Direct writes to sets/sorted sets for relationships and feeds are NOT permitted via `/redis/write`:**

❌ **Blocked Operations:**
- `ZADD` / `ZREM` - Cannot directly add/remove from feeds (explore:feed, hashtag feeds, user posts)
- `SADD` / `SREM` - Cannot directly add/remove from relationship sets (followers, following, likes, bookmarks)
- `HINCRBY` on counters - Cannot manually modify postCount, followerCount, followingCount, likesCount, etc.

✅ **Required Approach:**
- **For posts:** Use `POST /posts` (creates post + updates all feeds + increments counters)
- **For follows:** Use `POST/DELETE /users/:username/follow` (updates both sides + increments counters)
- **For likes:** Use `POST/DELETE /posts/:id/like` (updates set + increments counter + recalculates engagement)
- **For bookmarks:** Use `POST/DELETE /posts/:id/bookmark` (updates sets + increments counter + denormalization)

These high-level REST endpoints handle:
- Counter updates (postCount, followerCount, likesCount, etc.)
- Bidirectional relationships (follower ↔ following)
- Feed denormalization (user data in posts)
- Engagement score recalculation (for ranked feeds)

**See [XANO_SYNC_GUIDE.md](./XANO_SYNC_GUIDE.md) for details on syncing from Xano.**

### Don'ts ❌

- **Don't modify system-managed fields directly:** Use API endpoints instead
- **Don't change usernames without migration:** All user keys include username in the pattern
- **Don't skip denormalization updates:** User data in posts must stay in sync
- **Don't use case-sensitive hashtags:** Always normalize to lowercase
- **Don't directly manipulate engagement scores:** Use the ranking algorithms provided

### Username Immutability

Usernames are immutable by design because they're embedded in key patterns:
- `user:<username>`
- `user:<username>:posts`
- `user:<username>:followers`
- etc.

**To change a username, you must:**
1. Create all new keys with new username pattern
2. Copy all data from old keys to new keys
3. Update denormalized username in all posts
4. Update username references in all followers/following sets
5. Delete all old keys
6. This is expensive and should be avoided

### API Endpoint Usage

Always use the provided API endpoints for data modifications:
- `POST /posts` - Creates post with proper denormalization
- `POST /users/:username/follow` - Updates both sides of relationship
- `POST /posts/:id/like` - Updates counters and engagement scores
- `POST /posts/:id/bookmark` - Updates both user and post keys
- `PATCH /users/:id` - Handles denormalization when updating profile

Direct Redis writes via `/redis/write` should only be used for:
- Reading data
- Updating custom fields that don't require denormalization
- Xano sync operations with API key authentication

## Quick Reference Table

| Key Pattern | Type | Score/Value | Description |
|-------------|------|-------------|-------------|
| `user:<username>` | Hash | N/A | User profile data (public + private fields) |
| `user:<username>:posts` | Sorted Set | Timestamp | User's posts (newest first) |
| `user:<username>:followers` | Set | N/A | Usernames of followers |
| `user:<username>:following` | Set | N/A | Usernames being followed |
| `user:<username>:bookmarked` | Sorted Set | Timestamp | Bookmarked post IDs (newest first) |
| `post:<id>` | Hash | N/A | Post data with denormalized user info |
| `post:<id>:likes` | Set | N/A | Usernames who liked this post |
| `post:<id>:bookmarks` | Set | N/A | Usernames who bookmarked this post |
| `explore:feed` | Sorted Set | Timestamp | Global public feed (newest first) |
| `hashtag:<tag>:posts` | Sorted Set | Timestamp | Posts with hashtag (newest first) |
| `hashtag:<tag>:ranked` | Sorted Set | Engagement | Posts with hashtag (trending first) |
| `users:regular` | Sorted Set | Timestamp | All regular users (newest first) |
| `users:models` | Sorted Set | Timestamp | All model users (newest first) |
| `models:top:engagement` | Sorted Set | Engagement | Top models leaderboard |
| `tmp:home:<username>` | Sorted Set | Timestamp | Temporary following feed (auto-expires) |

---

**See Also:**
- [XANO_SYNC_GUIDE.md](./XANO_SYNC_GUIDE.md) - Syncing data from Xano to Redis
- [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md) - Frontend integration with JWT authentication
- [README.md](../README.md) - Main project documentation
