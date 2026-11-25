import { Config } from "@opencode/schema/config"
import { ConfigShell } from "@opencode/schema/config/shell"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

/**
 * PATCH /api/experimental/config only.
 *
 * Ordinary 500 responses have no code. A code is present only when an
 * actual durable commit has been attributed to this request.
 *
 * This MUST be a constructor-backed TaggedError, not Schema.Struct:
 * the installed Promise generator's declaredErrorFields() requires
 * a SchemaAST declaration with "~constructor" and a literal tag.
 */
export class ConfigUpdateFailure extends Schema.TaggedError<ConfigUpdateFailure>()(
  "UnknownError",
  {
    message: Schema.String,
    ref: Schema.optional(Schema.String),
    code: Schema.optional(
      Schema.Literals([
        "CONFIG_COMMITTED_BUT_UNPUBLISHED",
        "CONFIG_COMMITTED_WITH_POSTPUBLICATION_FAILURE",
      ]),
    ),
  },
  { httpApiStatus: 500 },
) {}

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.get", "/api/config", {
      query: LocationQuery,
      success: Schema.Array(Config.Entry),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "config.get",
          summary: "Get configuration",
          description:
            "Return configuration documents and discovery sources for the requested location, from lowest to highest priority.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.shells", "/api/config/shell", {
      success: Schema.Array(ConfigShell.Option),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "config.shells",
        summary: "List available shells",
        description: "Return shells available to terminal and agent execution.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("config.update", "/api/experimental/config", {
      payload: Config.Patch,
      success: HttpApiSchema.NoContent,
      error: ConfigUpdateFailure,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.config.update",
        summary: "Update global configuration",
        description: "Patch supported fields in the highest-precedence global configuration document.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config", description: "Location-scoped configuration routes." }))
