/**
 * Giggora explorer API — server bootstrap (brief §23, §24, §30).
 *
 * Fastify, run directly by Node 24's native TypeScript stripping. No build step,
 * so nothing here may use TS features that need transformation (no enums, no
 * namespaces, no parameter properties, no decorators).
 *
 * Security posture:
 *   - rate limiting on every route (§24, §30)
 *   - internal errors are logged in full but NEVER returned to the client;
 *     a Postgres error leaking outward would disclose the schema
 *   - all SQL is parameterised in db.ts; input is validated in validate.ts
 *   - no admin surface, no key material, no write endpoints of any kind
 */

import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { env, pool, closePool } from "./db.ts";
import { ValidationError } from "./validate.ts";
import { registerRoutes } from "./routes.ts";

const PORT = Number(process.env.API_PORT ?? 4100);
const HOST = process.env.API_HOST ?? "0.0.0.0";

export async function build() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Structured logging (brief §31).
      transport: undefined,
    },
    // Reject absurd request lines early.
    bodyLimit: 64 * 1024,
    // trustProxy MUST name the proxy, never `true`.
    //
    // With `true`, Fastify believes any X-Forwarded-For the client sends. The
    // rate limiter keys on req.ip, so a client could rotate that header to get
    // unlimited requests, or pin a victim's IP into a 429 bucket. Default here
    // is false (use the real socket address); set TRUSTED_PROXY_CIDR to Caddy's
    // address when running behind it.
    trustProxy: process.env.TRUSTED_PROXY_CIDR || false,
    requestTimeout: 20_000,
    keepAliveTimeout: 15_000,

    // Any param we accept is at most 66 characters (a 0x hash). The default of
    // 100 meant a 101-character param was rejected by the ROUTER with a 414 and
    // Fastify's own error shape, instead of reaching validate.ts and getting a
    // clean 400 with a useful message.
    maxParamLength: 128,

    // Router-level failures (invalid percent-escapes, over-length params) are
    // answered BEFORE the request lifecycle starts, so they never reach
    // setErrorHandler. Left to Fastify's defaults they returned the internal
    // FST_ERR_* code, a non-standard envelope, and — worst — the attacker's raw
    // request line echoed back verbatim, up to ~4KB of reflected input.
    frameworkErrors: (_err, _req, reply) => {
      return reply.status(400).send({ error: "bad_request", message: "Invalid request" });
    },
  });

  // Brief §24: "Rate-limit public users."
  //
  // Registered BEFORE cors deliberately: @fastify/cors installs an onRequest
  // hook that short-circuits OPTIONS preflight, so with cors first a client
  // could send unlimited preflight requests that the limiter never counted.
  //
  // NOTE: deliberately NO errorResponseBuilder. When one is supplied,
  // @fastify/rate-limit throws the returned plain OBJECT as the error — it
  // arrives at setErrorHandler with constructor Object, no statusCode, no code,
  // and reply.statusCode still 200. There is then no way to recognise it as a
  // rate-limit rejection, so it falls through to the generic 500 branch and
  // clients get "internal_error" while being throttled.
  //
  // Letting the plugin throw its own error keeps statusCode 429 authoritative;
  // the error handler below reshapes it into our standard envelope.
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
    // Keyed by IP using the plugin's DEFAULT generator, deliberately. It masks
    // IPv6 to a /64, which is the unit ISPs hand a single subscriber. An earlier
    // `keyGenerator: (req) => req.ip` bypassed that, so any IPv6 client could
    // rotate through its own /64 (2^64 addresses) and never hit the limit. An
    // API-key tier (§24) would slot in here and must call normalizeIP itself.
  });

  await app.register(cors, { origin: true, methods: ["GET"] });

  // -------------------------------------------------------------------------
  // Error handling.
  //
  // ValidationError -> 404/400 with the caller's own message (safe, it is about
  // their input). Everything else -> a generic 500. The real error goes to the
  // log, never to the client: a raw Postgres message would disclose table and
  // column names.
  // -------------------------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ValidationError) {
      return reply.status(400).send({ error: "bad_request", message: err.message });
    }

    // Any error carrying a 4xx is a CLIENT error and must keep its status.
    //
    // Getting this wrong is not cosmetic: an earlier version only special-cased
    // `err.statusCode === 429`, so rate-limit rejections fell through to the
    // generic 500 branch. Clients then saw "internal_error" while being
    // throttled, responses lost their pagination envelope, and the next page
    // request sent `cursor=undefined`. One misclassified status cascaded into
    // three unrelated-looking failures. Check the reply status too, because
    // plugins set it on the reply before throwing.
    const status = (err as any).statusCode ?? reply.statusCode;

    if (status === 429 || (err as any).code === "FST_ERR_RATE_LIMIT") {
      return reply.status(429).send({
        error: "rate_limited",
        message: "Too many requests",
      });
    }

    if ((err as any).validation) {
      return reply.status(400).send({ error: "bad_request", message: "Invalid request parameters" });
    }

    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.status(status).send({ error: "bad_request", message: "Invalid request" });
    }

    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal_error", message: "Internal server error" });
  });

  // The limiter is an onRequest hook on MATCHED routes only, so unrouted
  // requests bypassed it completely: 10 requests to /nope cost zero budget while
  // still driving HTTP parsing, socket and log work. Attaching app.rateLimit()
  // as a preHandler closes that gap.
  app.setNotFoundHandler(
    { preHandler: app.rateLimit() },
    (_req, reply) => {
      reply.status(404).send({ error: "not_found", message: "No such endpoint" });
    }
  );

  // Health check (brief §28, §31). Reports database reachability, since an API
  // that answers 200 while its database is down is worse than one that fails.
  app.get("/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok", chainId: Number(env.CHAIN_ID), database: "ok" };
    } catch {
      return reply.status(503).send({ status: "degraded", database: "unreachable" });
    }
  });

  await registerRoutes(app);

  return app;
}

// Only start listening when run directly, so tests can import build().
const isMain = process.argv[1] && process.argv[1].endsWith("server.ts");
if (isMain) {
  const app = await build();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Giggora explorer API listening on ${HOST}:${PORT} (chain ${env.CHAIN_ID})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
