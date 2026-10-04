/**
 * Prompt and policy layer for the decision client.
 *
 * The service (TypeSafe Jev at https://api.typesafe.ai/v1, or a local
 * `laya-serve` that speaks the identical wire format) answers three primitives:
 *
 * - `choice` — criteria is a map option -> description (up to 255 options). The
 *   answer carries `choice`, the full `probabilities` map, and `confidence`.
 * - `score` — criteria is an ordered rubric array. The answer carries a
 *   fractional zero-based index only: no probabilities, no confidence.
 * - `noul` — a single probability with no confidence field. Not exposed here,
 *   because a bare probability with no option set carries no abstention path.
 *
 * Measured facts this file encodes:
 *
 * - Calibration is good on a small semantic yes/no (ECE ~0.08) and degrades on
 *   multi-way questions (up to 0.305). The band policy below is therefore
 *   conservative and much stricter as the option set grows.
 * - An explicit abstain option is mandatory. Removing it dropped accuracy on
 *   unanswerable items from 0.950 to 0.000 and pushed the stereotype rate from
 *   0.03 to 0.79 at 0.79 confidence. Every `choice` built here carries one, and
 *   `buildChoiceQuestion` throws when the caller did not supply it.
 *
 * Language: the instructions are English because English is the primary
 * training language of the hosted model. The `state` is forwarded verbatim and
 * is never translated inside the client: the only backend with published
 * Russian coverage is the local multilingual `laya-serve` model.
 */

/** Thrown when a call violates the client's input contract. This is a caller bug, not a transport failure: it always throws and never resolves to a decision. */
export class DecisionClientInputError extends Error {
  override readonly name = "DecisionClientInputError";
}

/** One answer candidate. `value` is what the client returns; `description` is the text the model reads. */
export interface DecisionOption {
  readonly value: string;
  readonly description: string;
}

export interface DecisionChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Record<string, string>;
}

export interface DecisionScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export type DecisionQuestion = DecisionChoiceQuestion | DecisionScoreQuestion;

/** Hard cap published for the `choice` primitive. The abstain option counts against it. */
export const MAX_CHOICE_OPTIONS = 255;

/** A rubric with fewer rungs cannot express an ordering, so a score call needs at least two. */
export const MIN_SCORE_RUBRIC_LENGTH = 2;

/** Practical upper bound for an ordered rubric; longer rubrics cost tokens and blur the ordering. */
export const MAX_SCORE_RUBRIC_LENGTH = 50;

export const CHOICE_INSTRUCTIONS =
  "Choose the single option that best describes the state. If no option fits, choose the abstain option. Answer with one option only.";

export const JUDGE_TRUE_VALUE = "true";
export const JUDGE_FALSE_VALUE = "false";

export const JUDGE_INSTRUCTIONS_SUFFIX =
  "Answer \"true\" only if the state clearly supports it. Answer \"false\" only if the state clearly contradicts it. If the state does not settle the question, choose the abstain option.";

export const SCORE_INSTRUCTIONS =
  "Rate the state against the rubric. The rubric is ordered from worst to best. Choose the rung that best matches the state.";

/** `decide` means "the caller may act on this value without a human". `uncertain` means "escalate". */
export type DecisionBand = "decide" | "uncertain";

/** The shape of the question decides which threshold applies. */
export type DecisionShape = "binary" | "ternary" | "multiWay" | "ordinalScore";

export interface DecisionBandThresholds {
  /** Two substantive options (yes/no). Measured ECE ~0.08, so 0.90 is defensible. */
  readonly binary: number;
  /**
   * Three substantive options. NEVER MEASURED, so there is no default: a caller
   * must pass a threshold explicitly to let a ternary answer auto-decide.
   */
  readonly ternary?: number | undefined;
  /**
   * Four or more substantive options. Measured ECE up to 0.305, which makes any
   * threshold below ~1.2 unable to buy 0.90 accuracy: the number a model would
   * need to claim does not exist. So the default is "never auto-decide", the
   * same treatment `ordinalScore` gets, and a caller must opt in.
   */
  readonly multiWay?: number | undefined;
  /** The ordinal `score` primitive measured no better than guessing even on the real Jev, so it has no default. A caller must pass a threshold explicitly to let a score auto-decide. */
  readonly ordinalScore?: number | undefined;
  /** Probability mass on the abstain option at or above which the item is never auto-decided, whatever the confidence. */
  readonly abstainEscalateAt: number;
}

