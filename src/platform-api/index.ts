/**
 * Eks-Health Platform API — Public Barrel
 *
 * Re-exports the GraphQL engine and the webhook system. Import from
 * `@/platform-api` (server-only).
 *
 *   import { getGraphQL, getWebhooks } from "@/platform-api";
 */

export * from "./graphql";
export * from "./webhooks";
