import { GenerateTextInput, StreamTextOutput } from '@/lib/models/types';
import SessionManager from '@/lib/session';
import { Message, TextBlock } from '@/lib/types';

type AnswerModel = {
  streamText(input: GenerateTextInput): AsyncGenerator<StreamTextOutput>;
};

type AnswerModelWithProviderConfig = AnswerModel & {
  config?: { model?: string };
};

const GENERATION_STALL_TIMEOUT_MS = 90000;

export const streamAnswer = async (input: {
  session: SessionManager;
  llm: AnswerModel;
  messages: Message[];
}): Promise<void> => {
  try {
    const answerStream = input.llm.streamText({
      messages: input.messages,
    });

    const iterator = answerStream[Symbol.asyncIterator]();

    let block: TextBlock | null = null;

    const nextWithTimeout = () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        iterator.next(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), GENERATION_STALL_TIMEOUT_MS);
        }),
      ]).then((result) => {
        if (timer) clearTimeout(timer);
        return result;
      });
    };

    while (true) {
      const next = await nextWithTimeout();

      if (next === null) {
        await iterator.return(undefined);
        throw new Error(
          `the model produced no output for ${
            GENERATION_STALL_TIMEOUT_MS / 1000
          }s`,
        );
      }

      if (next.done) break;

      const text = next.value.contentChunk;
      if (!text) continue;

      if (block) {
        block.data += text;
        input.session.updateBlock(block.id, [
          {
            op: 'replace',
            path: '/data',
            value: block.data,
          },
        ]);
      } else {
        block = {
          id: crypto.randomUUID(),
          type: 'text',
          data: text,
        };
        input.session.emitBlock(block);
      }
    }
  } catch (streamErr) {
    console.error('Answer streaming failed:', streamErr);
    // BaseLLM exposes its provider config as protected; read the model name for the error text.
    const { config } = input.llm as AnswerModelWithProviderConfig;
    const modelName = config?.model || 'selected model';
    const errMsg =
      streamErr instanceof Error ? streamErr.message : String(streamErr);
    input.session.emitBlock({
      id: crypto.randomUUID(),
      type: 'text',
      data: `I encountered an issue generating the answer with model "${modelName}" (${errMsg}). Please select another model or try again.`,
    });
  }
};