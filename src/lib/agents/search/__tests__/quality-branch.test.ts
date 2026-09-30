import { and, eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import BaseEmbedding from '@/lib/models/base/embedding';
import BaseLLM from '@/lib/models/base/llm';
import SessionManager from '@/lib/session';
import {
  betterSqliteMockFactory,
  closeTrackedDatabases,
} from '@/test/dbTracking';
import SearchAgent from '../index';
import type { SearchAgentInput } from '../types';

/**
 * The collaborators `searchAsync` orchestrates. Nothing here is a stub of the
 * code under test: the agent's own branch, the drizzle statements it issues and
 * `buildEffectiveQuery` are all real, so an assertion about what the researcher
 * received really does prove the agent passed it the woven query.
 */
const doubles = vi.hoisted(() => ({
  clarify: vi.fn(),
  classify: vi.fn(),
  Researcher: vi.fn<new () => unknown>(),
  research: vi.fn(),
  executeAll: vi.fn(),
  streamAnswer: vi.fn(),
}));

/**
 * `@/lib/db` opens `<DATA_DIR>/data/db.sqlite` at import time, which would touch
 * the developer's real database just by running this file (the convention
 * `src/lib/db/__tests__/migrate.test.ts` sets is to never do that). The
 * singleton is replaced with a throwaway in-memory handle, so the agent's real
 * insert/update SQL runs against a real sqlite without a filesystem.
 */
vi.mock('@/lib/db', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schema = await import('@/lib/db/schema');
  return { default: drizzle(new Database(':memory:'), { schema }) };
});

/**
 * This file runs the agent's real statements, and a `Statement` wrapper left as
 * garbage makes its native finalizer run against a dead environment and abort
 * the worker at shutdown. The helper keeps every wrapper reachable and closes
 * the handle it owns; see src/test/dbTracking.ts.
 */
vi.mock('better-sqlite3', () =>
  import('@/test/dbTracking').then((m) => m.betterSqliteMockFactory()),
);

/**
 * Only `clarify` is faked. `buildEffectiveQuery` stays real, because case 3
 * asserts on the string it produces.
 */
vi.mock('../clarifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../clarifier')>()),
  clarify: doubles.clarify,
}));

vi.mock('../classifier', () => ({ classify: doubles.classify }));

vi.mock('../researcher', () => ({ default: doubles.Researcher }));

vi.mock('../widgets', () => ({
  WidgetExecutor: { executeAll: doubles.executeAll },
}));

/** `formatModelError` stays real; only the streaming call is faked. */
vi.mock('../answerStream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../answerStream')>()),
  streamAnswer: doubles.streamAnswer,
}));

/**
 * Minimal `messages` table matching the columns `searchAsync` reads and writes.
 * The shipped `drizzle/0000` shape is older than the drizzle schema (it still
 * has `content`/`type`/`metadata`), so the hand written DDL is the contract the
 * agent actually runs against.
 */
const MESSAGES_DDL = `
  CREATE TABLE messages (
    id integer PRIMARY KEY NOT NULL,
    messageId text NOT NULL,
    chatId text NOT NULL,
    backendId text NOT NULL,
    query text NOT NULL,
    createdAt text NOT NULL,
    responseBlocks text DEFAULT '[]',
    status text DEFAULT 'answering'
  );
`;

const QUERY = 'tell me about the vane releases';
const CHAT_ID = 'chat-1';
const MESSAGE_ID = 'message-1';
const QUESTIONS = ['Which versions?', 'For what audience?'];

/** The agent only passes these handles through, so plain objects will do. */
const llm = {
  generateObject: vi.fn(),
  streamText: vi.fn(),
} as unknown as BaseLLM<any>;

const embedding = {
  embedText: vi.fn(),
  embedChunks: vi.fn(),
} as unknown as BaseEmbedding<any>;

type Mode = SearchAgentInput['config']['mode'];

