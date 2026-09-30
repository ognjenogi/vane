import z from 'zod';
import BaseLLM from '@/lib/models/base/llm';
import { clarifierPrompt } from '@/lib/prompts/search/clarifier';
import { Clarification } from '@/lib/agents/search/types';
import { ChatTurnMessage } from '@/lib/types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';

const schema = z.object({
  questions: z
    .array(z.string())
    .describe(
      'Between 2 and 4 short clarifying questions, or an empty array when the query is already research-ready.',
    ),
});

export type ClarifierInput = {
  query: string;
  chatHistory: ChatTurnMessage[];
  llm: BaseLLM<any>;
};

/**
 * Asks the model for 2-4 clarifying questions to put to the user before
 * research starts.
 *
 * This is the inverse trade-off of `classify()`: classify() rethrows fatal
 * quota/auth errors so the caller can surface them, while clarify() swallows
 * every failure and returns `[]`, because a broken clarifier must never strand
 * the user on a question nobody can render an answer to. An empty array just
 * means "no questions", and research proceeds immediately.
 */
export const clarify = async (
  input: ClarifierInput,
  timeoutMs: number = 6000,
): Promise<string[]> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const output = await Promise.race([
      input.llm.generateObject<typeof schema>({
        messages: [
          {
            role: 'system',
            content: clarifierPrompt,
          },
          {
            role: 'user',
            content: `<conversation_history>\n${formatChatHistoryAsString(input.chatHistory)}\n</conversation_history>\n<user_query>\n${input.query}\n</user_query>`,
          },
        ],
        schema,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`Clarification timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);

    // Providers hand back the parsed JSON unvalidated when it fails the schema,
    // so `questions` can genuinely be missing or the wrong shape here.
    if (!Array.isArray(output?.questions)) {
      return [];
    }

    return output.questions;
  } catch (err: any) {
    console.warn(
      'Clarification failed, continuing without questions:',
      err instanceof Error ? err.message : err,
    );
    return [];
  } finally {
    // The race is over either way, so don't leave the timer holding the loop.
    clearTimeout(timeout);
  }
};

/**
 * Weaves the user's clarification answers into the query the rest of the
 * pipeline sees. Returns the query untouched when the user skipped or left
 * every answer blank, so the common case stays byte-identical.
 */
export const buildEffectiveQuery = (
  query: string,
  clarification: Clarification,
): string => {
  if (clarification.skipped) {
    return query;
  }

  const qaLines = (clarification.answers ?? []).flatMap((entry) => {
    const answer = (entry.answer ?? '').trim();
    return answer ? [`Q: ${entry.question}\nA: ${answer}`] : [];
  });

  if (qaLines.length === 0) {
    return query;
  }

  return `${query}\n\n<user_clarifications>\n${qaLines.join('\n\n')}\n</user_clarifications>`;
};
