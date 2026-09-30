#!/usr/bin/env python3
"""Run only in a disposable Daytona checkout; restore every mutation in finally.

Each row removes one form behavior. A mutant is killed only by a test failure,
not a timeout or syntax/import failure. Logs and JSON receipts remain outside
tracked source. No production service or credential is used.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TS = 'packages/sdk/src/form.ts'
PY = 'python/relaymessenger/src/relaymessenger/form.py'
MUTANTS = []


def add(language, behavior, old, new, file=None, suite='form'):
    MUTANTS.append(dict(language=language, behavior=behavior, file=file or (TS if language == 'ts' else PY), old=old, new=new, suite=suite))


# Definition validation, limits, normalization, stable identity and field unions.
add('ts', 'reject unknown keys', 'if (extra !== undefined) throw', 'if (false) throw')
add('ts', 'reject empty unknown keys', 'if (extra !== undefined) throw', 'if (extra) throw')
add('py', 'reject unknown keys', 'if extra is not None:', 'if False:')
add('ts', 'trim visible labels', 'trim ? value.trim() : value', 'value')
add('py', 'ECMAScript whitespace parity', 'value.strip(_TRIM) if trim else value', 'value.strip() if trim else value')
add('ts', 'Unicode scalar limits', '[...result].length', 'result.length')
add('py', 'Unicode scalar limits', 'len(result) > maximum', 'len(result.encode("utf-16-le")) // 2 > maximum')
add('ts', 'nonblank labels', '(trim && !result)', 'false')
add('py', 'nonblank labels', '(trim and not result)', 'False')
add('ts', 'boolean types', 'typeof value !== "boolean"', 'false')
add('py', 'boolean types', 'not isinstance(value, bool)', 'False')
add('ts', 'stable ASCII tokens', '!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)', 'false')
add('py', 'stable ASCII tokens', 'not _TOKEN.fullmatch(value)', 'False')
add('ts', 'safe integral max_length', 'Number.isSafeInteger(raw.max_length)', 'Number.isInteger(raw.max_length)')
add('py', 'safe integral max_length', 'maximum <= 9_007_199_254_740_991', 'maximum <= 9_007_199_254_740_992')
add('py', 'integral JSON numbers', 'type(maximum) not in (int, float)', 'type(maximum) is not int')
add('ts', 'date minimum length', '(kind === "date" ? 10 : 1)', '1')
add('py', 'date minimum length', '(10 if kind == "date" else 1)', '1')
add('ts', 'configurable text maximum', 'if (raw.max_length !== undefined) {', 'if (raw.max_length !== undefined) { if (kind === "text" && Number(raw.max_length) > 30) throw new Error("invented cap");')
add('py', 'configurable text maximum', 'maximum = raw["max_length"]', 'maximum = raw["max_length"]\n        if kind == "text" and isinstance(maximum, int) and maximum > 30: raise ValueError("invented cap")')
add('ts', 'unique field and page ids', 'if (seen.has(id))', 'if (false)')
add('py', 'unique field and page ids', 'if value in seen:', 'if False:')
add('ts', 'global field ids', 'fieldPart(field, fieldIds)', 'fieldPart(field, new Set<string>())')
add('py', 'global field ids', '_field(field, field_ids)', '_field(field, set())')
add('ts', 'page id bound', 'token(page.id, 19,', 'token(page.id, 20,')
add('py', 'page id bound', '_token(page.get("id"), 19,', '_token(page.get("id"), 20,')
add('ts', 'field id bound', 'token(raw.id, 100,', 'token(raw.id, 101,')
add('py', 'field id bound', '_token(raw.get("id"), 100,', '_token(raw.get("id"), 101,')
add('ts', 'field count bound', 'list(page.fields, 50,', 'list(page.fields, 51,')
add('py', 'field count bound', '_list(page.get("fields"), 50,', '_list(page.get("fields"), 51,')
add('ts', 'nonempty pages and fields', '!value.length ||', '')
add('py', 'nonempty pages and fields', 'or not value or', 'or')
add('ts', 'select option bound', 'kind === "select" ? 20 : 200', 'kind === "select" ? 21 : 200')
add('py', 'select option bound', '20 if kind == "select" else 200', '21 if kind == "select" else 200')
add('ts', 'picker option bound', 'kind === "select" ? 20 : 200', 'kind === "select" ? 20 : 201')
add('py', 'picker option bound', '20 if kind == "select" else 200', '20 if kind == "select" else 201')
add('ts', 'option label bound', 'text(option.label, 30,', 'text(option.label, 31,')
add('py', 'option label bound', '_text(option.get("label"), 30,', '_text(option.get("label"), 31,')
add('ts', 'option max fits choices', 'optionValue.length > (raw.max_length as number | undefined ?? 100)', 'false')
add('py', 'option max fits choices', 'len(option_value) > raw.get("max_length", 100)', 'False')
add('ts', 'placeholder preserved', 'Infinity, "placeholder", false', 'Infinity, "placeholder", true')
add('py', 'placeholder preserved', 'None, "placeholder", False', 'None, "placeholder", True')
add('ts', 'field type-specific label limits', 'kind === "date" ? 40 : kind === "select" ? 30 : 20', '80')
add('py', 'field type-specific label limits', '40 if kind == "date" else 30 if kind == "select" else 20', '80')
add('ts', 'splash text bound', '4096, "splash text"', '4097, "splash text"')
add('py', 'splash text bound', '4096, "splash text"', '4097, "splash text"')
add('ts', 'splash button bound', '35, "splash button title"', '36, "splash button title"')
add('py', 'splash button bound', '35, "splash button title"', '36, "splash button title"')
add('ts', 'received card title bound', '512, "received title"', '513, "received title"')
add('py', 'received card title bound', '512, "received title"', '513, "received title"')
add('ts', 'reply title literal', 'if (message.title !== "Form sent")', 'if (false)')
add('py', 'reply title literal', 'if raw.get("title") != "Form sent":', 'if False:')
add('ts', 'optional summary preserved', 'result.show_summary = boolean(raw.show_summary, "show_summary")', 'result.show_summary = false')
add('py', 'optional summary preserved', 'result["show_summary"] = _boolean(show_summary, "show_summary")', 'result["show_summary"] = False')
add('ts', 'optional text omitted when blank', 'return text?.trim() ?', 'return text !== undefined ?')
add('py', 'optional text ECMAScript blank', 'text.strip(_TRIM)', 'text.strip()')
add('ts', 'reply requires explicit source', '!Number.isInteger(replyTo.part_index)', 'false')
add('py', 'reply requires explicit source', 'if type(index) is not int or index < 0:', 'if False:')
add('ts', 'reply answers copied', 'Array.isArray(value) ? [...value] : value', 'value')
add('py', 'reply answers copied', 'list(value) if isinstance(value, list) else value', 'value')
add('ts', 'response metadata not label parsing', 'part.type === "form_response"', 'part.type === "selection_response"')
add('py', 'response metadata not label parsing', 'part.get("type") == "form_response"', 'part.get("type") == "selection_response"')
add('ts', 'answer fence integration', 'if (formed.form) {', 'if (false && formed.form) {', 'packages/sdk/src/links.ts')
add('ts', 'fence conflicts rejected', '(?:buttons|selection|payment)', '(?:never_matches)')
add('ts', 'send preserves answers', 'JSON.stringify(request.body)', 'JSON.stringify(request.body, (key, value) => key === "answers" ? {} : value)', 'packages/sdk/src/client.ts')
add('py', 'send preserves answers', 'json.dumps(body).encode()', 'json.dumps(body).replace("\\\"answers\\\"", "\\\"lost_answers\\\"").encode()', 'python/relaymessenger/src/relaymessenger/client.py')
add('ts', 'history retains viewer answers', 'JSON.parse(text) : undefined) as T', 'JSON.parse(text, (key, value) => key === "answers" ? null : value) : undefined) as T', 'packages/sdk/src/client.ts')
add('py', 'history retains viewer answers', 'return json.loads(text) if text else None', 'return json.loads(text.replace("\\\"answers\\\"", "\\\"lost_answers\\\"")) if text else None', 'python/relaymessenger/src/relaymessenger/client.py')
add('ts', 'idempotency header preserved', 'headers.set("idempotency-key", request.idempotencyKey)', 'headers.set("idempotency-key", "mutated")', 'packages/sdk/src/client.ts')
add('py', 'idempotency header preserved', 'headers["idempotency-key"] = idempotency_key', 'headers["idempotency-key"] = "mutated"', 'python/relaymessenger/src/relaymessenger/client.py')
add('ts', 'WebSocket preserves reply target', 'options.onEvent(event.event, { sequence: event.sequence })', 'options.onEvent({ ...event.event, data: { ...event.event.data, reply_to: null } } as typeof event.event, { sequence: event.sequence })', 'packages/sdk/src/websocket.ts', 'websocket')
add('py', 'WebSocket preserves reply target', 'self.on_event(event, {"sequence": sequence_text})', 'self.on_event({**event, "data": {**event["data"], "reply_to": None}}, {"sequence": sequence_text})', 'python/relaymessenger/src/relaymessenger/websocket.py', 'websocket')
add('ts', 'signed webhook preserves answers', 'JSON.parse(body.toString()) as T', 'JSON.parse(body.toString(), (key, value) => key === "answers" ? {} : value) as T', 'packages/sdk/src/webhooks.ts')
add('ts', 'public send union accepts forms', '\n  | FormPart\n', '\n', 'packages/sdk/src/types.ts', 'types')
add('ts', 'public send union accepts responses', '\n  | FormResponsePart\n', '\n', 'packages/sdk/src/types.ts', 'types')
add('ts', 'public read union includes forms', '\n  | FormPartResponse\n', '\n', 'packages/sdk/src/types.ts', 'types')
add('ts', 'public read union includes responses', '\n  | FormResponsePartResponse\n', '\n', 'packages/sdk/src/types.ts', 'types')
add('ts', 'public sent union includes forms', '\n    | FormPartResponse\n', '\n', 'packages/sdk/src/types.ts', 'types')
add('ts', 'public answers exclude booleans', 'Record<string, string | string[]>', 'Record<string, string | string[] | boolean>', 'packages/sdk/src/form-types.ts', 'types')


def command(mutant):
    if mutant['suite'] == 'types':
        return ['bash', '-c', 'npm run build --workspace @relaymessenger/sdk && npm run consumer:types']
    if mutant['language'] == 'ts':
        file = 'test/form-websocket.test.ts' if mutant['suite'] == 'websocket' else 'test/form.test.ts'
        return ['npm', 'test', '--workspace', '@relaymessenger/sdk', '--', file]
    args = ['python', '-m', 'pytest', 'python/relaymessenger/tests/test_form.py', '-q', '--tb=short']
    return args + (['-k', 'websocket'] if mutant['suite'] == 'websocket' else [])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipts', required=True)
    parser.add_argument('--filter', default='')
    args = parser.parse_args()
    receipts = Path(args.receipts)
    receipts.mkdir(parents=True, exist_ok=True)
    results = []
    for index, mutant in enumerate(MUTANTS, 1):
        if args.filter and args.filter not in mutant['behavior']:
            continue
        file = ROOT / mutant['file']
        original = file.read_text()
        assert original.count(mutant['old']) == 1, (mutant['behavior'], 'anchor mismatch', original.count(mutant['old']))
        name = f'{index:02}-{mutant["language"]}-' + re.sub('[^a-z0-9]+', '-', mutant['behavior'].lower())
        try:
            file.write_text(original.replace(mutant['old'], mutant['new']))
            result = subprocess.run(command(mutant), cwd=ROOT, capture_output=True, text=True, timeout=40,
                                    env={**os.environ, 'NO_COLOR': '1'})
            output = result.stdout + result.stderr
            (receipts / f'{name}.log').write_text(output)
            assertion = any(marker in output for marker in ('AssertionError', 'DID NOT RAISE', 'assert ', 'expected '))
            # A valid authoring vector must return a value. A mutant that
            # wrongly rejects that vector is killed by its unexpected
            # ValueError, even though the equality assertion isn't reached.
            rejected_valid = 'test_authoring[' in output and 'ValueError:' in output
            type_failure = mutant['suite'] == 'types' and 'error TS' in output
            killed = result.returncode != 0 and (assertion or rejected_valid or type_failure) and not any(marker in output for marker in ('SyntaxError', 'Transform failed', 'ModuleNotFoundError'))
            record = {**mutant, 'exit_code': result.returncode, 'killed': killed,
                      'failure_kind': 'type_contract' if type_failure else 'assertion' if assertion else 'valid_input_rejected' if rejected_valid else 'unclassified',
                      'log': f'{name}.log'}
            results.append(record)
            print(json.dumps({k: record[k] for k in ['language', 'behavior', 'exit_code', 'killed', 'log']}), flush=True)
            (receipts / 'mutations.json').write_text(json.dumps(results, indent=2) + '\n')
        finally:
            file.write_text(original)
    assert all(row['killed'] for row in results), 'A mutant survived or failed without a test assertion'
    print(f'Killed {len(results)}/{len(results)} form behavior mutations; source restored.')


if __name__ == '__main__':
    main()
