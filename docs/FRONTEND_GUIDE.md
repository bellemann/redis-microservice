# Frontend Integration Guide

A comprehensive guide for frontend developers to integrate with the Redis microservice using JWT authentication.

## Introduction

This guide helps frontend developers query Redis data securely through the microservice API. You'll learn how to authenticate with JWT tokens, use the powerful `user:me` placeholder, and build performant social media features.

**What You'll Learn:**
- JWT authentication and token management
- Using the `user:me` placeholder for self-referential queries
- Reading and updating your profile data
- Querying feeds, posts, and relationships
- Framework-specific integration examples (React, Vue, Angular)
- Error handling and best practices

**Prerequisites:**
- JWT token with `username` and `role` fields
- Basic understanding of REST APIs and HTTP requests
- Your deployed Redis microservice URL

## Authentication Setup

### JWT Token Requirements

Your JWT token must include specific fields to work with the Redis microservice:

**Required Payload Fields:**
```json
{
  "user_id": "123",
  "username": "alice",
  "role": "user",
  "iat": 1234567890,
  "exp": 1234568790
}
```

**Field Descriptions:**
- `user_id` - Legacy field, kept for backward compatibility (can be any value)
- `username` - **Primary identifier** - Your username (immutable, used as Redis key)
- `role` - Your role: `"user"`, `"model"`, or `"admin"`
- `iat` - Token issued at timestamp (Unix seconds)
- `exp` - Token expiration timestamp (Unix seconds)

**Important Notes:**
- ✅ `username` is the primary identifier (not `user_id`)
- ✅ Token must be signed with the correct `JWT_SECRET` (server-side)
- ✅ Token should expire after a reasonable time (e.g., 24 hours)

### Including Token in Requests

You can include your JWT token using any of these headers:

**Option 1: Authorization Bearer (Recommended)**
```javascript
headers: {
  'Authorization': `Bearer ${jwtToken}`
}
```

**Option 2: x-authorization**
```javascript
headers: {
  'x-authorization': jwtToken
}
```

**Option 3: x-access-token**
```javascript
headers: {
  'x-access-token': jwtToken
}
```

**Example Request:**
```javascript
const response = await fetch('https://your-redis-service.com/users/me', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});
```

## The `user:me` Placeholder

### What is it?

`user:me` is a special placeholder that automatically resolves to your username from the JWT token. It's more intuitive than `user:AUTH` and follows REST conventions (similar to `/users/me` endpoints).

**How it works:**
1. You write: `user:me` in your Redis command
2. Server extracts username from JWT: `"alice"`
3. Server resolves to: `user:alice`
4. Command executes with your actual username

**Alternative:** `user:AUTH` works identically but `user:me` is recommended for its clarity.

### When to Use

Use `user:me` whenever you need to access your own data:
- ✅ Reading your profile: `HGETALL user:me`
- ✅ Getting your followers: `SMEMBERS user:me:followers`
- ✅ Getting your posts: `ZREVRANGE user:me:posts 0 9`
- ✅ Updating your bio: `HSET user:me bio "New bio"`
- ✅ Getting your bookmarks: `ZREVRANGE user:me:bookmarked 0 19`

**Don't use for other users:**
- ❌ `HGETALL user:bob` (use actual username)
- ❌ `SMEMBERS user:bob:followers` (use actual username)

## Reading Your Profile Data

### Get All Profile Fields

Retrieve your complete profile including private fields (email, phone, etc.):

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["HGETALL", "user:me"]
  ])
});

const [userData] = await response.json();
console.log(userData);
// {
//   username: "alice",
//   display_name: "Alice Smith",
//   bio: "Software developer",
//   email: "alice@example.com",  // Private field (only visible to you)
//   phone: "+1-555-0123",         // Private field
//   role: "user",
//   postCount: "42",
//   followerCount: "150",
//   followingCount: "87"
// }
```

**Note:** When you access `user:me`, you see ALL fields including sensitive ones. Other users cannot see your email, phone, etc.

### Get Specific Field

Retrieve just one field from your profile:

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["HGET", "user:me", "bio"]
  ])
});

const [bio] = await response.json();
console.log(bio); // "Software developer"
```

### Get Multiple Fields

