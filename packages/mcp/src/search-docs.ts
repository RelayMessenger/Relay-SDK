import MiniSearch from "minisearch";
import { METHOD_DOCS, DOCS_SOURCE } from "./generated-docs.js";
export interface MethodDoc {
  method: string;
  signature: string;
  parameters: string[];
  httpMethod: string;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  definitions: string[];
  requestBody: unknown;
  executable: boolean;
  optionsIndex: number;
}
const index = new MiniSearch({
  fields: ["method", "path", "summary", "description", "parameters", "definitions"],
  searchOptions: { prefix: true, fuzzy: 0.2, boost: { method: 5, path: 4, summary: 3 } },
});
index.addAll(METHOD_DOCS.map((row, id) => ({ ...row, id, parameters: row.parameters.join(" "), definitions: row.definitions.join(" ") })));
export function searchDocs(input: { query: string; language: "typescript" | "javascript" | "http"; detail: "default" | "verbose" }): Record<string, unknown> {
  const results = index.search(input.query).slice(0, 10).map(hit => {
    const row = METHOD_DOCS[Number(hit.id)]!;
    return {
      method: row.method,
      signature: row.signature,
      endpoint: `${row.httpMethod} ${row.path}`,
      summary: row.summary,
      description: row.description,
      parameters: row.parameters,
      types: input.detail === "verbose" ? row.definitions : row.definitions.slice(0, 3),
      executable: row.executable,
      ...(input.detail === "verbose" ? { requestBody: row.requestBody } : {}),
    };
  });
  return { query: input.query, language: input.language, contractSha256: DOCS_SOURCE.contract,
    note: "In execute, use the supplied authenticated client. Do not import the SDK, construct clients, or supply credentials.", results };
}
