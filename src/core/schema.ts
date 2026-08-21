/**
 * Tiny JSON-Schema validator for tool arguments. It intentionally supports
 * the structural keywords used by ani and common MCP tools, not the entire
 * JSON-Schema specification.
 */

export function validateSchema(value: unknown, schema: unknown, path = "$"): string | null {
  if (schema === true || schema === undefined) return null;
  if (schema === false) return `${path} is not allowed`;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return `${path} has an invalid schema`;

  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.allOf)) {
    for (const part of s.allOf) {
      const error = validateSchema(value, part, path);
      if (error) return error;
    }
  }
  if (Array.isArray(s.anyOf) && !s.anyOf.some((part) => validateSchema(value, part, path) === null)) {
    return `${path} does not match any allowed schema`;
  }
  if (Array.isArray(s.oneOf)) {
    const matches = s.oneOf.filter((part) => validateSchema(value, part, path) === null).length;
    if (matches !== 1) return `${path} must match exactly one allowed schema`;
  }
  if (Array.isArray(s.enum) && !s.enum.some((item) => sameJson(item, value))) {
    return `${path} must be one of ${s.enum.map(String).join(", ")}`;
  }
  if ("const" in s && !sameJson(s.const, value)) return `${path} must equal ${String(s.const)}`;

  const types = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    return `${path} must be ${types.join(" or ")}`;
  }

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) return `${path} is too short`;
    if (typeof s.maxLength === "number" && value.length > s.maxLength) return `${path} is too long`;
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern).test(value)) return `${path} has an invalid format`;
      } catch {
        return `${path} has an invalid pattern schema`;
      }
    }
  }

  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return `${path} must be >= ${s.minimum}`;
    if (typeof s.maximum === "number" && value > s.maximum) return `${path} must be <= ${s.maximum}`;
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) return `${path} has too few items`;
    if (typeof s.maxItems === "number" && value.length > s.maxItems) return `${path} has too many items`;
    if (s.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const error = validateSchema(value[i], s.items, `${path}[${i}]`);
        if (error) return error;
      }
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(s.properties) ? s.properties : {};
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) return `${path}.${key} is required`;
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const error = validateSchema(item, properties[key], `${path}.${key}`);
        if (error) return error;
      } else if (s.additionalProperties === false) {
        return `${path}.${key} is not allowed`;
      } else if (isRecord(s.additionalProperties)) {
        const error = validateSchema(item, s.additionalProperties, `${path}.${key}`);
        if (error) return error;
      }
    }
  }

  return null;
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    default: return false;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}