Retrieve multiple specific fields efficiently:

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["HMGET", "user:me", "bio", "links", "display_name", "avatar"]
  ])
});

const [fields] = await response.json();
const [bio, links, displayName, avatar] = fields;
console.log({ bio, links, displayName, avatar });
```

**Tip:** Use `HMGET` instead of multiple `HGET` calls to reduce network overhead.

### Using the High-Level Endpoint

For a simpler approach, use the dedicated endpoint:

```javascript
const response = await fetch('https://your-redis-service.com/users/me', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const data = await response.json();
console.log(data.user); // Full profile object
```

**Benefits:**
- ✅ Simpler syntax
- ✅ Returns formatted JSON object
- ✅ Includes derived data (like engagement scores)

## Reading Your Relationships

### Get Your Followers

Retrieve the list of usernames who follow you:

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["SMEMBERS", "user:me:followers"]
  ])
});

const [followers] = await response.json();
console.log(followers); // ["bob", "charlie", "david"]
```

### Get Who You Follow

Retrieve the list of usernames you're following:

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["SMEMBERS", "user:me:following"]
  ])
});

const [following] = await response.json();
console.log(following); // ["bob", "eve", "frank"]
```

### Check if You Follow Someone

Check if you follow a specific user:

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["SISMEMBER", "user:me:following", "bob"]
  ])
});

const [isFollowing] = await response.json();
console.log(isFollowing ? "You follow Bob" : "You don't follow Bob");
// isFollowing is 1 (true) or 0 (false)
```

### Get Follower and Following Counts

Retrieve counts efficiently:

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["HGET", "user:me", "followerCount"],
    ["HGET", "user:me", "followingCount"]
  ])
});

const [followerCount, followingCount] = await response.json();
console.log(`Followers: ${followerCount}, Following: ${followingCount}`);
```

## Reading Your Posts

### Get Your Latest Posts (IDs Only)

Retrieve post IDs sorted by creation date (newest first):

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["ZREVRANGE", "user:me:posts", "0", "9"] // Latest 10 posts
  ])
});

const [postIds] = await response.json();
console.log(postIds); // Array of post UUIDs
```

**Pagination:**
```javascript
// Page 1: Posts 0-9
["ZREVRANGE", "user:me:posts", "0", "9"]

// Page 2: Posts 10-19
["ZREVRANGE", "user:me:posts", "10", "19"]

// Page 3: Posts 20-29
["ZREVRANGE", "user:me:posts", "20", "29"]
```

### Get Full Post Data

Once you have post IDs, fetch the full post objects:

```javascript
// Step 1: Get post IDs
const idsResponse = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["ZREVRANGE", "user:me:posts", "0", "9"]
  ])
});

const [postIds] = await idsResponse.json();

// Step 2: Get post data for each ID
const commands = postIds.map(id => ["HGETALL", `post:${id}`]);
const postsResponse = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(commands)
});

const posts = await postsResponse.json();
console.log(posts); // Array of post objects
```

### Get Post Count

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["ZCARD", "user:me:posts"]
  ])
});

const [postCount] = await response.json();
console.log(`You have ${postCount} posts`);
```

## Reading Your Bookmarks

### Get Bookmarked Post IDs

Retrieve posts you've bookmarked (newest first):

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["ZREVRANGE", "user:me:bookmarked", "0", "19"] // Latest 20 bookmarks
  ])
});

const [bookmarkedPostIds] = await response.json();
```

### Using the Dedicated Endpoint (Recommended)

For a better experience, use the high-level endpoint:

```javascript
const response = await fetch('https://your-redis-service.com/users/me/bookmarked?offset=0&limit=20', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const data = await response.json();
console.log(data.posts); // Full post objects with user data
console.log(data.totalCount); // Total number of bookmarks
```

**Benefits:**
- ✅ Returns full post objects (no second query needed)
- ✅ Includes user data (avatar, display name, etc.)
- ✅ Supports pagination with offset/limit

## Updating Your Profile

### Update Single Field

Update your bio using the `/redis/write` endpoint:

```javascript
const response = await fetch('https://your-redis-service.com/redis/write', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["HSET", "user:me", "bio", "My new bio!"]
  ])
});

const result = await response.json();
console.log(result); // { results: [1], user_id: "alice" }
```

### Update Multiple Fields

Update several fields in one request:

