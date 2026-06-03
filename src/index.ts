import { createAdapterFactory } from "better-auth/adapters"
import type { YdbAdapterConfig } from "./types.ts"
import { buildAdapterMethods } from "./methods.ts"
import { buildSchemaDdl } from "./schema.ts"

export type { YdbAdapterConfig } from "./types.ts"

const DEFAULT_SCHEMA_PATH = "./migrations/schema.yql"

export const ydbAdapter: (
    config: YdbAdapterConfig,
) => ReturnType<typeof createAdapterFactory> = ({ getSql, ...config }) => {
    return createAdapterFactory({
        config: {
            adapterId: "ydb-adapter",
            adapterName: "YDB Adapter",
            usePlural: config.usePlural ?? false,
            debugLogs: config.debugLogs ?? false,
            // YDB has a native JSON column type; we JSON.stringify before binding.
            supportsJSON: true,
            // YDB's Datetime maps cleanly from JS Date via fromJs (second precision).
            supportsDates: true,
            supportsBooleans: true,
            // Row tables don't allow List columns, so the framework JSON-stringifies
            // arrays for us into Utf8 columns.
            supportsArrays: false,
            supportsNumericIds: true,
            supportsUUIDs: false,
        },
        adapter: ({ getFieldAttributes }) => {
            // Resolve a fresh QueryClient per call to support FaaS lifecycles
            // where the driver is bound to the request scope. A long-running
            // host can return the same cached client from getSql() — that's
            // the caller's choice.
            const getMethodsForCall = () =>
                buildAdapterMethods({ executor: getSql(), getFieldAttributes })
            return {
                create: (args) => getMethodsForCall().create(args),
                findOne: (args) => getMethodsForCall().findOne(args),
                findMany: (args) => getMethodsForCall().findMany(args),
                count: (args) => getMethodsForCall().count(args),
                update: (args) => getMethodsForCall().update(args),
                updateMany: (args) => getMethodsForCall().updateMany(args),
                delete: (args) => getMethodsForCall().delete(args),
                deleteMany: (args) => getMethodsForCall().deleteMany(args),
                createSchema: buildSchemaDdl(
                    config.schemaOutputPath ?? DEFAULT_SCHEMA_PATH,
                ),
            }
        },
    })
}
