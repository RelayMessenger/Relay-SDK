import { expect, it } from "vitest";
import { parseCallRoomServerFrame } from "../../src/index.js";
import {
  RIVE_MESSAGE_MAX_BYTES,
  VISEMES,
  alignmentFromWords,
  encodeRiveMessage,
  parseRiveMessage,
  visemesFromAlignment,
  type CharacterAlignment,
} from "../../src/calls/index.js";

/** ElevenLabs-style alignment: one entry per character, `ms` apart. */
const align = (text: string, ms = 50, from = 0): CharacterAlignment => ({
  chars: [...text],
  char_start_times_ms: [...text].map((_, index) => from + index * ms),
  char_durations_ms: [...text].map(() => ms),
});

const named = (cues: { t: number; viseme: number }[]): Array<[number, string]> =>
  cues.map(({ t, viseme }) => [t, VISEMES[viseme]!]);

it("encodes the spec's three agent messages and rounds t", () => {
  expect(JSON.parse(encodeRiveMessage({ t: 1840.2, view_model: { viseme: 3, speaking: true } })))
    .toEqual({ t: 1840, view_model: { viseme: 3, speaking: true } });
  expect(JSON.parse(encodeRiveMessage({ t: 2600, trigger: "nod" }))).toEqual({ t: 2600, trigger: "nod" });
  expect(JSON.parse(encodeRiveMessage({
    file: "https://cdn.relay/rive/q.riv", artboard: "Quiz", state_machine: "Main", view_model: { question: "Capital of France?" },
  }))).toEqual({ file: "https://cdn.relay/rive/q.riv", artboard: "Quiz", state_machine: "Main", view_model: { question: "Capital of France?" } });
});

it("refuses malformed messages and anything over 1 KB", () => {
  expect(() => encodeRiveMessage({})).toThrow(RangeError);
  expect(() => encodeRiveMessage({ t: -1, trigger: "nod" })).toThrow(RangeError);
  expect(() => encodeRiveMessage({ trigger: "" })).toThrow(RangeError);
  expect(() => encodeRiveMessage({ view_model: {} })).toThrow(TypeError);
  expect(() => encodeRiveMessage({ view_model: { x: Number.NaN } })).toThrow(TypeError);
  expect(() => encodeRiveMessage({ view_model: { x: { y: 1 } as never } })).toThrow(TypeError);
  expect(() => encodeRiveMessage({ artboard: "Quiz" })).toThrow(RangeError);
  const fits = "x".repeat(RIVE_MESSAGE_MAX_BYTES - JSON.stringify({ view_model: { s: "" } }).length);
  expect(encodeRiveMessage({ view_model: { s: fits } })).toHaveLength(RIVE_MESSAGE_MAX_BYTES);
  expect(() => encodeRiveMessage({ view_model: { s: `${fits}x` } })).toThrow(/1024 bytes/u);
  // Bytes, not characters: two-byte characters reach the limit at half the length.
  expect(() => encodeRiveMessage({ view_model: { s: "é".repeat(fits.length) } })).toThrow(/1024 bytes/u);
});

it("parses phone messages, ignores unknown keys, and drops the malformed", () => {
  expect(parseRiveMessage(JSON.stringify({ view_model: { answer: "B" }, extra: 1 }))).toEqual({ view_model: { answer: "B" } });
  expect(parseRiveMessage(new TextEncoder().encode(JSON.stringify({ trigger: "tapped_start" })))).toEqual({ trigger: "tapped_start" });
  expect(parseRiveMessage("[]")).toBeNull();
  expect(parseRiveMessage(JSON.stringify({ t: 5 }))).toBeNull();
  expect(parseRiveMessage(JSON.stringify({ trigger: 3 }))).toBeNull();
  expect(parseRiveMessage(JSON.stringify({ view_model: { a: "x".repeat(2_000) } }))).toBeNull();
});

