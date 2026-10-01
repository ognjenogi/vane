import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import BaseLLM from '@/lib/models/base/llm';
import { clarifierPrompt } from '@/lib/prompts/search/clarifier';
import { ChatTurnMessage } from '@/lib/types';
import { buildEffectiveQuery, clarify } from '../clarifier';

const chatHistory: ChatTurnMessage[] = [
  { role: 'user', content: 'Tell me about the Vane releases' },
  { role: 'assistant', content: 'Sure, what would you like to know?' },
];

const QUERY = 'compare the v1 and v2 release notes';

/**
 * `clarify` only touches `generateObject`, so the fake stands in for the whole
 * LLM surface (a full BaseLLM would drag in streaming + transport concerns).
 */
const llmResolving = (output: unknown) =>
  ({
    generateObject: vi.fn().mockResolvedValue(output),
  }) as unknown as BaseLLM<any>;

const llmRejecting = (error: unknown) =>
  ({
    generateObject: vi.fn().mockRejectedValue(error),
  }) as unknown as BaseLLM<any>;

/** Never settles — the only thing that can unblock `clarify` is its timeout. */
const llmHanging = () =>
  ({
    generateObject: vi.fn(() => new Promise(() => {})),
  }) as unknown as BaseLLM<any>;

const call = (llm: BaseLLM<any>) =>
  clarify({ query: QUERY, chatHistory, llm }, 50);

// Every failure path warns before degrading, which is expected noise here.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// Cleared per test so a `toHaveBeenCalledWith` assertion can only be satisfied
// by the call that test itself provoked.
beforeEach(() => {
  warnSpy.mockClear();
});

afterAll(() => {
  warnSpy.mockRestore();
});

describe('clarify', () => {
  it('returns the questions the model generated', async () => {
    const llm = llmResolving({
      questions: ['Which versions?', 'For what team?'],
    });

    await expect(call(llm)).resolves.toEqual([
      'Which versions?',
      'For what team?',
    ]);
  });

  it('passes the conversation history and the schema to the model', async () => {
    const llm = llmResolving({ questions: [] });

    await call(llm);

    const generateObject = (llm as any).generateObject;
    expect(generateObject).toHaveBeenCalledTimes(1);
    const [{ messages, schema }] = generateObject.mock.calls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(clarifierPrompt);
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('<conversation_history>');
    expect(messages[1].content).toContain('<user_query>');
    expect(messages[1].content).toContain(QUERY);
    expect(messages[1].content).toContain('Tell me about the Vane releases');
    expect(schema.safeParse({ questions: ['ok'] }).success).toBe(true);
    expect(schema.safeParse({ questions: 'nope' }).success).toBe(false);
  });

  it('returns [] when the model decides no questions are needed', async () => {
    await expect(call(llmResolving({ questions: [] }))).resolves.toEqual([]);
  });

  it('returns [] when the LLM throws, and says so', async () => {
    await expect(
      call(llmRejecting(new Error('connection reset'))),
    ).resolves.toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Clarification failed'),
      'connection reset',
    );
  });

  // Unlike classify(), clarify() swallows quota/auth failures too: an unusable
  // clarifier must never stop the turn, it just means no questions get asked.
  it.each([
    ['http status', Object.assign(new Error('Unauthorized'), { status: 401 })],
    ['rate limit message', new Error('You exceeded your current quota')],
  ])('returns [] on a quota/auth failure (%s)', async (_label, error) => {
    await expect(call(llmRejecting(error))).resolves.toEqual([]);
  });

  it('returns [] instead of hanging when the LLM never settles', async () => {
    await expect(call(llmHanging())).resolves.toEqual([]);
  });

  it('lets a slow but healthy model finish on the default timeout', async () => {
    // glm-5.3 was measured at 9-11s for this request. With the old 6s default
    // it was always killed, so the feature silently never appeared; fake timers
    // keep that case instant here.
    vi.useFakeTimers();

    try {
      const questions = ['Which versions should I compare?'];
      const slowLlm = {
        generateObject: vi.fn(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ questions }), 11_000),
            ),
        ),
      } as unknown as BaseLLM<any>;

      // No explicit timeoutMs: this pins the default, not a caller-supplied one.
      const pending = clarify({ query: QUERY, chatHistory, llm: slowLlm });
      await vi.advanceTimersByTimeAsync(11_000);

      await expect(pending).resolves.toEqual(questions);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops non-string and blank questions instead of passing them on', async () => {
    // A provider returns unvalidated parsed JSON on a schema failure, and
    // Task 7 renders these — an object child would crash React.
    const llm = llmResolving({
      questions: ['Which versions?', 1, { text: 'Which versions?' }, '   ', ''],
    });

    await expect(call(llm)).resolves.toEqual(['Which versions?']);
  });

  it('returns [] when every question is unusable', async () => {
    const llm = llmResolving({ questions: [null, 3, { text: 'x' }, ' '] });

    await expect(call(llm)).resolves.toEqual([]);
  });

  it.each([
    ['missing questions key', {}],
    ['questions is not an array', { questions: 'Which version?' }],
    ['no output at all', undefined],
  ])('returns [] on malformed output (%s)', async (_label, output) => {
    await expect(call(llmResolving(output))).resolves.toEqual([]);
  });
});

describe('buildEffectiveQuery', () => {
  it('appends the answered questions to the query', () => {
    const result = buildEffectiveQuery(QUERY, {
      skipped: false,
      answers: [
        { question: 'Which versions?', answer: 'v1 and v2' },
        { question: 'For what team?', answer: 'the platform team' },
      ],
    });

    expect(result).toBe(
      `${QUERY}\n\n<user_clarifications>\n` +
        'Q: Which versions?\nA: v1 and v2\n\n' +
        'Q: For what team?\nA: the platform team\n' +
        '</user_clarifications>',
    );
  });

  it('keeps the query unchanged when the user skipped', () => {
    expect(
      buildEffectiveQuery(QUERY, {
        skipped: true,
        answers: [{ question: 'Which versions?', answer: 'v1 and v2' }],
      }),
    ).toBe(QUERY);
  });

  it.each([
    ['there are no answers', { skipped: false }],
    [
      'every answer is blank',
      { skipped: false, answers: [{ question: 'Q', answer: '   ' }] },
    ],
    ['an answer is missing', { skipped: false, answers: [{ question: 'Q' }] }],
  ])('keeps the query unchanged when %s', (_label, clarification) => {
    expect(buildEffectiveQuery(QUERY, clarification)).toBe(QUERY);
  });

  it('drops unanswered questions but keeps the answered ones', () => {
    const result = buildEffectiveQuery(QUERY, {
      skipped: false,
      answers: [
        { question: 'Which versions?', answer: '' },
        { question: 'For what team?', answer: 'the platform team' },
      ],
    });

    expect(result).toBe(
      `${QUERY}\n\n<user_clarifications>\nQ: For what team?\nA: the platform team\n</user_clarifications>`,
    );
  });
});
