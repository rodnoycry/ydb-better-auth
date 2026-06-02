import type { DBFieldAttribute } from "better-auth/db"
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
 * Maps a better-auth field attribute to a YDB column type and the matching
 * `Value` constructor used for parameter binding. Both halves stay in sync so
 * `Optional<sqlType>` columns and `new Optional(null, type)` parameters agree.
 */
export const ydbTypeForAttribute = (
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
export const toYdbValue = ({
    value,
    attr,
}: {
    value: unknown
    attr: DBFieldAttribute
}): Value => {
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
