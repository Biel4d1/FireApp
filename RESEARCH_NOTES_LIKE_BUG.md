# Root Cause Analysis: Like/Dislike Heart Becoming White After Page Refresh

## Problem Summary
When a user likes or dislikes a video and then refreshes the page, the heart icon becomes white (unfilled), indicating that the like/dislike status is not persisting after a page refresh.

## Root Causes Identified

### 1. **VideoDetailItem State Initialization Issue** ⚠️ PRIMARY ISSUE
**File:** [app/video/[id].tsx](app/video/[id].tsx#L43-L50)

```typescript
const [isLikedByMe, setIsLikedByMe] = useState<boolean>(() => item?.is_liked ?? false);
const [isDislikedByMe, setIsDislikedByMe] = useState<boolean>(() => item?.is_disliked ?? false);
```

**Problem:**
- The state initialization depends on the `item` prop from the parent
- The parent (`SingleVideoScreen`) fetches videos from `/personalized_feed` endpoint on mount
- The issue: **The `item` prop might be passed down BEFORE the server response arrives, or the item doesn't have the `is_liked` flag properly set**

### 2. **Server Response Trust Issue** ⚠️ SECONDARY ISSUE
**File:** [app/video/[id].tsx](app/video/[id].tsx#L54-L60)

```typescript
useEffect(() => {
  try {
    setIsLikedByMe(Boolean(item?.is_liked));
    setIsDislikedByMe(Boolean(item?.is_disliked));
    setLikesCount(item?.likes_count ?? 0);
    setDislikesCount(item?.dislikes_count ?? 0);
  } catch (e) {}
}, [item?.id, item?.is_liked, item?.is_disliked, item?.likes_count, item?.dislikes_count]);
```

**Problem:**
- This useEffect should re-sync when item changes, BUT the dependency array doesn't properly include the video ID
- The dependency is `item?.id` but the comparison is against `item?.is_liked`, which could cause the effect to not trigger properly
- The condition checks are converting to boolean but the initial state might receive a falsy value that wasn't meant to be `false`

### 3. **Data Flow Problem in SingleVideoScreen** ⚠️ CRITICAL ISSUE
**File:** [app/video/[id].tsx](app/video/[id].tsx#L462-L475)

```typescript
const normalized = allVideos.map((v: any) => {
  const storedVideo = videoStore.getVideo(v.id);
  return {
    ...v,
    comments_count: Math.max(Number(storedVideo?.comments_count ?? 0), Number((v.comments_count ?? v.comments ?? v.comment_count ?? 0) ?? 0)),
    likes_count: storedVideo?.likes_count ?? v.likes_count,
    // Trust server's is_liked (it's authoritative for current user)
    is_liked: v.is_liked ?? storedVideo?.is_liked,  // ⚠️ Issue: What if v.is_liked is undefined or not returned?
    // mark initialPlay if this video was navigated from a grid with play intent
    initialPlay: String(v.id) === String(id) && String(initialPlaying) === '1' ? '1' : undefined,
    // include dislikes so single-video view shows authoritative dislike counts
    dislikes_count: storedVideo?.dislikes_count ?? v.dislikes_count ?? 0,
    is_disliked: v.is_disliked ?? storedVideo?.is_disliked ?? false,  // ⚠️ Has default, but is_liked doesn't!
  };
});
```

**Problems:**
1. **Missing default value for `is_liked`**: Unlike `is_disliked` which has `?? false`, `is_liked` has NO default
   - When server returns undefined/null for `is_liked`, it stays undefined
   - `undefined ?? storedVideo?.is_liked` returns `undefined` if stored value is also undefined
   - Later when used in boolean context, `undefined` becomes `false`

2. **Server might not always return the flag**: Need to check if backend always includes `is_liked` and `is_disliked`

### 4. **Backend Response Verification Required**
**File:** [backend.py](backend.py#L1835-1860)

The backend personalized_feed endpoint DOES return `is_liked` and `is_disliked`:
```python
'is_liked': is_liked_flag,
'is_disliked': is_disliked_flag,
```

BUT there are multiple code paths:
- **For new users** (line 1768-1773): `'is_liked': False, 'is_disliked': False` ✓
- **For authenticated users with Redis** (line 1835-1857): Checks `redis_conn.sismember()` ✓  
- **For authenticated users without Redis** (line 1858-1860): Uses DB values ✓

All paths return the flags, so the issue is on the **frontend data normalization**.

## Why the Heart Turns White

1. **User likes a video** → Heart turns red (optimistic update)
2. **User refreshes the page** → `SingleVideoScreen` fetches videos
3. **Server returns `is_liked: true`** for that video ✓
4. BUT: **Frontend receives undefined for `is_liked`** because:
   - Line 468: `is_liked: v.is_liked ?? storedVideo?.is_liked` evaluates to undefined
   - Line 43 state init: `useState(() => item?.is_liked ?? false)` → `false`
5. **Heart renders white** because `isLikedByMe === false`

## The Fix

**Add missing default value for `is_liked` in data normalization:**

```typescript
// Change from:
is_liked: v.is_liked ?? storedVideo?.is_liked,

// To:
is_liked: v.is_liked ?? storedVideo?.is_liked ?? false,
```

This ensures that even if the server response is missing the `is_liked` field, it defaults to `false` instead of `undefined`.

---

## Additional Related Issues to Check

1. **In Feed Screen** ([app/(tabs)/index.tsx](app/(tabs)/index.tsx#L1260-1266)): Same pattern needs verification
2. **In Explore Screen** ([app/(tabs)/explore.tsx](app/(tabs)/explore.tsx#L229-247)): Has proper defaults but verify consistency
3. **VideoStore persistence**: The video store should preserve state across page refreshes, but it seems to be getting overwritten by the server response