describe('SearchAgent quality clarification branch', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    // The degraded-classifier fallback warns before degrading, which is
    // expected noise here.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.run(MESSAGES_DDL);
  });

  afterAll(() => {
    warnSpy.mockRestore();
    closeTrackedDatabases();
  });

  beforeEach(() => {
    // Every test starts from an empty table, and nothing in this file needs a
    // real timer (SessionManager's 30 minute session TTL would otherwise keep
    // the worker's event loop alive long after the assertions are done).
    vi.useFakeTimers();
    vi.clearAllMocks();
    db.run('DELETE FROM messages');

    doubles.clarify.mockResolvedValue([]);
    doubles.classify.mockResolvedValue({
      classification: {
        skipSearch: false,
        personalSearch: true,
        academicSearch: false,
        discussionSearch: false,
        showWeatherWidget: false,
        showStockWidget: false,
        showCalculationWidget: false,
      },
      standaloneFollowUp: 'the vane release notes',
    });
    // A class, because vitest only allows a constructor implementation: the
    // agent does `new Researcher()`, and the construction itself is asserted.
    doubles.Researcher.mockImplementation(
      class {
        research = doubles.research;
      },
    );
    doubles.research.mockResolvedValue({
      findings: [],
      searchFindings: [
        { content: 'A finding', metadata: { title: 'Notes', url: 'http://a' } },
      ],
    });
    doubles.executeAll.mockResolvedValue([]);
    doubles.streamAnswer.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Runs the real `searchAsync` against a real session, recording every event
   * it emits in order.
   */
  const searchAsync = async (input: {
    mode: Mode;
    clarification?: SearchAgentInput['clarification'];
  }) => {
    const session = new SessionManager();
    const events: { event: string; data: any }[] = [];
    session.subscribe((event, data) => {
      events.push({ event, data });
    });

    await new SearchAgent().searchAsync(session, {
      chatHistory: [],
      followUp: QUERY,
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
      config: {
        llm,
        embedding,
        sources: ['web'],
        mode: input.mode,
        fileIds: [],
        systemInstructions: '',
      },
      clarification: input.clarification,
    });

    return { session, events };
  };

  const messageRow = async () =>
    (await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, CHAT_ID),
        eq(messages.messageId, MESSAGE_ID),
      ),
    }))!;

  /** A second row in the same chat, to catch an over-broad update. */
  const insertSiblingRow = async (messageId: string) =>
    db.insert(messages).values({
      chatId: CHAT_ID,
      messageId,
      backendId: 'backend-1',
      query: 'an earlier question',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'answering',
      responseBlocks: [],
    });

  it('asks the questions and stops, in quality mode only', async () => {
    doubles.clarify.mockResolvedValue(QUESTIONS);
    await insertSiblingRow('sibling-message');

    const { session, events } = await searchAsync({ mode: 'quality' });

    // The clarifier sees the user's own words, not a rewritten query.
    expect(doubles.clarify).toHaveBeenCalledTimes(1);
    expect(doubles.clarify).toHaveBeenCalledWith({
      query: QUERY,
      chatHistory: [],
      llm,
    });

    // Nothing downstream of the branch ran.
    expect(doubles.classify).not.toHaveBeenCalled();
    expect(doubles.executeAll).not.toHaveBeenCalled();
    expect(doubles.Researcher).not.toHaveBeenCalled();
    expect(doubles.research).not.toHaveBeenCalled();
    expect(doubles.streamAnswer).not.toHaveBeenCalled();

    // The questions reached the client, and the turn ended cleanly.
    expect(session.getAllBlocks()).toEqual([
      {
        id: expect.any(String),
        type: 'questions',
        data: { questions: QUESTIONS },
      },
    ]);
    expect(events.map((e) => e.event)).toEqual(['data', 'end']);
    expect(events[0].data.type).toBe('block');
    expect(events[0].data.block.type).toBe('questions');

    const row = await messageRow();
    expect(row.status).toBe('completed');
    expect(row.responseBlocks).toEqual([
      {
        id: expect.any(String),
        type: 'questions',
        data: { questions: QUESTIONS },
      },
    ]);
    // The row still holds what the user actually typed.
    expect(row.query).toBe(QUERY);

    // The completion update is scoped to this message, like the one at the end
    // of the normal flow.
    const sibling = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, CHAT_ID),
        eq(messages.messageId, 'sibling-message'),
      ),
    });
    expect(sibling!.status).toBe('answering');
    expect(sibling!.responseBlocks).toEqual([]);
  });

  it('never asks clarifying questions outside quality mode', async () => {
    await searchAsync({ mode: 'balanced' });

    expect(doubles.clarify).not.toHaveBeenCalled();
    expect(doubles.Researcher).toHaveBeenCalledTimes(1);
    expect(doubles.research).toHaveBeenCalledTimes(1);
    expect(doubles.research.mock.calls[0][1].followUp).toBe(QUERY);
    expect((await messageRow()).status).toBe('completed');
  });

  it('weaves the answers into the query the rest of the turn sees', async () => {
    await searchAsync({
      mode: 'quality',
      clarification: {
        skipped: false,
        answers: [{ question: 'Which versions?', answer: 'v1 and v2' }],
      },
    });

    // A clarification on the request means the questions are already answered,
    // so the clarifier is not consulted again.
    expect(doubles.clarify).not.toHaveBeenCalled();
    expect(doubles.Researcher).toHaveBeenCalledTimes(1);

    const expected = `${QUERY}\n\n<user_clarifications>\nQ: Which versions?\nA: v1 and v2\n</user_clarifications>`;

    const [, researchInput] = doubles.research.mock.calls[0];
    expect(researchInput.followUp).toBe(expected);
    // The other three consumers of the query, so a future edit cannot quietly
    // drop the clarifications from one of them.
    expect(doubles.classify.mock.calls[0][0].query).toBe(expected);
    expect(doubles.executeAll.mock.calls[0][0].followUp).toBe(expected);
    const [answerInput] = doubles.streamAnswer.mock.calls[0];
    expect(answerInput.messages.at(-1)).toEqual({
      role: 'user',
      content: expected,
    });

    // The stored query is still the user's own text: clarifications are context
    // for the model, not a rewrite of the conversation.
    const row = await messageRow();
    expect(row.query).toBe(QUERY);
    expect(row.status).toBe('completed');
  });

  it('researches the original query when the clarifier came back empty', async () => {
    doubles.clarify.mockResolvedValue([]);

    const { session, events } = await searchAsync({ mode: 'quality' });

    expect(doubles.clarify).toHaveBeenCalledTimes(1);
    expect(doubles.Researcher).toHaveBeenCalledTimes(1);
    expect(doubles.research.mock.calls[0][1].followUp).toBe(QUERY);
    expect(session.getAllBlocks().map((b) => b.type)).not.toContain(
      'questions',
    );
    expect(events.at(-1)!.event).toBe('end');

    const row = await messageRow();
    expect(row.status).toBe('completed');
    expect(row.query).toBe(QUERY);
  });

  it('carries the woven query through the degraded classifier fallback', async () => {
    // A non-fatal classify failure degrades to defaults instead of rethrowing.
    // The researcher prompt renders the follow-up and the standalone
    // restatement side by side, so the fallback must not contradict the user
    // line by restating the bare question the clarifications were about.
    doubles.classify.mockRejectedValue(new Error('connection reset'));

    await searchAsync({
      mode: 'quality',
      clarification: {
        skipped: false,
        answers: [{ question: 'Which versions?', answer: 'v1 and v2' }],
      },
    });

    expect(doubles.clarify).not.toHaveBeenCalled();
    expect(doubles.Researcher).toHaveBeenCalledTimes(1);

    const expected = `${QUERY}\n\n<user_clarifications>\nQ: Which versions?\nA: v1 and v2\n</user_clarifications>`;
    const [, researchInput] = doubles.research.mock.calls[0];
    expect(researchInput.classification.degraded).toBe(true);
    expect(researchInput.classification.standaloneFollowUp).toBe(expected);
    expect(researchInput.followUp).toBe(expected);
  });

  it('does not ask again after the user skipped the questions', async () => {
    await searchAsync({
      mode: 'quality',
      clarification: { skipped: true, answers: [] },
    });

    // A user who already declined is never asked again, whatever the branch
    // condition ends up testing.
    expect(doubles.clarify).not.toHaveBeenCalled();
    expect(doubles.Researcher).toHaveBeenCalledTimes(1);

    // And research runs on exactly what they typed.
    expect(doubles.research.mock.calls[0][1].followUp).toBe(QUERY);
    expect(doubles.classify.mock.calls[0][0].query).toBe(QUERY);
  });
});
