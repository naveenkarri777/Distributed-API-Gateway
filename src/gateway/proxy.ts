// src/gateway/proxy.ts
//
// Streaming Proxy Factory:
// Wraps http-proxy-middleware to stream HTTP requests chunk-by-chunk
// to upstream backend microservices without buffering entire payloads in RAM.

import { createProxyMiddleware, fixRequestBody, Options } from 'http-proxy-middleware';
import { ServerResponse } from 'http';

/**
 * Creates an Express middleware that forwards matching requests to targetUrl.
 *
 * @param targetUrl   Base URL of the upstream service (e.g. http://localhost:4001)
 * @param pathRewrite Optional path rewrite rules (e.g. { '^/api/users': '/users' })
 * @param pathFilter  Optional URL path prefix filter
 */
export function createServiceProxy(
  targetUrl: string,
  pathRewrite?: Record<string, string>,
  pathFilter?: string
) {
  const options: Options = {
    target: targetUrl,

    // Rewrites Host header to match the upstream target
    changeOrigin: true,

    // Rewrites path prefix (e.g. /api/users/123 -> /users/123)
    pathRewrite: pathRewrite,

    // Only forward requests matching this prefix
    pathFilter: pathFilter,

    on: {
      // Re-streams bodies if pre-parsed by body-parsers
      proxyReq: fixRequestBody,

      // Catches unreachable upstream services cleanly (502 Bad Gateway)
      error: (err: Error, _req, res) => {
        console.error(`[Proxy Error] Upstream unreachable: ${err.message}`);
        const serverRes = res as ServerResponse;
        if (!serverRes.headersSent) {
          const body = JSON.stringify({
            error: 'Bad Gateway',
            message: `Could not reach upstream service: ${err.message}`,
          });
          serverRes.writeHead(502, { 'Content-Type': 'application/json' });
          serverRes.end(body);
        }
      },
    },
  };

  return createProxyMiddleware(options);
}
