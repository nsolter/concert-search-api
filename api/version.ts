export const config = { runtime: 'edge' };

export default function handler(req: Request) {
  // Set these in Vercel env vars
  const ios = process.env.MIN_VERSION_IOS ?? '1.0.0';
  const android = process.env.MIN_VERSION_ANDROID ?? '1.0.0';
  const iosStoreUrl = process.env.IOS_STORE_URL ?? '';
  const androidStoreUrl = process.env.ANDROID_STORE_URL ?? 'https://play.google.com/store/apps/details?id=com.nimbuspeaksolutions.i-was-there';

  return new Response(JSON.stringify({ ios, android, iosStoreUrl, androidStoreUrl }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
