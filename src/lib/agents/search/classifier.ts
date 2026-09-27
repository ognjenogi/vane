import z from 'zod';
import { ClassifierInput } from './types';
import { classifierPrompt } from '@/lib/prompts/search/classifier';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';

const schema = z.object({
  classification: z.object({
    skipSearch: z
      .boolean()
      .describe('Indicates whether to skip the search step.'),
    personalSearch: z
      .boolean()
      .describe('Indicates whether to perform a personal search.'),
    academicSearch: z
      .boolean()
      .describe('Indicates whether to perform an academic search.'),
    discussionSearch: z
      .boolean()
      .describe('Indicates whether to perform a discussion search.'),
    showWeatherWidget: z
      .boolean()
      .describe('Indicates whether to show the weather widget.'),
    showStockWidget: z
      .boolean()
      .describe('Indicates whether to show the stock widget.'),
    showCalculationWidget: z
      .boolean()
      .describe('Indicates whether to show the calculation widget.'),
  }),
  standaloneFollowUp: z
    .string()
    .describe(
      "A self-contained, context-independent reformulation of the user's question.",
    ),
});

export const classify = async (
  input: ClassifierInput,
  timeoutMs: number = 4000,
) => {
  try {
    const output = await Promise.race([
      input.llm.generateObject<typeof schema>({
        messages: [
          {
            role: 'system',
            content: classifierPrompt,
          },
          {
            role: 'user',
            content: `<conversation_history>\n${formatChatHistoryAsString(input.chatHistory)}\n</conversation_history>\n<user_query>\n${input.query}\n</user_query>`,
          },
        ],
        schema,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`Classification timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);

    return output;
  } catch (err: any) {
    const isFatalQuotaOrAuth =
      err?.status === 401 ||
      err?.status === 402 ||
      err?.status === 429 ||
      /usage limit|rate limit|quota|credit|unauthorized|billing/i.test(
        err?.message || '',
      );
    if (isFatalQuotaOrAuth) {
      throw err;
    }
    console.warn('Classification failed, using defaults:', err instanceof Error ? err.message : err);
    return {
      classification: {
        skipSearch: false,
        personalSearch: false,
        academicSearch: false,
        discussionSearch: false,
        showWeatherWidget: false,
        showStockWidget: false,
        showCalculationWidget: false,
      },
      standaloneFollowUp: input.query,
      degraded: true,
    };
  }
};
