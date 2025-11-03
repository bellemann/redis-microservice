#!/bin/bash

# Apply Critical Fixes to index.js
echo "Applying critical fixes to index.js..."

# Fix 1: Ranking score calculation - remove /1000 from Date.now() and fix age calculation
sed -i.tmp1 's/const currentTime = Date\.now() \/ 1000; \/\/ Convert to seconds/const currentTime = Date.now();/g' index.js
sed -i.tmp2 's/const currentTime = Date\.now() \/ 1000;/const currentTime = Date.now();/g' index.js
sed -i.tmp3 's/const createdAt = parseInt(postData\.created_at) \/ 1000;/const createdAt = parseInt(postData.created_at);/g' index.js
sed -i.tmp4 's/(currentTime - createdAt) \/ 3600/(currentTime - createdAt) \/ 3600000/g' index.js

# Fix 2: Two weeks constant - change from seconds to milliseconds
sed -i.tmp5 's/const twoWeeksInSeconds = 14 \* 24 \* 3600;/const twoWeeksInMs = 14 * 24 * 3600 * 1000;/g' index.js
sed -i.tmp6 's/(currentTime - createdAt) > twoWeeksInSeconds/(currentTime - createdAt) > twoWeeksInMs/g' index.js

# Fix 3: Fallback scan limit
sed -i.tmp7 's/if (currentOffset > 10000) break;/if (currentOffset > 3000) break; \/\/ Reduced for performance/g' index.js

# Fix 4: Use extractHashtags function everywhere
# This is complex and requires manual review due to context

echo "Critical fixes applied!"
echo "Temp files created: *.tmp*"
echo "Please review changes and remove .tmp files when satisfied"
echo ""
echo "MANUAL FIXES STILL REQUIRED:"
echo "1. Replace all hashtag extraction with extractHashtags() function"
echo "2. Add invalidateFeedCaches() after mutations"
echo "3. Fix engagement tracking to use author role"
echo "4. Fix isLiked/isBookmarked boolean conversion"
echo "5. Add postsPerHashtag validation"
echo "6. Filter banned posts in aggregation"