it("maps letters to Preston Blair shapes through Papagayo's CMU table", () => {
  // m->M->MBP, a->AE->AI, p->P->MBP; o->AO->O; f->F->FV; l->L; w->W->WQ; s->S->etc; u->UH->U; e->EH->E
  expect(named(visemesFromAlignment(align("map")))).toEqual([[0, "MBP"], [50, "AI"], [100, "MBP"], [150, "rest"]]);
  expect(named(visemesFromAlignment(align("of")))).toEqual([[0, "O"], [50, "FV"], [100, "rest"]]);
  expect(named(visemesFromAlignment(align("lw")))).toEqual([[0, "L"], [50, "WQ"], [100, "rest"]]);
  expect(named(visemesFromAlignment(align("sue")))).toEqual([[0, "etc"], [50, "U"], [100, "E"], [150, "rest"]]);
});

it("reads digraphs as one sound, holds through spaces, and closes on punctuation", () => {
  // "sh" -> SH -> WQ over both letters; "oo" -> UW -> U; the space holds; "." rests.
  expect(named(visemesFromAlignment(align("shoo me.")))).toEqual([
    [0, "WQ"], [100, "U"], [250, "MBP"], [300, "E"], [350, "rest"],
  ]);
  // Repeats merge: "mm" is one cue.
  expect(named(visemesFromAlignment(align("mm")))).toEqual([[0, "MBP"], [100, "rest"]]);
});

it("leaves the mouth open for a continuing chunk and keeps offsets from the alignment", () => {
  expect(named(visemesFromAlignment(align("am", 40, 1_000), { endWithRest: false }))).toEqual([[1_000, "AI"], [1_040, "MBP"]]);
  expect(visemesFromAlignment(align("  "))).toEqual([]);
  expect(visemesFromAlignment(align(" , "))).toEqual([{ t: 50, viseme: 0 }]);
  expect(() => visemesFromAlignment({ chars: ["a"], char_start_times_ms: [], char_durations_ms: [1] })).toThrow(RangeError);
});

it("spreads word timings over their letters", () => {
  const alignment = alignmentFromWords([{ text: "hi", start_ms: 0, end_ms: 200 }, { text: "mo", start_ms: 300, end_ms: 400 }]);
  expect(alignment.chars).toEqual(["h", "i", " ", "m", "o", " "]);
  expect(alignment.char_start_times_ms).toEqual([0, 100, 200, 300, 350, 400]);
  expect(named(visemesFromAlignment(alignment))).toEqual([[0, "E"], [100, "AI"], [300, "MBP"], [350, "O"], [400, "rest"]]);
});

it("accepts the room's rive frames and rive in track lists, and refuses bad stream ids", () => {
  expect(parseCallRoomServerFrame({ type: "rive", id: 0 })).toEqual({ type: "rive", id: 0 });
  expect(parseCallRoomServerFrame({ type: "rive", id: 65_534 })).toEqual({ type: "rive", id: 65_534 });
  expect(() => parseCallRoomServerFrame({ type: "rive", id: 65_535 })).toThrow();
  expect(() => parseCallRoomServerFrame({ type: "rive", id: 1.5 })).toThrow();
  expect(() => parseCallRoomServerFrame({ type: "rive" })).toThrow();
  expect(parseCallRoomServerFrame({ type: "offer", session_description: { type: "offer", sdp: "v=0" }, track: "rive" }))
    .toMatchObject({ track: "rive" });
  const participant = (tracks: string[]) => ({
    contact_id: "a", kind: "agent", attached: true, track: "audio", muted: false, connected: true, video: false, tracks,
  });
  const state = (tracks: string[]) => ({
    type: "roomState",
    call: { id: "c", chat_id: "h", status: "in-progress" },
    participants: [participant(["audio"]), participant(tracks)],
  });
  expect(parseCallRoomServerFrame(state(["audio", "video", "rive"]))).not.toBeNull();
  expect(() => parseCallRoomServerFrame(state(["audio", "face"]))).toThrow();
  expect(() => parseCallRoomServerFrame(state(["rive", "rive"]))).toThrow();
});
