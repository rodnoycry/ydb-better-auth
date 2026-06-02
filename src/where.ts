import type { CleanedWhere } from "better-auth/adapters"
import type { DBFieldAttribute } from "better-auth/db"
import { identifier } from "@ydbjs/query"
import type { ParamMap, AnyQuery } from "./types.ts"
import { toYdbValue } from "./values.ts"

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
export const buildWhereSql = (
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

export const bindParameters = (query: AnyQuery, params: ParamMap): void => {
    for (const [name, value] of params) {
        query.parameter(name, value)
    }
}

/**
 * The SDK's executeQuery yields one inner array per result-set; for our
 * single-statement SELECTs that's `[rows]`, so we unwrap once. Pure
 * INSERT/UPDATE/DELETE return an empty outer array — we coerce to `[]`.
 */
export const fetchRows = async <T = Record<string, unknown>>(
    query: AnyQuery,
): Promise<Array<T>> => {
    const resultSets = (await query) as unknown as T[][]
    return resultSets[0] ?? []
}
