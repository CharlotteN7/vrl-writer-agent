/**
 * VRL code generator — produces syntactically correct VRL from a
 * structured description. Handles the common cases (JSON, syslog,
 * key-value, CSV, grok, logfmt) with verified templates.
 *
 * For regex/custom formats, returns null and the caller falls back
 * to the LLM writing VRL directly.
 */

export interface FieldMapping {
  /** Source field path after parsing (e.g. "parsed.user_id") */
  from: string;
  /** Target field on the event (e.g. ".user_id") */
  to: string;
  /** Type coercion to apply */
  type?: "string" | "int" | "float" | "bool" | "timestamp";
  /** Timestamp format string (only when type = "timestamp") */
  format?: string;
  /** Apply downcase/upcase */
  transform?: "downcase" | "upcase";
  /** Delete from the event after mapping */
  delete?: boolean;
}

export interface ParseStep {
  /** Which field to parse */
  sourceField: string;
  /** Parser to use */
  parser: "json" | "syslog" | "key_value" | "csv" | "grok" | "logfmt" | "regex" | "split" | "xml";
  /** Variable name to store result */
  resultVar: string;
  /** Parser-specific options */
  options?: {
    keyValueDelimiter?: string;
    fieldDelimiter?: string;
    grokPattern?: string;
    regexPattern?: string;
    splitDelimiter?: string;
  };
}

export interface StructureDescription {
  /** Parsing steps in order */
  steps: ParseStep[];
  /** Field mappings from parsed results to final event */
  fields: FieldMapping[];
  /** Fields to delete from the event */
  deleteFields?: string[];
  /** OCSF classification */
  ocsf?: {
    classUid: number;
    categoryUid: number;
    severityId: number;
    activityId: number;
    productName?: string;
  };
  /** If the model needs to write raw VRL (for regex cases), put it here */
  rawVrl?: string;
}

/**
 * Generate VRL code from a structure description.
 * Returns null if the description requires raw VRL (regex case).
 */
export function generateVrl(desc: StructureDescription): string | null {
  // If the model provided raw VRL, just return it
  if (desc.rawVrl) {
    return desc.rawVrl;
  }

  const lines: string[] = [];

  // Generate expected output structure comment
  lines.push("# Expected output structure:");
  lines.push("# {");
  for (const f of desc.fields) {
    const typeName = f.type || "string";
    lines.push(`#   "${f.to.replace(/^\./, "")}": <${typeName}>,`);
  }
  if (desc.ocsf) {
    lines.push(`#   "class_uid": ${desc.ocsf.classUid},`);
    lines.push(`#   "category_uid": ${desc.ocsf.categoryUid},`);
    lines.push(`#   "severity_id": ${desc.ocsf.severityId}`);
  }
  lines.push("# }");
  lines.push("");

  // Generate parse steps
  for (const step of desc.steps) {
    const srcExpr = step.sourceField.startsWith(".")
      ? `string!(${step.sourceField})`
      : `string!(${step.sourceField})`;

    lines.push(`# Parse step: ${step.parser} on ${step.sourceField}`);

    switch (step.parser) {
      case "json":
        lines.push(`${step.resultVar}, err = parse_json(${srcExpr})`);
        lines.push(`if err != null { abort }`);
        break;

      case "syslog":
        lines.push(`${step.resultVar}, err = parse_syslog(${srcExpr})`);
        lines.push(`if err != null { abort }`);
        break;

      case "key_value": {
        const kvd = step.options?.keyValueDelimiter || "=";
        const fd = step.options?.fieldDelimiter || " ";
        lines.push(`${step.resultVar}, err = parse_key_value(${srcExpr}, key_value_delimiter: "${kvd}", field_delimiter: "${fd}")`);
        lines.push(`if err != null { abort }`);
        break;
      }

      case "csv":
        lines.push(`${step.resultVar}, err = parse_csv(${srcExpr})`);
        lines.push(`if err != null { abort }`);
        break;

      case "grok": {
        const pattern = step.options?.grokPattern || "%{COMBINEDAPACHELOG}";
        lines.push(`${step.resultVar}, err = parse_grok(${srcExpr}, "${pattern}")`);
        lines.push(`if err != null { abort }`);
        break;
      }

      case "logfmt":
        lines.push(`${step.resultVar}, err = parse_logfmt(${srcExpr})`);
        lines.push(`if err != null { abort }`);
        break;

      case "xml":
        lines.push(`${step.resultVar}, err = parse_xml(${srcExpr})`);
        lines.push(`if err != null { abort }`);
        break;

      case "split": {
        const delim = step.options?.splitDelimiter || "|";
        lines.push(`${step.resultVar} = split(${srcExpr}, "${delim}")`);
        break;
      }

      case "regex":
        // Regex — can't template safely, return null to fall back to LLM
        return null;
    }
    lines.push("");
  }

  // Generate field mappings
  lines.push("# Map fields");
  for (const f of desc.fields) {
    let expr = f.from;

    // Apply type coercion
    if (f.type === "int") {
      lines.push(`${f.to}, err = to_int(${expr})`);
      lines.push(`if err != null { abort }`);
      if (f.transform) {
        // transform doesn't apply to int
      }
      continue;
    }
    if (f.type === "float") {
      lines.push(`${f.to}, err = to_float(${expr})`);
      lines.push(`if err != null { abort }`);
      continue;
    }
    if (f.type === "timestamp" && f.format) {
      lines.push(`${f.to}, err = parse_timestamp(string!(${expr}), format: "${f.format}")`);
      lines.push(`if err != null { abort }`);
      continue;
    }

    // Apply transform
    if (f.transform === "downcase") {
      expr = `downcase(string!(${expr}))`;
    } else if (f.transform === "upcase") {
      expr = `upcase(string!(${expr}))`;
    }

    lines.push(`${f.to} = ${expr}`);
  }
  lines.push("");

  // Delete fields
  if (desc.deleteFields) {
    for (const df of desc.deleteFields) {
      lines.push(`del(${df})`);
    }
    lines.push("");
  }

  // OCSF
  if (desc.ocsf) {
    lines.push("# OCSF");
    lines.push(`.class_uid = ${desc.ocsf.classUid}`);
    lines.push(`.category_uid = ${desc.ocsf.categoryUid}`);
    lines.push(`.severity_id = ${desc.ocsf.severityId}`);
    lines.push(`.activity_id = ${desc.ocsf.activityId}`);
    lines.push(`.type_uid = ${desc.ocsf.classUid * 100 + desc.ocsf.activityId}`);
    if (desc.ocsf.productName) {
      lines.push(`.metadata.product.name = "${desc.ocsf.productName}"`);
    }
    lines.push(`.metadata.version = "1.1.0"`);
  }

  return lines.join("\n");
}