```javascript
const response = await fetch('https://your-redis-service.com/redis/write', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["HSET", "user:me", "bio", "Software developer and tech enthusiast"],
    ["HSET", "user:me", "links", "https://mywebsite.com"],
    ["HSET", "user:me", "phone", "+1-555-9999"]
  ])
});

const result = await response.json();
console.log(result); // { results: [1, 1, 1], user_id: "alice" }
```

### Field Restrictions

⚠️ **Some fields have special restrictions:**

**Cannot Update via `/redis/write`** (use `PATCH /users/:id` instead):
- ❌ `username` - Requires key migration
- ❌ `display_name` - Requires post denormalization
- ❌ `avatar` - Requires post denormalization

**System-Managed** (cannot update directly):
- ❌ `role` - Requires admin privileges
- ❌ `postCount` - Auto-calculated
- ❌ `followerCount` - Auto-calculated
- ❌ `followingCount` - Auto-calculated

**Can Update Freely:**
- ✅ `bio`
- ✅ `links`
- ✅ `email`, `phone`, `address` (private fields)
- ✅ Any custom fields

### Using the PATCH Endpoint (Recommended for Profile Fields)

For fields that require denormalization, use the dedicated endpoint:

```javascript
const response = await fetch('https://your-redis-service.com/users/me', {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    display_name: "Alice M. Smith",
    avatar: "https://new-avatar.jpg",
    bio: "Full-stack developer"
  })
});

const result = await response.json();
console.log(result.user); // Updated user object
```

**What happens behind the scenes:**
1. User profile updated
2. All your posts updated with new `display_name` and `avatar`
3. Ensures data consistency across the platform

## Using High-Level Endpoints

The microservice provides REST endpoints for common operations. These are simpler and handle complex logic automatically.

### Get Your Full Profile

```javascript
const response = await fetch('https://your-redis-service.com/users/me', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const data = await response.json();
console.log(data.user); // Full profile with all fields
```

### Update Your Profile

```javascript
const response = await fetch('https://your-redis-service.com/users/me', {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    display_name: "New Name",
    avatar: "https://new-avatar.jpg",
    bio: "Updated bio"
  })
});

const result = await response.json();
console.log(result.user); // Updated profile
```

### Follow a User

```javascript
const response = await fetch('https://your-redis-service.com/users/bob/follow', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const result = await response.json();
console.log(result.message); // "Successfully followed bob"
```

### Unfollow a User

```javascript
const response = await fetch('https://your-redis-service.com/users/bob/follow', {
  method: 'DELETE',
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const result = await response.json();
console.log(result.message); // "Successfully unfollowed bob"
```

### Like a Post

```javascript
const postId = "550e8400-e29b-41d4-a716-446655440000";
const response = await fetch(`https://your-redis-service.com/posts/${postId}/like`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const result = await response.json();
console.log(result.message); // "Post liked successfully"
```

### Unlike a Post

```javascript
const postId = "550e8400-e29b-41d4-a716-446655440000";
const response = await fetch(`https://your-redis-service.com/posts/${postId}/like`, {
  method: 'DELETE',
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const result = await response.json();
console.log(result.message); // "Post unliked successfully"
```

### Bookmark a Post

```javascript
const postId = "550e8400-e29b-41d4-a716-446655440000";
const response = await fetch(`https://your-redis-service.com/posts/${postId}/bookmark`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const result = await response.json();
console.log(result.message); // "Post bookmarked successfully"
```

### Create a Post

```javascript
const response = await fetch('https://your-redis-service.com/posts', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    content: "Hello world! #travel #adventure",
    media_url: "https://example.com/image.jpg",
    hashtags: ["travel", "adventure"]
  })
});

