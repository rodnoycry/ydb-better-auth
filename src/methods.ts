import type { CleanedWhere } from "better-auth/adapters"
import type { DBFieldAttribute } from "better-auth/db"
import { identifier } from "@ydbjs/query"
import { type Executor, type AnyQuery, isTx } from "./types.ts"
import { toYdbValue } from "./values.ts"
import { buildWhereSql, bindParameters, fetchRows } from "./where.ts"

/**
 * Builds the eight CustomAdapter operations against the given executor. We
 * call this with a `QueryClient` for top-level operations and (recursively
 * via `executor.begin`) with a `TX` for the COUNT+mutate / UPDATE+SELECT
 * pairs that need to be atomic.
 */
export const buildAdapterMethods = ({
    executor,
    getFieldAttributes,
}: {
    executor: Executor
    getFieldAttributes: (args: {
        model: string
        field: string
    }) => DBFieldAttribute
}) => {
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
                toYdbValue({ value: data[columnName], attr: fieldAttribute }),
            )
        })
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
        const { sql: whereClauseSql, params } = buildWhereSql({
            where,
            getFieldAttribute: attributeLookupFor(model),
        })
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
        const { sql: whereClauseSql, params } = buildWhereSql({
            where,
            getFieldAttribute: attributeLookupFor(model),
        })
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
        const { sql: whereClauseSql, params } = buildWhereSql({
            where,
            getFieldAttribute: attributeLookupFor(model),
        })
        const countSql = `SELECT COUNT(*) AS cnt FROM ${quoteIdentifier(model)}${whereClauseSql}`
        const countQuery = runSql(countSql)
        bindParameters(countQuery, params)
        const rows = await fetchRows<{ cnt: number | bigint }>(countQuery)
        const total = rows[0]?.cnt ?? 0
        return typeof total === "bigint" ? Number(total) : total
    }

    /**
     * better-auth's `update` contract requires returning the post-update row
     * including unchanged columns. YDB's UPDATE doesn't return data, so we
     * UPDATE then SELECT. The two share a transaction so a concurrent write
     * can't slip between them — `update` wraps us in `executor.begin` if
     * we're not already inside a transaction.
     */
    const runUpdateAndSelect = async <T>({
        tx,
        model,
        where,
        updateData,
    }: {
        tx: Executor
        model: string
        where: CleanedWhere[]
        updateData: Record<string, unknown>
    }): Promise<T | null> => {
        const columnNames = Object.keys(updateData)
        if (columnNames.length > 0) {
            const setClause = columnNames
                .map(
                    (columnName, columnIndex) =>
                        `${quoteIdentifier(columnName)} = $u${columnIndex}`,
                )
                .join(", ")
            const { sql: whereClauseSql, params } = buildWhereSql({
                where,
                getFieldAttribute: attributeLookupFor(model),
            })
            const updateSql = `UPDATE ${quoteIdentifier(model)} SET ${setClause}${whereClauseSql}`
            const updateQuery: AnyQuery = tx(updateSql)
            columnNames.forEach((columnName, columnIndex) => {
                const fieldAttribute = getFieldAttributes({
                    model,
                    field: columnName,
                })
                updateQuery.parameter(
                    `u${columnIndex}`,
                    toYdbValue({
                        value: updateData[columnName],
                        attr: fieldAttribute,
                    }),
                )
            })
            bindParameters(updateQuery, params)
            await updateQuery
        }
        const { sql: selectWhereClauseSql, params: selectParams } =
            buildWhereSql({
                where,
                getFieldAttribute: attributeLookupFor(model),
            })
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
            return runUpdateAndSelect<T>({
                tx: executor,
                model,
                where,
                updateData: data,
            })
        }
        return await executor.begin(async (tx) =>
            runUpdateAndSelect<T>({ tx, model, where, updateData: data }),
        )
    }

    /**
     * YDB's UPDATE doesn't expose an affected-row count, so we COUNT the
     * matching rows first and run the UPDATE in the same transaction to
     * avoid a concurrent writer making the count drift from reality.
     */
    const runUpdateMany = async ({
        tx,
        model,
        where,
        updateData,
    }: {
        tx: Executor
        model: string
        where: CleanedWhere[]
        updateData: Record<string, unknown>
    }): Promise<number> => {
        const { sql: whereClauseSql, params } = buildWhereSql({
            where,
            getFieldAttribute: attributeLookupFor(model),
        })
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
                toYdbValue({
                    value: updateData[columnName],
                    attr: fieldAttribute,
                }),
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
            return runUpdateMany({ tx: executor, model, where, updateData })
        }
        return await executor.begin(async (tx) =>
            runUpdateMany({ tx, model, where, updateData }),
        )
    }

    const deleteOne = async ({
        model,
        where,
    }: {
        model: string
        where: CleanedWhere[]
    }): Promise<void> => {
        const { sql: whereClauseSql, params } = buildWhereSql({
            where,
            getFieldAttribute: attributeLookupFor(model),
        })
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
        const { sql: whereClauseSql, params } = buildWhereSql({
            where,
            getFieldAttribute: attributeLookupFor(model),
        })
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
