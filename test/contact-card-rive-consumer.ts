// Compile-only consumer checks: no client construction or network calls.
import type Relay from "@relaymessenger/sdk";
import type { RiveFile, SetContactCardResponse } from "@relaymessenger/sdk";

const omitted: SetContactCardResponse = {
  handle: "echo", first_name: "Echo", last_name: null, image_url: null,
  image_color: null, is_active: true, kind: "agent",
};
const cleared: SetContactCardResponse = { ...omitted, rive: null };
const named: RiveFile = {
  file: "https://example.test/agent.riv",
  artboard: "Call", state_machine: "Main", view_model: "Main",
};
const defaults: RiveFile = {
  file: "https://example.test/agent.riv",
  artboard: null, state_machine: null, view_model: null,
};
const withNames: SetContactCardResponse = { ...omitted, rive: named };
const withDefaults: SetContactCardResponse = { ...omitted, rive: defaults };

// Check the actual method results, not only a standalone exported interface.
declare const created: Awaited<ReturnType<Relay["contactCard"]["create"]>>;
declare const updated: Awaited<ReturnType<Relay["contactCard"]["update"]>>;
for (const response of [created, updated]) {
  const rive: RiveFile | null | undefined = response.rive;
  // @ts-expect-error A write response can omit rive or explicitly clear it.
  const alwaysPresent: RiveFile = response.rive;
  if (rive != null) {
    const file: string = rive.file;
    const names: Array<string | null> = [rive.artboard, rive.state_machine, rive.view_model];
    void [file, names];
  }
  void alwaysPresent;
}

// Exercise the response's nested type so widening it loses these expected errors.
type ResponseRive = NonNullable<SetContactCardResponse["rive"]>;
// @ts-expect-error A response Rive file must have a file address.
const missingFile: ResponseRive = { artboard: null, state_machine: null, view_model: null };
// @ts-expect-error artboard is required even when using the file's default.
const missingArtboard: ResponseRive = { file: named.file, state_machine: null, view_model: null };
// @ts-expect-error state_machine is required even when using the file's default.
const missingStateMachine: ResponseRive = { file: named.file, artboard: null, view_model: null };
// @ts-expect-error view_model is required even when using the file's default.
const missingViewModel: ResponseRive = { file: named.file, artboard: null, state_machine: null };
// @ts-expect-error file is not nullable.
const nullFile: ResponseRive = { ...named, file: null };
// @ts-expect-error file is a string, not a number.
const numericFile: ResponseRive = { ...named, file: 42 };
// @ts-expect-error artboard is a string or null, not a number.
const numericArtboard: ResponseRive = { ...named, artboard: 42 };
// @ts-expect-error state_machine is a string or null, not a number.
const numericStateMachine: ResponseRive = { ...named, state_machine: 42 };
// @ts-expect-error view_model names a model; it is not the live-call data object.
const objectViewModel: ResponseRive = { ...named, view_model: { speaking: true } };
// @ts-expect-error rive is a RiveFile or null, not a bare address.
const bareAddress: SetContactCardResponse = { ...omitted, rive: named.file };

void [
  cleared, withNames, withDefaults, missingFile, missingArtboard,
  missingStateMachine, missingViewModel, nullFile, numericFile,
  numericArtboard, numericStateMachine, objectViewModel, bareAddress,
];