/**
 * Default band policy. The numbers are deliberately conservative because the
 * call sites are safety-adjacent: a wrong auto-decision costs more than an extra
 * escalation.
 *
 * - binary 0.90: at ECE 0.08 the worst case of a wrong auto-decide is ~0.82
 *   accuracy, which is acceptable. Anything below it escalates.
 * - ternary: unmeasured. No default, so it escalates until somebody measures it.
 * - multiWay: with ECE up to 0.305 the threshold that would buy 0.90 accuracy
 *   exceeds 1.0 and is unreachable. No default, so it escalates. The abstain
 *   floor alone cannot replace this: it only measures how much mass says "cannot
 *   answer", not how often the top class is the wrong one.
 * - abstainEscalateAt 0.10: once 10% of the mass says "cannot answer", the item
 *   is not safe to auto-decide.
 */
export const DEFAULT_DECISION_BAND_THRESHOLDS: DecisionBandThresholds = {
  binary: 0.9,
  ternary: undefined,
  multiWay: undefined,
  ordinalScore: undefined,
  abstainEscalateAt: 0.1,
};

/** Per-call override of the band policy. */
export interface DecisionBandPolicy {
  readonly thresholds?: Partial<DecisionBandThresholds> | undefined;
  readonly abstainEscalateAt?: number | undefined;
}

export interface DecisionBandInput {
  readonly shape: DecisionShape;
  /** Raw probabilities for the option set of THIS call. Never compare them with numbers from a different option set. */
  readonly probabilities: Record<string, number>;
  readonly abstainValue?: string | undefined;
  /** The model's own confidence when the primitive reports one. */
  readonly confidence?: number | null | undefined;
  readonly policy?: DecisionBandPolicy | undefined;
}

function topProbability(probabilities: Record<string, number>): number | null {
  let top: number | null = null;
  for (const value of Object.values(probabilities)) {
    if (!Number.isFinite(value)) continue;
    if (top === null || value > top) top = value;
  }
  return top;
}

function thresholdFor(shape: DecisionShape, thresholds: DecisionBandThresholds): number | null {
  switch (shape) {
    case "binary": return thresholds.binary;
    // A shape with no default threshold has no basis for one, so it escalates.
    case "ternary": return thresholds.ternary ?? null;
    case "multiWay": return thresholds.multiWay ?? null;
    case "ordinalScore": return thresholds.ordinalScore ?? null;
  }
}

/**
 * Turn raw probabilities into `decide` or `uncertain`. The result is advisory:
 * the client never drops a candidate value on its own, it marks the value as
 * not safe to auto-accept.
 *
 * Rules, in order:
 * 1. Abstain mass at or above `abstainEscalateAt` always escalates.
 * 2. The effective signal is the MINIMUM of `confidence` and the top
 *    probability, so the model must agree with itself before anything is
 *    auto-accepted.
 * 3. A primitive with no confidence and no probabilities (the ordinal `score`)
 *    has no threshold by default and always escalates.
 */
export function classifyDecisionBand(input: DecisionBandInput): DecisionBand {
  const base = DEFAULT_DECISION_BAND_THRESHOLDS;
  const override = input.policy?.thresholds ?? {};
  const thresholds: DecisionBandThresholds = {
    binary: override.binary ?? base.binary,
    ternary: override.ternary ?? base.ternary,
    multiWay: override.multiWay ?? base.multiWay,
    ordinalScore: override.ordinalScore ?? base.ordinalScore,
    abstainEscalateAt: input.policy?.abstainEscalateAt ?? override.abstainEscalateAt ?? base.abstainEscalateAt,
  };
  if (input.abstainValue !== undefined) {
    const abstainMass = input.probabilities[input.abstainValue];
    if (abstainMass !== undefined && Number.isFinite(abstainMass) && abstainMass >= thresholds.abstainEscalateAt) return "uncertain";
  }
  const threshold = thresholdFor(input.shape, thresholds);
  if (threshold === null) return "uncertain";
  const top = topProbability(input.probabilities);
  const confidence = input.confidence !== null && input.confidence !== undefined && Number.isFinite(input.confidence) ? input.confidence : null;
  const signal = confidence !== null && top !== null ? Math.min(confidence, top) : (confidence ?? top);
  if (signal === null) return "uncertain";
  return signal >= threshold ? "decide" : "uncertain";
}

/** Pick the band shape from the number of substantive (non-abstain) options. */
export function decisionShapeForOptionCount(substantiveCount: number): DecisionShape {
  if (substantiveCount <= 2) return "binary";
  if (substantiveCount === 3) return "ternary";
  return "multiWay";
}

function assertOption(option: DecisionOption, label: string): void {
  if (typeof option?.value !== "string" || option.value.trim().length === 0) {
    throw new DecisionClientInputError(`Decision ${label} needs a non-empty value.`);
  }
  if (option.value !== option.value.trim()) {
    throw new DecisionClientInputError(`Decision ${label} value "${option.value}" has leading or trailing whitespace.`);
  }
  if (typeof option.description !== "string" || option.description.trim().length === 0) {
    throw new DecisionClientInputError(`Decision ${label} "${option.value}" needs a non-empty description.`);
  }
}

