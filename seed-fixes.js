// This file contains all the critical fixes that need to be applied to index.js
// Due to file size, implementing incrementally

/*
FIXES TO APPLY:

1. Ranking Score Calculation (Comment 1):
   - Use milliseconds consistently
   - Change: const currentTime = Date.now() / 1000;
   - To: const currentTime = Date.now();
   - Change: const createdAt = parseInt(postData.created_at) / 1000;
   - To: const createdAt = parseInt(postData.created_at);
   - Change: const ageInHours = (currentTime - createdAt) / 3600;
   - To: const ageInHours = (currentTime - createdAt) / 3600000;

2. Engagement Tracking (Comment 2):
   - Fetch author role from Redis before updating models:top:engagement
   - Replace: if (postData.user_id && req.user.role === 'model')
   - With: const authorRole = await trackedRedis.hget(`user:${postData.user_id}`, 'role');
           if (authorRole === 'model')

3. isLiked/isBookmarked Conversion (Comment 4):
   - In aggregatePostsWithUsers, fix:
   - const isLikedNum = parseInt(isLiked) || 0;
   - const isLiked = isLikedNum === 1;

4. Post Author Role Denormalization (Comment 16):
   - Add user_role field when creating posts

5. Hashtag Extraction (Comment 8):
   - Use extractHashtags() function everywhere
   - Normalize hashtags (lowercase, deduplicate)

6. Cache Invalidation (Comment 3):
   - Call invalidateFeedCaches() after mutations

7. postsPerHashtag Validation (Comment 14):
   - Add: if (postsPerHashtag > 50) postsPerHashtag = 50;

8. Banned Posts Filtering (Comment 15):
   - In aggregatePostsWithUsers, skip posts with banned === 'true'

9. Following Feed Fallback Limit (Comment 11):
   - Change: if (currentOffset > 10000) break;
   - To: if (currentOffset > 3000) break;

10. User Deletion Likes Decrement (Comment 5):
    - When removing from post:*:likes, also decrement likesCount

11. Post Deletion Bookmarks Cleanup (Comment 6):
    - Before deleting post:*:bookmarks, get members and remove from user:*:bookmarked

12. User Cache Invalidation (Comment 12):
    - Delete userCache[userId] in PATCH /users/:id and follow/unfollow

13. Tracked Redis Usage (Comment 18):
    - Replace redis.sismember with trackedRedis.sismember

14. 2-Week TTL Cleanup (Comment 10):
    - Add ZREM for posts older than 2 weeks in ranked feeds

15. Display Name Update (Comment 17):
    - Update display_name in all posts when it changes in PATCH /users/:id
*/

export const CRITICAL_FIXES = {
  RANKING_FORMULA: {
    before: 'const currentTime = Date.now() / 1000',
    after: 'const currentTime = Date.now()',
    ageCalculation: {
      before: '(currentTime - createdAt) / 3600',
      after: '(currentTime - createdAt) / 3600000'
    }
  },
  TWO_WEEKS_MS: 14 * 24 * 3600 * 1000,
  MAX_FALLBACK_OFFSET: 3000,
  MAX_POSTS_PER_HASHTAG: 50
};
