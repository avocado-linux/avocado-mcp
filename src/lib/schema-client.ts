const SCHEMA_URL_TEMPLATE =
  "https://raw.githubusercontent.com/avocado-linux/avocado-config/{version}/avocado-config.json";
const USER_AGENT = "avocado-mcp-server";

export interface FetchedSchema {
  schema: unknown;
  version: string;
  source: string;
}

/**
 * Fetch the avocado-config.json JSON Schema for a given git ref.
 *
 * Defaults to `main` when no version is supplied.
 * Throws on non-2xx responses with the source URL in the message so callers
 * can surface it to the user.
 */
export async function fetchSchema(version?: string): Promise<FetchedSchema> {
  const schemaVersion = version || "main";
  const source = SCHEMA_URL_TEMPLATE.replace("{version}", schemaVersion);

  const response = await fetch(source, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `Schema not found for version '${schemaVersion}'. HTTP ${response.status}: ${response.statusText}`,
    );
  }

  const schema = await response.json();
  return { schema, version: schemaVersion, source };
}