const result = await response.json();
console.log(result.post); // Created post object with ID
```

## Querying Other Users

### Get Another User's Profile

```javascript
const response = await fetch('https://your-redis-service.com/users/bob', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const data = await response.json();
console.log(data.user);
// {
//   username: "bob",
//   display_name: "Bob Johnson",
//   bio: "Designer",
//   avatar: "https://example.com/bob.jpg",
//   role: "user",
//   postCount: "25",
//   followerCount: "100",
//   followingCount: "50"
//   // Note: email, phone, and other sensitive fields are NOT included
// }
```

**Privacy Note:** Sensitive fields (email, phone, password, etc.) are automatically removed when viewing other users' profiles.

### Get Another User's Posts

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["ZREVRANGE", "user:bob:posts", "0", "9"]
  ])
});

const [postIds] = await response.json();
console.log(postIds); // Array of Bob's post IDs
```

### Get Another User's Followers

```javascript
const response = await fetch('https://your-redis-service.com/', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify([
    ["SMEMBERS", "user:bob:followers"]
  ])
});

const [followers] = await response.json();
console.log(followers); // Array of usernames
```

## Querying Feeds

### Explore Feed (Public Feed)

Get the global public feed (all posts, newest first):

```javascript
const response = await fetch('https://your-redis-service.com/feed/explore?offset=0&limit=20');

const data = await response.json();
console.log(data.posts); // Array of 20 posts with user data
console.log(data.totalCount); // Total posts in feed
console.log(data.hasMore); // Boolean: more posts available?
```

**No authentication required** for the explore feed.

### Following Feed (Personalized Feed)

Get posts from users you follow:

```javascript
const response = await fetch('https://your-redis-service.com/feed/following?offset=0&limit=20', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const data = await response.json();
console.log(data.posts); // Posts from users you follow
```

**Requires authentication** (needs to know who you follow).

### Hashtag Feed (Chronological)

Get posts with a specific hashtag, sorted by time:

```javascript
const response = await fetch('https://your-redis-service.com/feed/hashtag/travel?offset=0&limit=20', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const data = await response.json();
console.log(data.posts); // Posts with #travel, newest first
```

### Hashtag Feed (Ranked by Engagement)

Get trending posts with a specific hashtag:

```javascript
const response = await fetch('https://your-redis-service.com/feed/hashtag/travel/ranked?offset=0&limit=20', {
  headers: {
    'Authorization': `Bearer ${jwtToken}`
  }
});

const data = await response.json();
console.log(data.posts); // Posts with #travel, ranked by engagement
```

**Engagement formula:**
```
score = (likes*3 + comments*5 + bookmarks*4) / ((hours_since_posted) + 1)
```

This surfaces fresh, engaging content.

## React/Vue/Angular Integration Examples

### React Hook Example

Create a reusable hook for fetching user profile:

```javascript
import { useState, useEffect } from 'react';

function useUserProfile(jwtToken) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!jwtToken) return;

    fetch('https://your-redis-service.com/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([["HGETALL", "user:me"]])
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed to fetch profile');
        return res.json();
      })
      .then(([data]) => {
        setProfile(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [jwtToken]);

  return { profile, loading, error };
}

// Usage in component
function ProfileComponent({ jwtToken }) {
  const { profile, loading, error } = useUserProfile(jwtToken);

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      <h1>{profile.display_name}</h1>
      <p>{profile.bio}</p>
      <p>Posts: {profile.postCount}</p>
      <p>Followers: {profile.followerCount}</p>
    </div>
  );
}
```

### Vue Composable Example

Create a Vue 3 composable for user profile:

```javascript
import { ref, onMounted } from 'vue';

export function useUserProfile(jwtToken) {
  const profile = ref(null);
  const loading = ref(true);
  const error = ref(null);

  onMounted(async () => {
    if (!jwtToken.value) return;

    try {
      const response = await fetch('https://your-redis-service.com/', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${jwtToken.value}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([["HGETALL", "user:me"]])
      });

      if (!response.ok) {
        throw new Error('Failed to fetch profile');
      }

      const [data] = await response.json();
      profile.value = data;
    } catch (err) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
  });

  return { profile, loading, error };
}

// Usage in component
<script setup>
import { useUserProfile } from './composables/useUserProfile';

const jwtToken = ref('your-jwt-token');
const { profile, loading, error } = useUserProfile(jwtToken);
</script>

<template>
  <div v-if="loading">Loading...</div>
  <div v-else-if="error">Error: {{ error }}</div>
  <div v-else>
    <h1>{{ profile.display_name }}</h1>
    <p>{{ profile.bio }}</p>
    <p>Posts: {{ profile.postCount }}</p>
  </div>
</template>
```

### Angular Service Example

Create an Angular service for API calls:

```typescript
import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

interface UserProfile {
  username: string;
  display_name: string;
  bio: string;
  avatar: string;
  role: string;
  postCount: string;
  followerCount: string;
  followingCount: string;
}

@Injectable({
  providedIn: 'root'
})
export class RedisApiService {
  private baseUrl = 'https://your-redis-service.com';
  private jwtToken: string;

  constructor(private http: HttpClient) {}

  setToken(token: string) {
    this.jwtToken = token;
  }

  private getHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Authorization': `Bearer ${this.jwtToken}`,
      'Content-Type': 'application/json'
    });
  }

  getUserProfile(): Observable<UserProfile> {
    return this.http.post<any[]>(
      this.baseUrl,
      [["HGETALL", "user:me"]],
      { headers: this.getHeaders() }
    ).pipe(
      map(response => response[0])
    );
  }

  updateBio(newBio: string): Observable<any> {
    return this.http.post(
      `${this.baseUrl}/redis/write`,
      [["HSET", "user:me", "bio", newBio]],
      { headers: this.getHeaders() }
    );
  }

  followUser(username: string): Observable<any> {
    return this.http.post(
      `${this.baseUrl}/users/${username}/follow`,
      {},
      { headers: this.getHeaders() }
    );
  }
}

// Usage in component
export class ProfileComponent implements OnInit {
  profile: UserProfile;
  loading = true;

  constructor(private apiService: RedisApiService) {}

  ngOnInit() {
    this.apiService.getUserProfile().subscribe({
      next: (profile) => {
        this.profile = profile;
        this.loading = false;
      },
      error: (error) => {
        console.error('Error loading profile:', error);
        this.loading = false;
      }
    });
  }
}
```

## Error Handling

### Common Errors

**401 Unauthorized**
- **Cause:** Invalid or missing JWT token
- **Solution:** Check token is included in headers and hasn't expired

**403 Forbidden**
- **Cause:** Trying to access another user's private data or modify their profile
- **Solution:** Only access your own data or use public endpoints

**404 Not Found**
- **Cause:** User or post doesn't exist
- **Solution:** Verify the username/post ID is correct

**400 Bad Request**
- **Cause:** Invalid Redis command or malformed request
- **Solution:** Check command syntax and parameters

### Example Error Handling

```javascript
async function getUserProfile(jwtToken) {
  try {
    const response = await fetch('https://your-redis-service.com/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([["HGETALL", "user:me"]])
    });

    // Handle HTTP errors
    if (!response.ok) {
      if (response.status === 401) {
        // Token expired or invalid - redirect to login
        console.error('Authentication failed');
        window.location.href = '/login';
        return null;
      } else if (response.status === 403) {
        console.error('Access forbidden');
        return null;
      } else {
        const error = await response.json();
        console.error('API error:', error.error);
        return null;
      }
    }

    // Parse successful response
    const [data] = await response.json();
    return data;

  } catch (err) {
    // Handle network errors
    console.error('Network error:', err);
    return null;
  }
}
```

### Handling Token Expiration

```javascript
function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const expirationTime = payload.exp * 1000; // Convert to milliseconds
    return Date.now() >= expirationTime;
  } catch (err) {
    return true; // Invalid token format
  }
}

async function fetchWithTokenCheck(url, options) {
  const token = localStorage.getItem('jwt_token');

  if (!token || isTokenExpired(token)) {
    // Redirect to login or refresh token
    window.location.href = '/login';
    return null;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    }
  });
}
```

## Best Practices

### Security

✅ **Store JWT token securely**
- Use httpOnly cookies (preferred for web apps)
- Or use secure storage (React Native, mobile apps)
- Never use localStorage for sensitive tokens (vulnerable to XSS)

✅ **Refresh tokens before expiration**
- Check token expiration before each request
- Implement token refresh flow
- Redirect to login when refresh fails

✅ **Use HTTPS in production**
- Protects token in transit
- Prevents man-in-the-middle attacks

✅ **Never expose JWT_SECRET in frontend**
- Secret should only exist on backend
- Frontend only uses tokens, never generates them

✅ **Validate token on backend**
- Frontend validation is optional (UX improvement)
- Backend always validates tokens

### Performance

✅ **Batch multiple Redis commands in one request**
```javascript
// Good: Single request with multiple commands
const response = await fetch(url, {
  body: JSON.stringify([
    ["HGET", "user:me", "bio"],
    ["HGET", "user:me", "links"],
    ["HGET", "user:me", "avatar"]
  ])
});

// Bad: Three separate requests
const bio = await fetch(url, { body: JSON.stringify([["HGET", "user:me", "bio"]]) });
const links = await fetch(url, { body: JSON.stringify([["HGET", "user:me", "links"]]) });
const avatar = await fetch(url, { body: JSON.stringify([["HGET", "user:me", "avatar"]]) });
```

✅ **Use `includeUser=false` when you don't need user data**
```javascript
// If you only need post content, skip user data to improve performance
const response = await fetch('/feed/explore?offset=0&limit=20&includeUser=false');
```

✅ **Implement pagination for feeds**
```javascript
// Load posts in chunks, not all at once
function loadMorePosts(offset, limit = 20) {
  return fetch(`/feed/explore?offset=${offset}&limit=${limit}`);
}
```

✅ **Cache responses in frontend state**
```javascript
// React example: Cache in state management
const [profileCache, setProfileCache] = useState({});

async function getProfile(username) {
  if (profileCache[username]) {
    return profileCache[username]; // Return cached data
  }

  const profile = await fetchProfile(username);
  setProfileCache(prev => ({ ...prev, [username]: profile }));
  return profile;
}
```

✅ **Debounce search queries**
```javascript
import { debounce } from 'lodash';

const debouncedSearch = debounce(async (query) => {
  const results = await fetch(`/search/users?q=${query}`);
  // Update UI with results
}, 300); // Wait 300ms after user stops typing
```

### User Experience

✅ **Show loading states**
```javascript
function ProfileComponent() {
  const [loading, setLoading] = useState(true);

  return loading ? <Spinner /> : <ProfileView />;
}
```

✅ **Handle errors gracefully**
```javascript
function ProfileComponent() {
  const [error, setError] = useState(null);

  if (error) {
    return <ErrorMessage message={error} retry={loadProfile} />;
  }

  // ... render profile
}
```

✅ **Implement optimistic UI updates**
```javascript
async function likePost(postId) {
  // Update UI immediately (optimistic)
  setLiked(true);
  setLikesCount(prev => prev + 1);

  try {
    await fetch(`/posts/${postId}/like`, { method: 'POST' });
  } catch (err) {
    // Revert on error
    setLiked(false);
    setLikesCount(prev => prev - 1);
    showError('Failed to like post');
  }
}
```

## Performance Tips

**1. Batch Requests**
- Send multiple Redis commands in one HTTP request
- Reduces network round-trips

**2. Use High-Level Endpoints When Available**
- Endpoints like `/users/:id` and `/feed/explore` optimize queries
- They return formatted data and handle complex logic

**3. Implement Infinite Scroll**
- Load feeds in chunks (20-50 posts at a time)
- Use pagination with offset/limit

**4. Cache Aggressively**
- Cache user profiles in state management (Redux, Zustand, etc.)
- Invalidate cache on updates

**5. Debounce User Input**
- Debounce search queries, autocomplete
- Reduces unnecessary API calls

**6. Use WebSockets for Real-Time Updates** (if implemented)
- Subscribe to real-time events (new posts, likes, follows)
- Reduces polling overhead

## Security Considerations

**1. Never Expose JWT_SECRET**
- Secret must stay on backend
- Frontend only receives signed tokens

**2. Always Use HTTPS in Production**
- Protects token from interception
- Required for secure authentication

**3. Validate JWT Expiration**
- Check token expiration on frontend (better UX)
- Backend always validates (security)

**4. Don't Store Sensitive Data in localStorage**
- Vulnerable to XSS attacks
- Use httpOnly cookies or secure storage

**5. Implement CSRF Protection**
- If using cookies, implement CSRF tokens
- Or use Authorization header (immune to CSRF)

**6. Rate Limit API Calls**
- Implement rate limiting on backend
- Prevent abuse and DDoS attacks

---

**See Also:**
- [REDIS_KEYS.md](./REDIS_KEYS.md) - Complete Redis key structure reference
- [XANO_SYNC_GUIDE.md](./XANO_SYNC_GUIDE.md) - Xano synchronization guide
- [README.md](../README.md) - Main project documentation
