/**
 * Optional lip-sync helper for Rive characters: text timings from a TTS
 * engine become mouth shapes on a timeline, to send as a `viseme` View Model
 * number with `rive.set({ viseme }, { at })`.
 *
 * The ten shapes are Preston Blair's, the set Papagayo and Moho draw, in this
 * order: 0 rest, 1 AI, 2 E, 3 O, 4 U, 5 MBP, 6 FV, 7 L, 8 etc (S, T and the
 * other consonants), 9 WQ. Sounds map to shapes by Papagayo-NG's own table
 * (phonemes/preston_blair.json `cmu_39_phoneme_conversion`; copy saved under
 * _sources/avatar-api-shapes-20261001/papagayo-ng). TTS engines report
 * characters, not phonemes, so each letter or digraph is first read as the
 * CMU phoneme it most often spells; English spelling is not phonetic, so this
 * is an approximation that keeps the mouth moving with the words.
 */
export const VISEMES = ["rest", "AI", "E", "O", "U", "MBP", "FV", "L", "etc", "WQ"] as const;

export type VisemeName = (typeof VISEMES)[number];
/** Index into {@link VISEMES}: 0 rest through 9 WQ. */
export type Viseme = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface VisemeCue {
  /** Milliseconds from the start of the audio the alignment describes. */
  t: number;
  viseme: Viseme;
}

/** ElevenLabs' `alignment` shape (Agents WebSocket `audio` event; TTS `with-timestamps`). */
export interface CharacterAlignment {
  chars: readonly string[];
  char_start_times_ms: readonly number[];
  char_durations_ms: readonly number[];
}

/** One spoken word and its span, as Pipecat, Cartesia and LiveKit report them. */
export interface WordTiming {
  text: string;
  start_ms: number;
  end_ms: number;
}

/** Papagayo-NG `cmu_39_phoneme_conversion`, keyed by CMU phoneme. */
const CMU_TO_SHAPE: Readonly<Record<string, VisemeName>> = {
  AA: "AI", AE: "AI", AH: "E", AO: "O", AW: "U", AY: "AI", B: "MBP", CH: "WQ", D: "E", DH: "L",
  EH: "E", ER: "WQ", EY: "E", F: "FV", G: "E", HH: "E", IH: "AI", IY: "E", JH: "WQ", K: "E",
  L: "L", M: "MBP", N: "etc", NG: "E", OW: "WQ", OY: "WQ", P: "MBP", R: "L", S: "etc", SH: "WQ",
  T: "E", TH: "E", UH: "U", UW: "U", V: "FV", W: "WQ", Y: "E", Z: "etc", ZH: "WQ",
};

/** Two-letter spellings read as one sound, checked before single letters. */
const DIGRAPHS: Readonly<Record<string, string>> = {
  th: "TH", sh: "SH", ch: "CH", ph: "F", wh: "W", ng: "NG", oo: "UW", ee: "IY", qu: "W", ck: "K",
};

/** The CMU phoneme each letter most often spells. */
const LETTERS: Readonly<Record<string, string>> = {
  a: "AE", b: "B", c: "K", d: "D", e: "EH", f: "F", g: "G", h: "HH", i: "IH", j: "JH", k: "K",
  l: "L", m: "M", n: "N", o: "AO", p: "P", q: "K", r: "R", s: "S", t: "T", u: "UH", v: "V",
  w: "W", x: "S", y: "Y", z: "Z",
};

/** Sentence punctuation closes the mouth; spaces and anything else hold the shape before them. */
const PAUSES = new Set([".", ",", "!", "?", ";", ":", "…", "—"]);

const shapeIndex = (name: VisemeName): Viseme => VISEMES.indexOf(name) as Viseme;

const isLetter = (char: string): boolean => char.length === 1 && char.toLowerCase() !== char.toUpperCase();

export interface VisemeOptions {
  /** End on `rest` where the last character ends. Default true; pass false for a chunk the next one continues. */
  endWithRest?: boolean;
}

/**
 * Character timings to mouth-shape cues in milliseconds of the audio they
 * describe, ending on `rest` where the last character ends. Consecutive
 * repeats are merged.
 */
export const visemesFromAlignment = (
  alignment: CharacterAlignment,
  options: VisemeOptions = {},
): VisemeCue[] => {
  const { chars, char_start_times_ms: starts, char_durations_ms: durations } = alignment;
  if (chars.length !== starts.length || chars.length !== durations.length) {
    throw new RangeError("Alignment arrays must have the same length.");
  }
  const cues: VisemeCue[] = [];
  const push = (t: number, viseme: Viseme): void => {
    const last = cues.at(-1);
    if (last?.viseme === viseme) return;
    if (last && last.t === t) {
      last.viseme = viseme;
      if (cues.at(-2)?.viseme === viseme) cues.pop();
      return;
    }
    cues.push({ t, viseme });
  };
  let end = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!.toLowerCase();
    const start = Math.max(0, starts[index]!);
    end = Math.max(end, start + Math.max(0, durations[index]!));
    if (PAUSES.has(char)) {
      push(start, 0);
      continue;
    }
    if (!isLetter(char)) continue;
    const digraph = DIGRAPHS[char + (chars[index + 1] ?? "").toLowerCase()];
    const phoneme = digraph ?? LETTERS[char];
    if (!phoneme) continue;
    push(start, shapeIndex(CMU_TO_SHAPE[phoneme]!));
    if (digraph) {
      const next = index + 1;
      end = Math.max(end, Math.max(0, starts[next]!) + Math.max(0, durations[next]!));
      index = next;
    }
  }
  if (cues.length && options.endWithRest !== false) push(end, 0);
  return cues;
};

/**
 * Word timings to the character alignment {@link visemesFromAlignment}
 * takes: each word's span is shared evenly among its characters, and the
 * gaps between words become spaces.
 */
export const alignmentFromWords = (words: readonly WordTiming[]): CharacterAlignment => {
  const chars: string[] = [];
  const char_start_times_ms: number[] = [];
  const char_durations_ms: number[] = [];
  for (const word of words) {
    const letters = [...word.text];
    if (!letters.length) continue;
    const span = Math.max(0, word.end_ms - word.start_ms);
    const each = span / letters.length;
    letters.forEach((char, index) => {
      chars.push(char);
      char_start_times_ms.push(word.start_ms + each * index);
      char_durations_ms.push(each);
    });
    chars.push(" ");
    char_start_times_ms.push(word.end_ms);
    char_durations_ms.push(0);
  }
  return { chars, char_start_times_ms, char_durations_ms };
};
