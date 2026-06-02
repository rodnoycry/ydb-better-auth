import {
    createAdapterFactory,
    type CleanedWhere,
    type DBAdapterDebugLogOption,
    type DBAdapterSchemaCreation,
} from "better-auth/adapters"
import type { BetterAuthDBSchema, DBFieldAttribute } from "better-auth/db"
import { identifier, type QueryClient, type TX } from "@ydbjs/query"
import { fromJs, type Value } from "@ydbjs/value"
import {
    BoolType,
    DatetimeType,
    Int32,
    Int32Type,
    Int64,
    Int64Type,
    Json as YdbJson,
    JsonType,
    type PrimitiveType,
    Utf8Type,
} from "@ydbjs/value/primitive"
import { Optional } from "@ydbjs/value/optional"

/**
 * YDB adapter for better-auth.
 *
 * For the architecture overview, type-mapping table, design rationale, and
 * intentional limitations, see the sibling ADAPTER.md.
 */

type YdbAdapterConfig = {
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
type Executor = QueryClient | TX

/**
 * `transactionId` is set on the `TX` yielded inside `sql.begin(...)` and
 * absent on a top-level `QueryClient`. It's the cleanest runtime
 * discriminator the SDK exposes — see the SDK's async-local context, which
 * notes it's "the only piece that's not derivable from Session":
 * https://github.com/ydb-platform/ydb-js-sdk/blob/main/packages/query/src/ctx.ts
 */
const isTx = (executor: Executor): executor is TX => "transactionId" in executor

type ParamMap = Map<string, Value>
type AnyQuery = ReturnType<Executor>

/**
 * Maps a better-auth field attribute to a YDB column type and the matching
 * `Value` constructor used for parameter binding. Both halves stay in sync so
 * `Optional<sqlType>` columns and `new Optional(null, type)` parameters agree.
 */
const ydbTypeForAttribute = (
    attr: DBFieldAttribute,
): { sqlType: string; type: PrimitiveType } => {
    switch (attr.type) {
        case "string":
            return { sqlType: "Utf8", type: new Utf8Type() }
        case "number":
            return attr.bigint
                ? { sqlType: "Int64", type: new Int64Type() }
                : { sqlType: "Int32", type: new Int32Type() }
        case "boolean":
            return { sqlType: "Bool", type: new BoolType() }
        case "date":
            return { sqlType: "Datetime", type: new DatetimeType() }
        case "json":
            return { sqlType: "Json", type: new JsonType() }
        default:
            // string[] / number[] arrive JSON-stringified here because we set
            // supportsArrays:false on the factory config — see the better-auth
            // adapter `Config` reference for how the flag is interpreted:
            // https://better-auth.com/docs/guides/create-a-db-adapter#config
            // Array<LiteralString> represents enum unions — also stored as text.
            return { sqlType: "Utf8", type: new Utf8Type() }
    }
}

/**
 * Converts a JS value coming from better-auth into a YDB `Value`.
 *
 * Three cases this function exists to handle that `fromJs` alone can't:
 *
 *   1. Null values. `@ydbjs/query` rejects raw `null` in template literals
 *      because YDB needs a column type to construct the `Optional` wrapper —
 *      see the SDK's `validateValue` enforcement:
 *      https://github.com/ydb-platform/ydb-js-sdk/blob/main/packages/query/src/yql.ts
 *      We use the field attribute to pick that type.
 *
 *   2. Bigint columns. `fromJs` maps any JS integer to `Int32`, which fails
 *      against an `Int64` column. When the field has `bigint: true` we coerce
 *      explicitly to `Int64`.
 *
 *   3. JSON columns. `fromJs` would build a `Struct` from a plain object,
 *      which doesn't match a `Json` column. We stringify and wrap manually.
 */
const toYdbValue = (value: unknown, attr: DBFieldAttribute): Value => {
    const { type } = ydbTypeForAttribute(attr)
    if (value === null || value === undefined) {
        return new Optional(null, type)
    }
    if (attr.type === "number") {
        if (attr.bigint) {
            return new Int64(
                typeof value === "bigint" ? value : BigInt(value as number),
            )
        }
        if (typeof value === "number" && Number.isInteger(value)) {
            return new Int32(value)
        }
    }
    if (attr.type === "json") {
        const jsonString =
            typeof value === "string" ? value : JSON.stringify(value)
        return new YdbJson(jsonString)
    }
    return fromJs(value as never)
}

/**
 * Escapes LIKE-pattern metacharacters in a user-supplied search value so it
 * is matched literally instead of as a wildcard.
 *
 * Used by `buildWhereSql` for the `contains`, `starts_with`, and `ends_with`
 * operators *before* wrapping the value with the `%` markers that make those
 * operators work. Without this, a search for `"50%"` would match anything
 * starting with `"50"`, and a search containing `_` would match any single
 * character.
 *
 * Escapes `%` and `_` (LIKE metacharacters) plus `\` (the escape char itself);
 * the WHERE builder pairs each LIKE clause with `ESCAPE '\\'` so YQL knows to
 * read `\%` and `\_` as literal characters.
 */
const escapeLikePattern = (raw: string): string =>
    raw.replace(/([%_\\])/g, "\\$1")

/**
 * Translates better-auth's `CleanedWhere[]` into a YQL WHERE clause and the
 * accompanying parameter map.
 *
 * Operator mapping:
 *   eq/ne/lt/lte/gt/gte → SQL operators (with `IS NULL` / `IS NOT NULL` for null)
 *   in / not_in         → IN / NOT IN with positional placeholders
 *   contains            → LIKE '%x%'
 *   starts_with         → LIKE 'x%'
 *   ends_with           → LIKE '%x'
 *
 * Special cases:
 *   - Empty `in` list collapses to `1=0`; empty `not_in` to `1=1`. YQL does
 *     not accept `WHERE x IN ()`.
 *   - LIKE patterns escape `%`/`_`/`\` with `\` and emit `ESCAPE '\\'`.
 *   - `mode: "insensitive"` wraps both operands in `String::AsciiToLower(...)`.
 *   - The first clause's connector is ignored (nothing to connect to).
 */
const buildWhereSql = (
    where: readonly CleanedWhere[] | undefined,
    getFieldAttribute: (field: string) => DBFieldAttribute,
    paramPrefix = "w",
): { sql: string; params: ParamMap } => {
    if (!where || where.length === 0) {
        return { sql: "", params: new Map() }
    }
    const params: ParamMap = new Map()
    const clauseFragments: string[] = []
    where.forEach((clause, clauseIndex) => {
        const { field, value, operator, mode } = clause
        const columnIdentifier = identifier(field).toString()
        const fieldAttribute = getFieldAttribute(field)
        const caseInsensitive =
            mode === "insensitive" && fieldAttribute.type === "string"
        const wrapForCase = (expr: string): string =>
            caseInsensitive ? `String::AsciiToLower(${expr})` : expr
        const connector =
            clauseIndex === 0 ? "" : ` ${clause.connector ?? "AND"} `

        if (value === null) {
            const nullOperator = operator === "ne" ? "IS NOT NULL" : "IS NULL"
            clauseFragments.push(
                `${connector}${columnIdentifier} ${nullOperator}`,
            )
            return
        }

        if (operator === "in" || operator === "not_in") {
            const valueList = Array.isArray(value) ? value : [value]
            if (valueList.length === 0) {
                clauseFragments.push(
                    `${connector}${operator === "in" ? "1=0" : "1=1"}`,
                )
                return
            }
            const placeholders = valueList.map((itemValue, itemIndex) => {
                const paramName = `${paramPrefix}${clauseIndex}_${itemIndex}`
                params.set(paramName, toYdbValue(itemValue, fieldAttribute))
                return wrapForCase(`$${paramName}`)
            })
            const sqlOperator = operator === "in" ? "IN" : "NOT IN"
            clauseFragments.push(
                `${connector}${wrapForCase(columnIdentifier)} ${sqlOperator} (${placeholders.join(", ")})`,
            )
            return
        }

        if (
            operator === "contains" ||
            operator === "starts_with" ||
            operator === "ends_with"
        ) {
            const escapedPattern = escapeLikePattern(String(value))
            const likePattern =
                operator === "contains"
                    ? `%${escapedPattern}%`
                    : operator === "starts_with"
                      ? `${escapedPattern}%`
                      : `%${escapedPattern}`
            const paramName = `${paramPrefix}${clauseIndex}`
            params.set(paramName, toYdbValue(likePattern, fieldAttribute))
            clauseFragments.push(
                `${connector}${wrapForCase(columnIdentifier)} LIKE ${wrapForCase(`$${paramName}`)} ESCAPE '\\\\'`,
            )
            return
        }

        const sqlOperator =
            operator === "ne"
                ? "!="
                : operator === "lt"
                  ? "<"
                  : operator === "lte"
                    ? "<="
                    : operator === "gt"
                      ? ">"
                      : operator === "gte"
                        ? ">="
                        : "="
        const paramName = `${paramPrefix}${clauseIndex}`
        params.set(paramName, toYdbValue(value, fieldAttribute))
        clauseFragments.push(
            `${connector}${wrapForCase(columnIdentifier)} ${sqlOperator} ${wrapForCase(`$${paramName}`)}`,
        )
    })
    return { sql: ` WHERE ${clauseFragments.join("")}`, params }
}

const bindParameters = (query: AnyQuery, params: ParamMap): void => {
    for (const [name, value] of params) {
        query.parameter(name, value)
    }
}

/**
 * The SDK's executeQuery yields one inner array per result-set; for our
 * single-statement SELECTs that's `[rows]`, so we unwrap once. Pure
 * INSERT/UPDATE/DELETE return an empty outer array — we coerce to `[]`.
 */
const fetchRows = async <T = Record<string, unknown>>(
    query: AnyQuery,
): Promise<Array<T>> => {
    const resultSets = (await query) as unknown as T[][]
    return resultSets[0] ?? []
}

/**
 * Builds the eight CustomAdapter operations against the given executor. We
 * call this with a `QueryClient` for top-level operations and (recursively
 * via `executor.begin`) with a `TX` for the COUNT+mutate / UPDATE+SELECT
 * pairs that need to be atomic.
 */
const buildAdapterMethods = (
    executor: Executor,
    getFieldAttributes: (args: {
        model: string
        field: string
    }) => DBFieldAttribute,
) => {
    const runSql = (text: string): AnyQuery => executor(text)
    const attributeLookupFor =
        (model: string) =>
        (field: string): DBFieldAttribute =>
            getFieldAttributes({ model, field })

    const quoteIdentifier = (name: string): string =>
        identifier(name).toString()

    const create = async <T extends Record<string, unknown>>({
        data,
        model,
    }: {
        model: string
        data: T
        select?: string[]
    }): Promise<T> => {
        const columnNames = Object.keys(data)
        if (columnNames.length === 0) {
            throw new Error(
                `[ydb-adapter] create: empty data for model "${model}"`,
            )
        }
        const columnList = columnNames.map(quoteIdentifier).join(", ")
        const placeholderList = columnNames
            .map((_, index) => `$p${index}`)
            .join(", ")
        const insertSql = `INSERT INTO ${quoteIdentifier(model)} (${columnList}) VALUES (${placeholderList})`
        const insertQuery = runSql(insertSql)
        columnNames.forEach((columnName, columnIndex) => {
            const fieldAttribute = getFieldAttributes({
                model,
                field: columnName,
            })
            insertQuery.parameter(
                `p${columnIndex}`,
                toYdbValue(data[columnName], fieldAttribute),
            )
        })
        // YDB's INSERT doesn't return rows, but the framework's transformOutput
        // doesn't need a re-read either — everything it cares about is in the
        // input we just wrote.
        await insertQuery
        return data
    }

    const findOne = async <T>({
        model,
        where,
        select,
    }: {
        model: string
        where: CleanedWhere[]
        select?: string[]
    }): Promise<T | null> => {
        const { sql: whereClauseSql, params } = buildWhereSql(
            where,
            attributeLookupFor(model),
        )
        const selectClause =
            select && select.length > 0
                ? select.map(quoteIdentifier).join(", ")
                : "*"
        const selectSql = `SELECT ${selectClause} FROM ${quoteIdentifier(model)}${whereClauseSql} LIMIT 1`
        const selectQuery = runSql(selectSql)
        bindParameters(selectQuery, params)
        const rows = await fetchRows<T>(selectQuery)
        return rows[0] ?? null
    }

    const findMany = async <T>({
        model,
        where,
        limit,
        offset,
        sortBy,
        select,
    }: {
        model: string
        where?: CleanedWhere[]
        limit: number
        select?: string[]
        sortBy?: { field: string; direction: "asc" | "desc" }
        offset?: number
    }): Promise<T[]> => {
        const { sql: whereClauseSql, params } = buildWhereSql(
            where,
            attributeLookupFor(model),
        )
        const selectClause =
            select && select.length > 0
                ? select.map(quoteIdentifier).join(", ")
                : "*"
        let selectSql = `SELECT ${selectClause} FROM ${quoteIdentifier(model)}${whereClauseSql}`
        if (sortBy) {
            const direction = sortBy.direction === "desc" ? "DESC" : "ASC"
            selectSql += ` ORDER BY ${quoteIdentifier(sortBy.field)} ${direction}`
        }
        selectSql += ` LIMIT ${Math.max(0, Math.floor(limit))}`
        if (offset !== undefined && offset > 0) {
            selectSql += ` OFFSET ${Math.floor(offset)}`
        }
        const selectQuery = runSql(selectSql)
        bindParameters(selectQuery, params)
        return await fetchRows<T>(selectQuery)
    }

    const count = async ({
        model,
        where,
    }: {
        model: string
        where?: CleanedWhere[]
    }): Promise<number> => {
        const { sql: whereClauseSql, params } = buildWhereSql(
            where,
            attributeLookupFor(model),
        )
        const countSql = `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(model)}${whereClauseSql}`
        const countQuery = runSql(countSql)
        bindParameters(countQuery, params)
        const rows = await fetchRows<{ cnt: number | bigint }>(countQuery)
        const total = rows[0]?.cnt ?? 0
        // YDB's COUNT(*) returns Uint64 (a JS bigint). Number() narrows safely
        // for any realistic auth-table size.
        return typeof total === "bigint" ? Number(total) : total
    }

    /**
     * better-auth's `update` contract requires returning the post-update row
     * including unchanged columns. YDB's UPDATE doesn't return data, so we
     * UPDATE then SELECT. The two share a transaction so a concurrent write
     * can't slip between them — `update` wraps us in `executor.begin` if
     * we're not already inside a transaction.
     */
    const runUpdateAndSelect = async <T>(
        tx: Executor,
        model: string,
        where: CleanedWhere[],
        updateData: Record<string, unknown>,
    ): Promise<T | null> => {
        const columnNames = Object.keys(updateData)
        if (columnNames.length > 0) {
            const setClause = columnNames
                .map(
                    (columnName, columnIndex) =>
                        `${quoteIdentifier(columnName)} = $u${columnIndex}`,
                )
                .join(", ")
            const { sql: whereClauseSql, params } = buildWhereSql(
                where,
                attributeLookupFor(model),
            )
            const updateSql = `UPDATE ${quoteIdentifier(model)} SET ${setClause}${whereClauseSql}`
            const updateQuery: AnyQuery = tx(updateSql)
            columnNames.forEach((columnName, columnIndex) => {
                const fieldAttribute = getFieldAttributes({
                    model,
                    field: columnName,
                })
                updateQuery.parameter(
                    `u${columnIndex}`,
                    toYdbValue(updateData[columnName], fieldAttribute),
                )
            })
            bindParameters(updateQuery, params)
            await updateQuery
        }
        const { sql: selectWhereClauseSql, params: selectParams } =
            buildWhereSql(where, attributeLookupFor(model))
        const selectSql = `SELECT * FROM ${quoteIdentifier(model)}${selectWhereClauseSql} LIMIT 1`
        const selectQuery: AnyQuery = tx(selectSql)
        bindParameters(selectQuery, selectParams)
        const rows = await fetchRows<T>(selectQuery)
        return rows[0] ?? null
    }

    const update = async <T>({
        model,
        where,
        update: updateData,
    }: {
        model: string
        where: CleanedWhere[]
        update: T
    }): Promise<T | null> => {
        const data = updateData as Record<string, unknown>
        if (isTx(executor)) {
            return runUpdateAndSelect<T>(executor, model, where, data)
        }
        return await executor.begin(async (tx) =>
            runUpdateAndSelect<T>(tx, model, where, data),
        )
    }

    /**
     * YDB's UPDATE doesn't expose an affected-row count, so we COUNT the
     * matching rows first and run the UPDATE in the same transaction to
     * avoid a concurrent writer making the count drift from reality.
     */
    const runUpdateMany = async (
        tx: Executor,
        model: string,
        where: CleanedWhere[],
        updateData: Record<string, unknown>,
    ): Promise<number> => {
        const { sql: whereClauseSql, params } = buildWhereSql(
            where,
            attributeLookupFor(model),
        )
        const countSql = `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(model)}${whereClauseSql}`
        const countQuery: AnyQuery = tx(countSql)
        bindParameters(countQuery, params)
        const countRows = await fetchRows<{ cnt: number | bigint }>(countQuery)
        const rawTotal = countRows[0]?.cnt ?? 0
        const total = typeof rawTotal === "bigint" ? Number(rawTotal) : rawTotal

        const columnNames = Object.keys(updateData)
        if (total === 0 || columnNames.length === 0) return total

        const setClause = columnNames
            .map(
                (columnName, columnIndex) =>
                    `${quoteIdentifier(columnName)} = $u${columnIndex}`,
            )
            .join(", ")
        const updateSql = `UPDATE ${quoteIdentifier(model)} SET ${setClause}${whereClauseSql}`
        const updateQuery: AnyQuery = tx(updateSql)
        columnNames.forEach((columnName, columnIndex) => {
            const fieldAttribute = getFieldAttributes({
                model,
                field: columnName,
            })
            updateQuery.parameter(
                `u${columnIndex}`,
                toYdbValue(updateData[columnName], fieldAttribute),
            )
        })
        bindParameters(updateQuery, params)
        await updateQuery
        return total
    }

    const updateMany = async ({
        model,
        where,
        update: updateData,
    }: {
        model: string
        where: CleanedWhere[]
        update: Record<string, unknown>
    }): Promise<number> => {
        if (isTx(executor)) {
            return runUpdateMany(executor, model, where, updateData)
        }
        return await executor.begin(async (tx) =>
            runUpdateMany(tx, model, where, updateData),
        )
    }

    const deleteOne = async ({
        model,
        where,
    }: {
        model: string
        where: CleanedWhere[]
    }): Promise<void> => {
        const { sql: whereClauseSql, params } = buildWhereSql(
            where,
            attributeLookupFor(model),
        )
        const deleteSql = `DELETE FROM ${quoteIdentifier(model)}${whereClauseSql}`
        const deleteQuery = runSql(deleteSql)
        bindParameters(deleteQuery, params)
        await deleteQuery
    }

    /** Same COUNT-then-mutate pattern as `runUpdateMany`, for the same reason. */
    const runDeleteMany = async (
        tx: Executor,
        model: string,
        where: CleanedWhere[],
    ): Promise<number> => {
        const { sql: whereClauseSql, params } = buildWhereSql(
            where,
            attributeLookupFor(model),
        )
        const countSql = `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(model)}${whereClauseSql}`
        const countQuery: AnyQuery = tx(countSql)
        bindParameters(countQuery, params)
        const rows = await fetchRows<{ cnt: number | bigint }>(countQuery)
        const rawTotal = rows[0]?.cnt ?? 0
        const total = typeof rawTotal === "bigint" ? Number(rawTotal) : rawTotal

        if (total === 0) return 0

        const deleteSql = `DELETE FROM ${quoteIdentifier(model)}${whereClauseSql}`
        const deleteQuery: AnyQuery = tx(deleteSql)
        bindParameters(deleteQuery, params)
        await deleteQuery
        return total
    }

    const deleteMany = async ({
        model,
        where,
    }: {
        model: string
        where: CleanedWhere[]
    }): Promise<number> => {
        if (isTx(executor)) {
            return runDeleteMany(executor, model, where)
        }
        return await executor.begin(async (tx) =>
            runDeleteMany(tx, model, where),
        )
    }

    return {
        create,
        findOne,
        findMany,
        count,
        update,
        updateMany,
        delete: deleteOne,
        deleteMany,
    }
}

/**
 * Generates `CREATE TABLE` (and index) statements for the better-auth schema.
 * Called by the better-auth CLI's `generate` command.
 *
 * Notes:
 *   - The framework auto-injects an `id` field at runtime, but it does not
 *     appear in `tableConfig.fields`, so we declare it manually as the PK.
 *   - `required: false` fields become `Optional<T>`; everything else is
 *     `T NOT NULL`. PK columns must always be NOT NULL in YDB.
 *   - `unique` and `index` attributes become global secondary indexes.
 */
const buildSchemaDdl =
    (defaultOutputPath: string) =>
    async ({
        file,
        tables,
    }: {
        file?: string
        tables: BetterAuthDBSchema
    }): Promise<DBAdapterSchemaCreation> => {
        const statements: string[] = []
        for (const tableConfig of Object.values(tables)) {
            const tableName = tableConfig.modelName
            const columnDefinitions: string[] = []
            const indexDefinitions: string[] = []

            columnDefinitions.push(`\`id\` Utf8 NOT NULL`)
            const definedColumns = new Set<string>(["id"])

            for (const [schemaFieldName, fieldAttribute] of Object.entries(
                tableConfig.fields,
            )) {
                const columnName = fieldAttribute.fieldName ?? schemaFieldName
                if (definedColumns.has(columnName)) continue
                definedColumns.add(columnName)
                const { sqlType } = ydbTypeForAttribute(fieldAttribute)
                const isRequired = fieldAttribute.required !== false
                const columnType = isRequired
                    ? `${sqlType} NOT NULL`
                    : `Optional<${sqlType}>`
                columnDefinitions.push(`\`${columnName}\` ${columnType}`)

                // Indexes must be declared inline. YDB rejects
                // `ALTER TABLE ... ADD INDEX ... GLOBAL UNIQUE` against an
                // existing table ("Adding a unique index to an existing table
                // is disabled"); inlining works for unique and non-unique
                // alike and keeps the script idempotent under
                // CREATE TABLE IF NOT EXISTS.
                if (fieldAttribute.unique) {
                    indexDefinitions.push(
                        `INDEX \`idx_${tableName}_${columnName}\` GLOBAL UNIQUE SYNC ON (\`${columnName}\`)`,
                    )
                } else if (fieldAttribute.index) {
                    indexDefinitions.push(
                        `INDEX \`idx_${tableName}_${columnName}\` GLOBAL ON (\`${columnName}\`)`,
                    )
                }
            }
            const tableBody = [
                ...columnDefinitions,
                ...indexDefinitions,
                `PRIMARY KEY (\`id\`)`,
            ]
            statements.push(
                `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n    ${tableBody.join(",\n    ")}\n);`,
            )
        }

        return {
            code: `${statements.join("\n\n")}\n`,
            path: file ?? defaultOutputPath,
            overwrite: false,
            append: true,
        }
    }

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
                buildAdapterMethods(getSql(), getFieldAttributes)
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
                    config.schemaOutputPath ?? "./migrations/schema.yql",
                ),
            }
        },
    })
}
