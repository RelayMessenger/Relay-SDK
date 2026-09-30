import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import YAML from "yaml";

const contract = YAML.parse(readFileSync(new URL("../../../contracts/relay-v1-openapi.yaml", import.meta.url), "utf8"));
const schemas = contract.components.schemas;

it("carries form send/read/response schemas in each selection-pattern union", () => {
  expect(schemas.FormPart.required).toEqual(["type", "title", "pages"]);
  expect(schemas.FormPart.additionalProperties).toBe(false);
  expect(schemas.FormPart.properties.has_responded).toBeUndefined();
  expect(schemas.FormPart.properties.answers).toBeUndefined();
  expect(schemas.FormPartResponse.required).toEqual(expect.arrayContaining(["has_responded", "answers", "reactions"]));
  expect(schemas.FormPartResponse.properties.has_responded.readOnly).toBe(true);
  expect(schemas.FormPartResponse.properties.answers).toMatchObject({ readOnly: true, anyOf: [
    { $ref: "#/components/schemas/FormAnswers" }, { type: "null" },
  ] });
  expect(schemas.FormPartResponse.properties.reactions.type).toBe("null");
  expect(schemas.FormResponsePart.required).toEqual(["type", "answers"]);
  expect(schemas.FormResponsePart.properties.reactions).toBeUndefined();
  expect(schemas.FormResponsePartResponse.allOf).toEqual([{ $ref: "#/components/schemas/FormResponsePart" }]);
  expect(schemas.MessagePart.discriminator.mapping).toMatchObject({
    form: "#/components/schemas/FormPart", form_response: "#/components/schemas/FormResponsePart",
  });
  for (const part of ["FormPart", "FormResponsePart"]) {
    expect(schemas.MessagePart.oneOf).toContainEqual({ $ref: `#/components/schemas/${part}` });
  }
  for (const name of ["Message", "SentMessage"]) {
    const parts = schemas[name].properties.parts.items;
    for (const part of ["FormPartResponse", "FormResponsePartResponse"]) {
      expect(parts.oneOf).toContainEqual({ $ref: `#/components/schemas/${part}` });
    }
  }
});

it("keeps the source limits, discriminants and configurable text lengths", () => {
  for (const [name, type, label] of [
    ["FormTextField", "text", 20], ["FormSelectField", "select", 30],
    ["FormPickerField", "picker", 20], ["FormDateField", "date", 40],
  ]) {
    const field = schemas[name!];
    expect(field.properties.type.enum).toEqual([type]);
    expect(field.properties.label.maxLength).toBe(label);
    expect(field.additionalProperties).toBe(false);
    expect(field.properties.required.default).toBe(false);
    expect(field.properties.placeholder.maxLength).toBeUndefined();
    expect(field.properties.max_length.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(schemas.FormField.discriminator.mapping[type!]).toBe(`#/components/schemas/${name}`);
  }
  expect(schemas.FormSelectField.properties.options).toMatchObject({ minItems: 1, maxItems: 20 });
  expect(schemas.FormPickerField.properties.options).toMatchObject({ minItems: 1, maxItems: 200 });
  expect(schemas.FormPage.properties.id.maxLength).toBe(19);
  expect(schemas.FormPage.properties.fields).toMatchObject({ minItems: 1, maxItems: 50 });
  expect(schemas.FormPart.properties.pages.minItems).toBe(1);
  expect(schemas.FormPart.properties.pages.maxItems).toBeUndefined();
  expect(schemas.FormDateField.properties.max_length.minimum).toBe(10);
  expect(schemas.FormTextField.properties.max_length.description).toContain("30 for single-line and 300 for multiline");
  expect(schemas.FormReplyMessage.properties.title.enum).toEqual(["Form sent"]);
  expect(schemas.FormAnswers.additionalProperties.oneOf).toEqual([
    { type: "string" },
    { type: "array", maxItems: 20, uniqueItems: true, items: {
      type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    } },
  ]);
});
