import { getOption, toJson } from "@bufbuild/protobuf";
import { readFile, writeFile } from "node:fs/promises";
import {
  field,
  FieldRulesSchema,
  message,
  MessageRulesSchema,
  oneof,
  OneofRulesSchema,
} from "../src/generated/buf/validate/validate_pb.ts";
import { file_editorinterop_v1_editor_interop as protocol } from "../src/generated/editorinterop/v1/editor_interop_pb.ts";

// The thin Lua edge consumes these descriptors; its CEL equivalents are explicit
// and reject unimplemented rule IDs rather than silently skipping constraints.
const schema = Object.fromEntries(
  protocol.messages.map((type) => [
    type.name,
    {
      fields: type.fields.map((item) => ({
        name: item.name,
        jsonName: item.jsonName,
        kind: item.fieldKind,
        ...(item.fieldKind === "scalar" ? { scalar: item.scalar } : {}),
        ...(item.fieldKind === "message" ? { message: item.message.name } : {}),
        ...(item.fieldKind === "enum"
          ? {
              values: Object.fromEntries(
                item.enum.values.map((value) => [value.name, value.number]),
              ),
            }
          : {}),
        ...(item.fieldKind === "list" && item.listKind === "message"
          ? { message: item.message.name }
          : {}),
        optional: item.proto.proto3Optional,
        ...(item.oneof === undefined ? {} : { oneof: item.oneof.name }),
        rules: toJson(FieldRulesSchema, getOption(item, field)),
      })),
      oneofs: type.oneofs.map((item) => ({
        name: item.name,
        rules: toJson(OneofRulesSchema, getOption(item, oneof)),
      })),
      rules: toJson(MessageRulesSchema, getOption(type, message)),
    },
  ]),
);
const output = `${JSON.stringify(schema, null, 2)}\n`;
const target = new URL(
  "../resources/nvim/editor_interop_schema.json",
  import.meta.url,
);
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== output)
    throw new Error(
      "Neovim schema is stale: bun acceptance/generate-editor-schema.ts",
    );
} else {
  await writeFile(target, output);
}
