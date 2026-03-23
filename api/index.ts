import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handle } from 'hono/vercel';
import { Redis } from '@upstash/redis';
import { serve } from '@hono/node-server';

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

// 1. Initialize Upstash Redis (Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars)
// Get these for free at https://upstash.com
const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL || '',
  token: env.UPSTASH_REDIS_REST_TOKEN || '',
});

const app = new Hono();

// 2. Apply the CORS middleware
app.use(
  '*',
  cors({
    origin: [
      'https://classpad.dev',
      'https://store.classpad.dev',
      'https://classpaddev.github.io',
    ],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  })
);

// --- HELPER FUNCTIONS ---

// Helper to increment a stat safely using Redis Hashes
async function bumpStat(appId: string, statType: "views" | "downloads") {
  // HINCRBY atomically increments a specific field in a hash
  await redis.hincrby(`app:${appId}`, statType, 1);
  // SADD adds the appId to a set so we can easily list all apps later
  await redis.sadd('all_apps', appId);
}

// Helper to safely add a rating
async function addRating(appId: string, newRating: number) {
  // Instead of complicated locking, we just atomically increment the count AND the total sum of scores.
  // We calculate the average on the fly when requested!
  await redis.hincrby(`app:${appId}`, 'ratingCount', 1);
  await redis.hincrby(`app:${appId}`, 'ratingTotal', newRating);
  await redis.sadd('all_apps', appId);
}

// --- ROUTES ---

// 1. Health/Root Route
app.get("/", (c) => c.text("ClassPadDev !! [ >v<]~ "));

let cachedReport: any = null;
let lastCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SYNC_SOURCE = 'https://store-tracker.phoebee.deno.net';

type ReportItem = {
  appId: string;
  views?: number;
  downloads?: number;
  ratingCount?: number;
  averageScore?: number;
};

// 2. Get ALL App Stats (Reporting Endpoint)
app.get("/report-all-stats-please", async (c) => {
  const now = Date.now();
  if (cachedReport && now - lastCacheTime < CACHE_TTL) {
    return c.json(cachedReport);
  }

  // Get all known App IDs from our Redis set
  const appIds = await redis.smembers('all_apps');
  
  if (!appIds || appIds.length === 0) {
    return c.json([]);
  }

  // Use Redis pipeline to fetch all app data in a single network request
  const pipeline = redis.pipeline();
  for (const appId of appIds) {
    pipeline.hgetall(`app:${appId}`);
  }
  
  const results = await pipeline.exec();
  
  const allApps = appIds.map((appId, index) => {
    const data: any = results[index] || {};
    
    const views = Number(data.views || 0);
    const downloads = Number(data.downloads || 0);
    const ratingCount = Number(data.ratingCount || 0);
    const ratingTotal = Number(data.ratingTotal || 0);
    
    // Calculate average safely
    const rawAvg = ratingCount > 0 ? (ratingTotal / ratingCount) : 0;
    const averageScore = Math.round(rawAvg * 10) / 10;
    
    return {
      appId: String(appId),
      views,
      downloads,
      ratingCount,
      averageScore
    };
  });

  // Sort the array so the most downloaded apps are at the top
  allApps.sort((a, b) => b.downloads - a.downloads);

  // Update the cache
  cachedReport = allApps;
  lastCacheTime = now;

  return c.json(allApps);
});

