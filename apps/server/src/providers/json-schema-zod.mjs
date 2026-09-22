import { z } from "zod";

// Claude Agent SDK's tool() wants a Zod raw shape; our catalog speaks JSON Schema.
export function jsonSchemaToZodShape(schema) {
  if (!schema || typeof schema !== "object") return {};
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const shape = {};
  for (const [key, prop] of Object.entries(properties)) {
    let field = schemaToZod(prop);
    if (prop?.description) field = field.describe(String(prop.description));
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  return shape;
}

function schemaToZod(schema) {
  if (!schema || typeof schema !== "object") return z.unknown();
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return z.enum(schema.enum.map(String));
  }
  switch (schema.type) {
    case "string": {
      let s = z.string();
      if (typeof schema.pattern === "string") {
        try {
          s = s.regex(new RegExp(schema.pattern));
        } catch {
          // ignore invalid patterns from broker schemas
        }
      }
      return s;
    }
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array": {
      let a = z.array(schemaToZod(schema.items || {}));
      if (typeof schema.maxItems === "number") a = a.max(schema.maxItems);
      if (typeof schema.minItems === "number") a = a.min(schema.minItems);
      return a;
    }
    case "object":
    default: {
      if (schema.properties) {
        let obj = z.object(jsonSchemaToZodShape(schema));
        if (schema.additionalProperties === false) obj = obj.strict();
        return obj;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return z.record(z.string(), schemaToZod(schema.additionalProperties));
      }
      return z.record(z.string(), z.unknown());
    }
  }
}
