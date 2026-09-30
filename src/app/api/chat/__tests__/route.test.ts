import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';

const doubles = vi.hoisted(() => ({
  searchAsync: vi.fn(),
  loadChatModel: vi.fn(),
  loadEmbeddingModel: vi.fn(),
  findChat: vi.fn(),
  findProject: vi.fn(),
  insertValues: vi.fn(),
  insert: vi.fn(),
}));

/**
 * The registry only hands back model handles, and the agent is the unit under
 * test elsewhere, so neither provider config nor a live search ever loads here.
 */
vi.mock('@/lib/models/registry', () => ({
  default: class ModelRegistry {
    loadChatModel = doubles.loadChatModel;
    loadEmbeddingModel = doubles.loadEmbeddingModel;
  },
}));

vi.mock('@/lib/agents/search', () => ({
  default: class SearchAgent {
    searchAsync = doubles.searchAsync;
  },
}));

/**
 * `@/lib/db` opens `<DATA_DIR>/data/db.sqlite` at import time, so the singleton
 * is replaced by the few queries the route actually makes: it looks a chat up for
 * its project, looks that project up, and inserts the chat when it is missing.
 */
vi.mock('@/lib/db', () => ({
  default: {
    query: {
      chats: { findFirst: doubles.findChat },
      projects: { findFirst: doubles.findProject },
    },
    insert: doubles.insert,
  },
}));

const validBody = (overrides: Record<string, unknown> = {}) => ({
  message: {
    messageId: 'message-1',
    chatId: 'chat-1',
    content: 'tell me about vane',
  },
  optimizationMode: 'quality',
  sources: ['web'],
  history: [],
  files: [],
  chatModel: { providerId: 'openai', key: 'gpt-4o' },
  embeddingModel: { providerId: 'openai', key: 'text-embedding-3-small' },
  ...overrides,
});

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

/**
 * A drizzle relational query is awaited in one place and `.execute()`d in
 * another, so the double is both.
 */
const findRow = (row: unknown) =>
  Object.assign(Promise.resolve(row), {
    execute: vi.fn().mockResolvedValue(row),
  });

describe('POST /api/chat', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The response body is an endless SSE stream and the route keeps a
    // heartbeat interval alive until the session ends, so this file never reads
    // the body and never needs a real timer.
    vi.useFakeTimers();
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    doubles.loadChatModel.mockResolvedValue({ fake: 'llm' });
    doubles.loadEmbeddingModel.mockResolvedValue({ fake: 'embedding' });
    doubles.searchAsync.mockResolvedValue(undefined);
    doubles.findChat.mockImplementation(() => findRow(undefined));
    doubles.findProject.mockImplementation(() => findRow(undefined));
    doubles.insertValues.mockResolvedValue(undefined);
    doubles.insert.mockReturnValue({ values: doubles.insertValues });
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it('accepts a body without a clarification', async () => {
    const response = await post(validBody());

    expect(response.status).toBe(200);
    expect(doubles.searchAsync).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed clarification', async () => {
    const response = await post(
      validBody({ clarification: { skipped: 'yes' } }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toBe('Invalid request body');
    expect(body.error).toEqual([
      expect.objectContaining({ path: 'clarification.skipped' }),
    ]);
    // A rejected body never reaches the agent.
    expect(doubles.searchAsync).not.toHaveBeenCalled();
  });

  it('passes the clarification through to the agent', async () => {
    const clarification = {
      skipped: false,
      answers: [{ question: 'Which versions?', answer: 'v1 and v2' }],
    };

    const response = await post(validBody({ clarification }));

    expect(response.status).toBe(200);
    const [, agentInput] = doubles.searchAsync.mock.calls[0];
    expect(agentInput.clarification).toEqual(clarification);
    // The query itself is untouched: only the clarification carries the answers.
    expect(agentInput.followUp).toBe('tell me about vane');
  });
});