// 3. Sync all stats from another compatible API (Protected with SYNC_SECRET)
app.post("/sync-from-source", async (c) => {
  const secretFromQuery = c.req.query("secret");
  const syncSecret = env.SYNC_SECRET;

  if (!syncSecret) {
    return c.json({ error: "SYNC_SECRET is not configured on this server" }, 500);
  }

  if (secretFromQuery !== syncSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sourceUrlParam = c.req.query("sourceUrl") || DEFAULT_SYNC_SOURCE;
  let sourceUrl: URL;

  try {
    sourceUrl = new URL(sourceUrlParam);
  } catch {
    return c.json({ error: "Invalid sourceUrl query parameter" }, 400);
  }

  const reportUrl = new URL('/report-all-stats-please', sourceUrl).toString();

  const response = await fetch(reportUrl);
  if (!response.ok) {
    return c.json(
      { error: "Failed to fetch source report", sourceStatus: response.status, reportUrl },
      502
    );
  }

  const reportData = (await response.json()) as ReportItem[];
  if (!Array.isArray(reportData)) {
    return c.json({ error: "Invalid source response: expected an array" }, 502);
  }

  const pipeline = redis.pipeline();
  let syncedApps = 0;

  for (const item of reportData) {
    const appId = String(item.appId || '').trim();
    if (!appId) {
      continue;
    }

    const views = Number(item.views || 0);
    const downloads = Number(item.downloads || 0);
    const ratingCount = Number(item.ratingCount || 0);
    const averageScore = Number(item.averageScore || 0);
    const ratingTotal = Math.round(averageScore * ratingCount);

    pipeline.hset(`app:${appId}`, {
      views,
      downloads,
      ratingCount,
      ratingTotal,
    });
    pipeline.sadd('all_apps', appId);
    syncedApps += 1;
  }

  await pipeline.exec();

  // Bust cache so next report request reflects synced data
  cachedReport = null;
  lastCacheTime = 0;

  return c.json({
    success: true,
    syncedApps,
    source: sourceUrl.origin,
  });
});

// 4. Track a View (Standard API)
app.post("/view/:appId", async (c) => {
  const appId = c.req.param("appId");
  await bumpStat(appId, "views");
  return c.json({ success: true, message: `View incremented for ${appId}` });
});

// 5. Track a View (Tracking Pixel)
app.get("/pixel/view/:appId", async (c) => {
  const appId = c.req.param("appId");
  await bumpStat(appId, "views");
  
  const transparentSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
  
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');

  return c.body(transparentSvg);
});

// 6. Track a Download (Icon Pixel)
app.get("/pixel/download/:appId", async (c) => {
  const appId = c.req.param("appId");
  await bumpStat(appId, "downloads");
  
  const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M14 22h-4c-3.771 0-5.657 0-6.828-1.172S2 17.771 2 14v-4c0-3.771 0-5.657 1.172-6.828S6.239 2 10.03 2c.606 0 1.091 0 1.5.017q-.02.12-.02.244l-.01 2.834c0 1.097 0 2.067.105 2.848c.114.847.375 1.694 1.067 2.386c.69.69 1.538.952 2.385 1.066c.781.105 1.751.105 2.848.105h4.052c.043.534.043 1.19.043 2.063V14c0 3.771 0 5.657-1.172 6.828S17.771 22 14 22" clip-rule="evenodd" opacity="0.5"/><path fill="currentColor" d="M10.56 15.498a.75.75 0 1 0-1.12-.996l-2.107 2.37l-.772-.87a.75.75 0 0 0-1.122.996l1.334 1.5a.75.75 0 0 0 1.12 0zm.95-13.238l-.01 2.835c0 1.097 0 2.066.105 2.848c.114.847.375 1.694 1.067 2.385c.69.691 1.538.953 2.385 1.067c.781.105 1.751.105 2.848.105h4.052q.02.232.028.5H22c0-.268 0-.402-.01-.56a5.3 5.3 0 0 0-.958-2.641c-.094-.128-.158-.204-.285-.357C19.954 7.494 18.91 6.312 18 5.5c-.81-.724-1.921-1.515-2.89-2.161c-.832-.556-1.248-.834-1.819-1.04a6 6 0 0 0-.506-.154c-.384-.095-.758-.128-1.285-.14z"/></svg>';
  
  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');

  return c.body(iconSvg);
});

// 7. Track a Download
app.post("/download/:appId", async (c) => {
  const appId = c.req.param("appId");
  await bumpStat(appId, "downloads");
  return c.json({ success: true, message: `Download incremented for ${appId}` });
});

// 8. Rate an App
app.post("/rate/:appId", async (c) => {
  const appId = c.req.param("appId");
  
  try {
    const body = await c.req.json();
    const rating = body.rating;

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return c.json({ error: "Rating must be an integer between 1 and 5" }, 400);
    }

    await addRating(appId, rating);
    return c.json({ success: true, message: `Rating of ${rating} added for ${appId}` });

  } catch (e) {
    return c.json({ error: "Invalid JSON body. Expected { \"rating\": 5 }" }, 400);
  }
});

// 9. Get Stats for a Single App
app.get("/stats/:appId", async (c) => {
  const appId = c.req.param("appId");
  
  // Fetch the hash for this specific app
  const data: any = await redis.hgetall(`app:${appId}`);
  
  const views = Number(data?.views || 0);
  const downloads = Number(data?.downloads || 0);
  const ratingCount = Number(data?.ratingCount || 0);
  const ratingTotal = Number(data?.ratingTotal || 0);
  
  // Calculate average safely
  const rawAvg = ratingCount > 0 ? (ratingTotal / ratingCount) : 0;
  const averageScore = Math.round(rawAvg * 10) / 10; 

  return c.json({
    appId,
    views,
    downloads,
    ratingCount,
    averageScore
  });
});

// For Vercel Edge / Cloudflare Workers
export const config = {
  runtime: 'edge',
};

export default handle(app);

if (env.RENDER) {
  serve({ fetch: app.fetch, port: Number(env.PORT) || 3000 });
}
