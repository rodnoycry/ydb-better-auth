import type { DBAdapterSchemaCreation } from "better-auth/adapters"
import type { BetterAuthDBSchema } from "better-auth/db"
import { ydbTypeForAttribute } from "./values.ts"

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
export const buildSchemaDdl =
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
