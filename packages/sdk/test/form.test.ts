import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Relay, * as sdk from "../src/index.js";
import type { FormPart, MessageContent, MessagePartResponse } from "../src/index.js";

const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/form-parts.json", import.meta.url), "utf8"));
const form: FormPart = fixture.form;
const target = { message_id: "01993d50-ef7b-7b37-886b-23fd80c7ec13", part_index: 1 };
const response: MessageContent = {
  parts: [{ type: "text", value: "Form sent" }, { type: "form_response", answers: fixture.answers }],
  reply_to: target, idempotency_key: "form-reply-1",
};
const fence = (value: unknown) => "```form\n" + JSON.stringify(value) + "\n```";

describe("form authoring", () => {
  it.each(fixture.cases)("validates $name", ({ path, value, valid, remove }: {
    path: Array<string | number>; value: unknown; valid: boolean; remove?: boolean;
  }) => {
    const input = structuredClone(form);
    let parent: any = input;
    for (const key of path.slice(0, -1)) parent = parent[key];
    if (remove) delete parent[path.at(-1)!];
    else parent[path.at(-1)!] = value;
    const result = sdk.formPart(input);
    if (valid) expect(result).toEqual({ ...input, type: "form" });
    else expect(typeof result).toBe("string");
  });

  it("trims titles and labels but preserves placeholders and all source identities", () => {
    const input = structuredClone(form);
    input.title = " Trip details ";
    input.pages[0]!.title = " Preferences ";
    input.pages[0]!.fields[0]!.label = " Your name ";
    input.pages[0]!.fields[0]!.placeholder = "  Tell us  ";
    expect(sdk.formPart(input)).toEqual({
      ...form, pages: [
        { ...form.pages[0], fields: [
          { ...form.pages[0]!.fields[0], placeholder: "  Tell us  " },
          ...form.pages[0]!.fields.slice(1),
        ] }, form.pages[1],
      ],
    });
  });

  it("copies nested fields and options without mutating the author's objects", () => {
    const input = structuredClone(form);
    const built = sdk.formPart(input);
    expect(typeof built).not.toBe("string");
    if (typeof built === "string") throw new Error(built);
    built.pages[0]!.fields[0]!.label = "Changed";
    const field = built.pages[0]!.fields[2]!;
    if (field.type === "select") field.options[0]!.label = "Changed";
    expect(input).toEqual(form);
  });

  it.each([undefined, "", " \n"])("sends the card without blank text: %s", (text) => {
    expect(sdk.partsWithForm(text, form)).toEqual([form]);
  });

  it("keeps optional text unchanged above the form and refuses invalid authoring before send", () => {
    expect(sdk.partsWithForm(" Details please ", form)).toEqual([{ type: "text", value: " Details please " }, form]);
    expect(() => sdk.partsWithForm(undefined, { ...form, pages: [] })).toThrow();
  });

  it("parses a form fence through the same answer helper as selection, with links separate", () => {
    expect(sdk.parseFormBlock(JSON.stringify(form))).toEqual(form);
    expect(typeof sdk.parseFormBlock("{")).toBe("string");
    expect(sdk.answerMessages(fence(form))).toEqual({ messages: [[form]] });
    expect(sdk.answerMessages("https://example.test\nDetails\n" + fence(form))).toEqual({
      messages: [[{ type: "link", value: "https://example.test" }], [{ type: "text", value: "Details" }, form]],
    });
    expect(sdk.splitForm(fence(form).replace("```form", "```form json"))).toEqual({ text: "", form });
    const ordinary = fence(form).replace("```form", "```forms");
    expect(sdk.splitForm(ordinary)).toEqual({ text: ordinary });
  });

  it.each([
    fence({ ...form, pages: [] }),
    fence(form) + "\n" + fence(form),
    fence(form) + '\n```selection\n{"title":"Pick","options":[{"value":"a","label":"A"}]}\n```',
    fence(form) + '\n```buttons json\n[{"label":"OK"}]\n```',
    fence(form) + '\n```payment\n{"amount":1}\n```',
  ])("keeps invalid/conflicting blocks as readable text without partial form sends", (text) => {
    expect(sdk.answerMessages(text)).toMatchObject({
      messages: [[{ type: "text", value: text }]], error: expect.any(String),
    });
  });
});

