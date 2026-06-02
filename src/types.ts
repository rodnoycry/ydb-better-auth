import type { DBAdapterDebugLogOption } from "better-auth/adapters"
import type { QueryClient, TX } from "@ydbjs/query"
import type { Value } from "@ydbjs/value"

export type YdbAdapterConfig = {
    /**
     * Helps you debug issues with the adapter.
     */
    debugLogs?: DBAdapterDebugLogOption
    /**
     * If the table names in the schema are plural.
     */
    usePlural?: boolean
    /**
     * Lazy QueryClient resolver. Done through callback to support FaaS driver
     * handling — each invocation may return a fresh client tied to the current
     * request lifecycle.
     * https://github.com/ydb-platform/ydb-js-sdk/tree/main/examples/sls#readme
     */
    getSql: () => QueryClient
    /**
     * Path the better-auth CLI writes the generated schema to when no `--output`
     * flag is passed. Defaults to `./migrations/schema.yql`.
     */
    schemaOutputPath?: string
}

/**
 * The query executor has the same callable shape whether we're outside a
 * transaction (a `QueryClient` from `query(driver)`) or inside one (a `TX`
 * yielded by `sql.begin(...)`). Both are callable as `executor(text)` and
 * expose `.parameter(...)`. We only need to discriminate when *starting* a
 * transaction — see `isTx` and the `update` / `updateMany` / `deleteMany`
 * methods that re-enter the same logic with a tx-bound executor.
 */
export type Executor = QueryClient | TX

/**
 * `transactionId` is set on the `TX` yielded inside `sql.begin(...)` and
 * absent on a top-level `QueryClient`. It's the cleanest runtime
 * discriminator the SDK exposes — see the SDK's async-local context, which
 * notes it's "the only piece that's not derivable from Session":
 * https://github.com/ydb-platform/ydb-js-sdk/blob/main/packages/query/src/ctx.ts
 */
export const isTx = (executor: Executor): executor is TX =>
    "transactionId" in executor

export type ParamMap = Map<string, Value>
export type AnyQuery = ReturnType<Executor>
