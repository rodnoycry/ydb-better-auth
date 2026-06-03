A [better-auth](https://better-auth.com) database adapter for [YDB (Yandex Database)](https://ydb.tech), built on the [@ydbjs/query](https://github.com/ydb-platform/ydb-js-sdk/tree/main/packages/query) client.

[![npm](https://img.shields.io/npm/v/@rodnoycry/ydb-better-auth)](https://www.npmjs.com/package/@rodnoycry/ydb-better-auth)
[![license](https://img.shields.io/npm/l/@rodnoycry/ydb-better-auth)](./LICENSE)

## Install

```sh
npm install @rodnoycry/ydb-better-auth
# peer dependencies
npm install @ydbjs/query @ydbjs/value better-auth
```

## Quick start

```ts
import { betterAuth } from "better-auth"
import { Driver } from "@ydbjs/core"
import { query } from "@ydbjs/query"
import { ydbAdapter } from "@rodnoycry/ydb-better-auth"

const driver = new Driver(process.env.YDB_CONNECTION_STRING!, {
    credentialsProvider,
})
await driver.ready()
const sql = query(driver)

export const auth = betterAuth({
    database: ydbAdapter({
        getSql: () => sql,
    }),
})
```

## FaaS (serverless) usage

YDB's [official guidance for serverless environments](https://github.com/ydb-platform/ydb-js-sdk/tree/main/examples/sls#readme) is to not reuse a `Driver` between invocations. The adapter supports this through the `getSql` callback — it is called on every adapter method invocation, so you can return a request-scoped client each time:

```ts
import { betterAuth } from "better-auth"
import { ydbAdapter } from "@rodnoycry/ydb-better-auth"

// getSql returns a fresh client per call — the adapter never caches it
export const auth = betterAuth({
    database: ydbAdapter({
        getSql: () => getRequestScopedQueryClient(),
    }),
})
```

One option for managing a driver lifecycle is [`@rodnoycry/ydb-faas`](https://www.npmjs.com/package/@rodnoycry/ydb-faas), which uses `AsyncLocalStorage` to bind a driver to the current invocation so that `getYdbSql()` resolves it from ambient context:

```ts
import { getYdbSql, runWithYdbSql } from "@rodnoycry/ydb-faas"
import { ydbAdapter } from "@rodnoycry/ydb-better-auth"

const auth = betterAuth({
    database: ydbAdapter({
        getSql: () => getYdbSql(),
    }),
})

// In your handler:
await runWithYdbSql(query(driver), async () => {
    await auth.api.signInEmail({ body: { email, password }, headers })
})
```

## Configuration

```ts
ydbAdapter({
    // Required. Returns a @ydbjs/query QueryClient.
    // Called once per adapter method invocation.
    getSql: () => sql,

    // Use plural table names (e.g. "users" instead of "user").
    // Default: false
    usePlural: false,

    // Path for generated schema DDL (used by better-auth CLI).
    // Default: "./migrations/schema.yql"
    schemaOutputPath: "./migrations/schema.yql",

    // Debug logging. Accepts boolean or a custom log function.
    // Default: false
    debugLogs: false,
})
```

## Schema generation

The adapter integrates with the [better-auth CLI](https://www.better-auth.com/docs/concepts/database#generating-tables) to generate YDB-compatible DDL:

```sh
npx @better-auth/cli generate
```

This writes `CREATE TABLE` statements and `ALTER TABLE ... ADD INDEX` for unique/indexed fields to the configured `schemaOutputPath`.

## Type mapping

| better-auth type            | YDB column type | Notes                                  |
| --------------------------- | --------------- | -------------------------------------- |
| `string`                    | `Utf8`          | IDs, names, tokens, emails             |
| `number`                    | `Int32`         | Default                                |
| `number` with `bigint:true` | `Int64`         | Coerced via `BigInt()`                 |
| `boolean`                   | `Bool`          |                                        |
| `date`                      | `Datetime`      | Second precision (uint32 epoch)        |
| `json`                      | `Json`          | Values are `JSON.stringify`'d          |
| `string[]` / `number[]`     | `Utf8`          | Framework JSON-stringifies arrays      |

`required: false` fields become `Optional<T>` in generated DDL.

## Transactions

Each mutating method (`update`, `updateMany`, `deleteMany`) wraps its internal SQL in a transaction automatically, so single-method calls are always atomic.

Top-level cross-method transactions (via `auth.transaction()`) are not yet supported — calls inside the callback run sequentially but are not atomic across each other. For better-auth's standard flows (sign-in, sign-up, session lookup, password change), single-method atomicity is sufficient.

## Limitations

- **Datetime precision** -- YDB's `Datetime` is uint32 seconds since epoch. Millisecond precision is truncated. Dates past 2106 are not representable.
- **Case-insensitive matching** -- Uses `String::AsciiToLower()` (ASCII-only). Non-ASCII case folding is not supported.
- **No native joins** -- `supportsJoin` is unset; better-auth falls back to separate queries.
- **No native UUID type** -- UUIDs are stored as `Utf8` strings.

## License

MIT
