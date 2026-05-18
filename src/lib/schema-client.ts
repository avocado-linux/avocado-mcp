import {
  AVOCADO_YAML_SCHEMA,
  BUNDLED_SCHEMA_VERSION,
  BUNDLED_SCHEMA_SOURCE,
} from "./yaml-schema.js";

const UPSTREAM_TOML_SCHEMA_URL_TEMPLATE =
  "https://raw.githubusercontent.com/avocado-linux/avocado-config/{version}/avocado-config.json";
const USER_AGENT = "avocado-mcp-server";

export interface FetchedSchema {
  schema: unknown;
  version: string;
  source: string;
}

/**
 * Return the JSON Schema used to validate `avocado.yaml`.
 *
 * Default: the schema bundled with this MCP (derived from the canonical
 * references). The upstream `avocado-linux/avocado-config` repo currently
 * publishes a schema for `avocado.toml` — a different file format — so we
 * cannot use it for YAML validation today. When upstream gains a real YAML
 * schema we will switch the default.
 *
 * Pass `version: "upstream-toml"` to explicitly fetch the upstream TOML schema
 * (e.g. for users authoring a `.toml`-format project — currently a niche path).
 * Pass any other string as a git ref against the upstream repo.
 */
export async function fetchSchema(version?: string): Promise<FetchedSchema> {
  if (!version || version === "bundled") {
    return {
      schema: AVOCADO_YAML_SCHEMA,
      version: BUNDLED_SCHEMA_VERSION,
      source: BUNDLED_SCHEMA_SOURCE,
    };
  }

  // Explicit opt-in to the upstream TOML schema. Useful for inspecting the
  // shape of `avocado.toml` projects; NOT useful for validating YAML.
  const ref = version === "upstream-toml" ? "main" : version;
  const source = UPSTREAM_TOML_SCHEMA_URL_TEMPLATE.replace("{version}", ref);

  const response = await fetch(source, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `Schema not found for version '${version}'. HTTP ${response.status}: ${response.statusText}`,
    );
  }

  const schema = await response.json();
  return { schema, version: ref, source };
}
