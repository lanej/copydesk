import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fromJsonString, type DescMessage } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import * as wire from "../src/generated/editorinterop/v1/editor_interop_pb.js";

const validator = createValidator();
const schemas = new Map<string, DescMessage>([
  ["RegisterRequest", wire.RegisterRequestSchema],
  ["RegisterResponse", wire.RegisterResponseSchema],
  ["SyncRequest", wire.SyncRequestSchema],
  ["SyncResponse", wire.SyncResponseSchema],
  ["SaveRequest", wire.SaveRequestSchema],
  ["SaveResponse", wire.SaveResponseSchema],
  ["FeedbackRequest", wire.FeedbackRequestSchema],
  ["FeedbackResponse", wire.FeedbackResponseSchema],
  ["ResultRequest", wire.ResultRequestSchema],
  ["ResultResponse", wire.ResultResponseSchema],
  ["FeedbackRecord", wire.FeedbackRecordSchema],
  ["SaveResult", wire.SaveResultSchema],
  ["LineRange", wire.LineRangeSchema],
  ["ValueChunk", wire.ValueChunkSchema],
]);
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
async function read(name: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  return object(value);
}
function validate(type: unknown, value: unknown, expected: unknown = true): void {
  assert.ok(typeof type === "string");
  assert.equal(typeof expected, "boolean");
  const schema = schemas.get(type);
  assert.ok(schema !== undefined, `Missing fixture schema ${type}`);
  const result = validator.validate(schema, fromJsonString(schema, JSON.stringify(value)));
  assert.equal(result.kind === "valid", expected, `Fixture ${type}: ${result.kind}`);
}
await test("frozen Connect examples and negative shared constraints validate against generated schemas", async () => {
  for (const name of ["register.json", "feedback.json"]) {
    const fixture = await read(name);
    validate(fixture["requestType"], fixture["request"]);
    validate(fixture["responseType"], fixture["response"]);
    if (fixture["expectedValueType"] !== undefined) validate(fixture["expectedValueType"], fixture["expectedValue"]);
  }
  for (const name of ["sync.json", "save.json"]) {
    const fixture = await read(name);
    for (const raw of array(fixture["calls"])) {
      const call = object(raw);
      validate(call["requestType"], call["request"]);
      validate(call["responseType"], call["response"]);
    }
    if (fixture["expectedValueType"] !== undefined) validate(fixture["expectedValueType"], fixture["expectedValue"]);
  }
  for (const raw of array((await read("invalid-values.json"))["cases"])) {
    const example = object(raw);
    validate(example["type"], example["value"], example["valid"]);
  }
  assert.throws(
    () => fromJsonString(wire.LineRangeSchema, '{"startLine":1,"endLine":1,"futureMeaning":true}'),
    /unknown/,
  );
  const sequence = fromJsonString(
    wire.SyncResponseSchema,
    '{"snapshotId":"s","sequence":"9007199254740993","complete":{}}',
  );
  assert.equal(sequence.sequence, 9007199254740993n);
});
