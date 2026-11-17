/**
 * Per-IP rate limiting using Cloudflare's native Rate Limiting API.
 *
 * The bindings and their limits are declared in wrangler.jsonc:
 *   API_RATE_LIMITER   60 requests / 60 seconds
 *   PAGE_RATE_LIMITER 120 requests / 60 seconds
 *
 * Cloudflare counts requests per Cloudflare location and the result is
 * approximate. For a strict global limit, use a Durable Object instead.
 */
import { defineMiddleware } from "astro:middleware";
import type { APIContext } from "astro";
import { env } from "cloudflare:workers";

interface RateLimitPolicy {
  binding: keyof Env;
  periodSeconds: number;
  /** First matching policy wins. */
  matches: (pathname: string) => boolean;
  contentType: "json" | "text";
}

const policies: RateLimitPolicy[] = [
  {
    binding: "API_RATE_LIMITER",
    periodSeconds: 60,
    matches: (pathname) => pathname === "/api" || pathname.startsWith("/api/"),
    contentType: "json",
  },
  {
    binding: "PAGE_RATE_LIMITER",
    periodSeconds: 60,
    matches: () => true,
    contentType: "text",
  },
];

/** Static files are served before middleware, but skip them in dev too. */
const SKIPPED_PATHS = new Set([
  "/favicon.ico",
  "/favicon.svg",
  "/robots.txt",
  "/sitemap-index.xml",
  "/sitemap-0.xml",
]);

function isSkipped(pathname: string) {
  return pathname.startsWith("/_astro/") || SKIPPED_PATHS.has(pathname);
}

function normalizeAddress(address: string) {
  const normalized = address.trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

function getClientKey(context: APIContext) {
  try {
    const address = context.clientAddress.trim();
    return address ? normalizeAddress(address) : null;
  } catch {
    // clientAddress is unavailable for prerendered/static responses.
    return null;
  }
}

function tooManyRequests(policy: RateLimitPolicy) {
  const headers = new Headers({
    "Retry-After": String(policy.periodSeconds),
    "Cache-Control": "no-store",
    Server: "MongoCraft",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });

  if (policy.contentType === "json") {
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers,
    });
  }

  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response("Too many requests. Please try again shortly.", {
    status: 429,
    headers,
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  if (isSkipped(pathname)) {
    return next();
  }

  const policy = policies.find((candidate) => candidate.matches(pathname));
  const clientKey = getClientKey(context);

  if (!policy || !clientKey) {
    return next();
  }

  const limiter = env[policy.binding];
  if (!limiter) {
    console.warn(
      `[rate-limit] Missing Cloudflare binding "${policy.binding}"; allowing request.`,
    );
    return next();
  }

  const { success } = await limiter.limit({ key: clientKey });
  if (!success) {
    return tooManyRequests(policy);
  }

  const response = await next();
  response.headers.set("Server", "MongoCraft");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  return response;
});