/**
 * Build a `choice` question. The abstain option is a required argument, not a
 * convention: a caller that forgets it gets an exception here, before any
 * request is sent.
 */
export function buildChoiceQuestion(input: {
  readonly instructions?: string | undefined;
  readonly options: readonly DecisionOption[];
  readonly abstain: DecisionOption;
}): DecisionChoiceQuestion {
  if (!Array.isArray(input.options)) throw new DecisionClientInputError("choose() needs an array of options.");
  if (input.options.length === 0) throw new DecisionClientInputError("choose() needs at least one option.");
  if (input.abstain === undefined || input.abstain === null) {
    throw new DecisionClientInputError("choose() needs an explicit abstain option; the model has no other way to say that the item is unanswerable.");
  }
  if (input.options.length + 1 > MAX_CHOICE_OPTIONS) {
    throw new DecisionClientInputError(`choose() sent ${input.options.length + 1} options including the abstain option; the limit is ${MAX_CHOICE_OPTIONS}.`);
  }
  assertOption(input.abstain, "abstain option");
  const criteria: Record<string, string> = { [input.abstain.value]: input.abstain.description };
  for (const option of input.options) {
    assertOption(option, "option");
    if (Object.hasOwn(criteria, option.value)) {
      throw new DecisionClientInputError(`Decision option "${option.value}" is listed twice; every value must be unique.`);
    }
    criteria[option.value] = option.description;
  }
  const instructions = input.instructions ?? CHOICE_INSTRUCTIONS;
  if (instructions.trim().length === 0) throw new DecisionClientInputError("choose() instructions must not be empty.");
  return { type: "choice", instructions, criteria };
}

/**
 * Build the two-way `judge` question. The abstain option is required here too.
 *
 * The question text goes into `instructions`. It used to be validated and then
 * discarded, which was invisible and load-bearing: the client's cache key is
 * `decisionCacheKey({model, state, question})`, and two `judge()` calls sharing a
 * `state` and the same true/false criteria produced the SAME key. The second
 * call then joined the first one's in-flight request and was handed the first
 * one's answer marked `cached: true` -- two callers asking two different
 * questions were indistinguishable to the client, and the model never saw the
 * question it was asked at all.
 *
 * Folding it into `instructions` fixes both halves: the model reads the
 * question, and `instructions` is part of the hashed question object, so the
 * cache key differentiates the calls.
 */
export function buildJudgeQuestion(input: {
  readonly question: string;
  readonly abstain: DecisionOption;
  readonly instructions?: string | undefined;
  readonly trueDescription?: string | undefined;
  readonly falseDescription?: string | undefined;
}): DecisionChoiceQuestion {
  if (typeof input.question !== "string" || input.question.trim().length === 0) {
    throw new DecisionClientInputError("judge() needs a non-empty question.");
  }
  if (input.abstain === undefined || input.abstain === null) {
    throw new DecisionClientInputError("judge() needs an explicit abstain option; without it the model must answer yes or no on every item.");
  }
  return buildChoiceQuestion({
    instructions: `${input.instructions ?? JUDGE_INSTRUCTIONS_SUFFIX}\nQuestion: ${input.question.trim()}`,
    options: [
      { value: JUDGE_TRUE_VALUE, description: input.trueDescription ?? "The state supports the statement." },
      { value: JUDGE_FALSE_VALUE, description: input.falseDescription ?? "The state contradicts the statement." },
    ],
    abstain: input.abstain,
  });
}

/** Build the ordered `score` question. No abstain option: a rubric already has an implicit "in between" rung. */
export function buildScoreQuestion(input: {
  readonly rubric: readonly string[];
  readonly instructions?: string | undefined;
}): DecisionScoreQuestion {
  if (!Array.isArray(input.rubric)) throw new DecisionClientInputError("score() needs an array of rubric rungs.");
  if (input.rubric.length < MIN_SCORE_RUBRIC_LENGTH || input.rubric.length > MAX_SCORE_RUBRIC_LENGTH) {
    throw new DecisionClientInputError(`score() needs between ${MIN_SCORE_RUBRIC_LENGTH} and ${MAX_SCORE_RUBRIC_LENGTH} rubric rungs; got ${input.rubric.length}.`);
  }
  const criteria = input.rubric.map((rung, index) => {
    if (typeof rung !== "string" || rung.trim().length === 0) throw new DecisionClientInputError(`Rubric rung ${index} must be a non-empty string.`);
    return rung;
  });
  const instructions = input.instructions ?? SCORE_INSTRUCTIONS;
  if (instructions.trim().length === 0) throw new DecisionClientInputError("score() instructions must not be empty.");
  return { type: "score", instructions, criteria };
}

/** The wire request body. `questions` is keyed by the caller-visible question id. */
export interface DecisionWireRequest {
  readonly model: string;
  readonly state: string;
  readonly questions: Record<string, DecisionQuestion>;
}