describe("form transport and replies", () => {
  it("sends the typed form and preserves reply metadata and idempotency through retry", async () => {
    const requests: Array<{ body: unknown; key: string | null }> = [];
    const relay = new Relay({ apiKey: "test", maxRetries: 1, retryBaseDelayMs: 0, fetch: async (_, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("idempotency-key") });
      if (requests.length === 2) throw new Error("connection lost");
      return Response.json({ message: { parts: response.parts, reply_to: target } }, { status: 202 });
    } });
    await relay.chats.messages.send("chat", { message: { parts: sdk.partsWithForm(undefined, form) } });
    const sent = await relay.chats.messages.send("chat", { message: response });
    expect(requests[0]!.body).toEqual({ message: { parts: [form] } });
    expect(requests.slice(1)).toEqual([
      { body: { message: response }, key: "form-reply-1" },
      { body: { message: response }, key: "form-reply-1" },
    ]);
    expect(sent.message.parts).toEqual(response.parts);
    expect(sent.message.reply_to).toEqual(target);
  });

  it.each([null, fixture.answers])("retains nullable viewer answers and response metadata in history: %j", async (answers) => {
    const parts: MessagePartResponse[] = [
      { ...form, has_responded: true, answers, reactions: null },
      { type: "form_response", answers: fixture.answers },
    ];
    const relay = new Relay({ apiKey: "test", fetch: async () => Response.json({
      messages: [{ id: "m", parts, reply_to: target }], next_cursor: null,
    }) });
    const history = await relay.chats.messages.list("chat");
    expect(history.data[0]!.parts).toEqual(parts);
    expect(history.data[0]!.reply_to).toEqual(target);
  });

  it("discovers field ids through the signed webhook and never parses the Form sent text", () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const body = JSON.stringify({
      event_id: "form-event", event_type: "message.received",
      data: { parts: response.parts, reply_to: target },
    });
    const relay = new Relay({ apiKey: "test", webhookSecret: secret });
    const event = relay.webhooks.unwrap(body, { headers: sdk.signWebhookHeaders(secret, { id: "form-event", body }) });
    if (event.event_type !== "message.received") throw new Error("wrong event");
    expect(sdk.formReply(event.data.parts, event.data.reply_to)).toEqual({ answers: fixture.answers, reply_to: target });
    expect(event.data.parts[0]).toEqual({ type: "text", value: "Form sent" });
    expect(sdk.componentParts(event.data.parts)).toEqual([response.parts[1]]);
  });

  it("copies keyed answer arrays and requires an explicit valid source part", () => {
    const parts: MessagePartResponse[] = [
      { type: "text", value: "Not machine IDs", reactions: null },
      { type: "form_response", answers: structuredClone(fixture.answers) },
    ];
    const found = sdk.formReply(parts, target)!;
    expect(found).toEqual({ answers: fixture.answers, reply_to: target });
    found.answers.name = "Changed";
    (found.answers.interests as string[]).push("Changed");
    expect(parts[1]).toEqual({ type: "form_response", answers: fixture.answers });
    for (const replyTo of [undefined, null, { message_id: "m" }, { message_id: "", part_index: 0 },
      { message_id: "m", part_index: -1 }, { message_id: "m", part_index: 0.5 }]) {
      expect(sdk.formReply(parts, replyTo)).toBeUndefined();
    }
    expect(sdk.formReply(parts.slice(0, 1), target)).toBeUndefined();
    expect(sdk.formReply([{ type: "form_response", answers: {} }], target)).toEqual({ answers: {}, reply_to: target });
  });
});
