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

export const formatModelError = (
  err: unknown,
  modelName: string = 'selected model',
): string => {
  const errMsg = err instanceof Error ? err.message : String(err || '');
  const status =
    (err as any)?.status ||
    (err as any)?.statusCode ||
    (err as any)?.error?.code ||
    (err as any)?.code;

  if (
    status === 402 ||
    status === 'insufficient_quota' ||
    /credit|quota|billing|balance|payment|exceeded.*quota|insufficient/i.test(
      errMsg,
    )
  ) {
    return `💳 **API Credits Empty**: Your account for model "${modelName}" has run out of credits or reached its billing limit. Please check your credit balance or choose another model.`;
  }

  if (
    status === 408 ||
    status === 504 ||
    /timeout|timed out|abort|deadline|produced no output/i.test(errMsg) ||
    (err as any)?.name === 'APIConnectionTimeoutError'
  ) {
    return `⏱️ **Request Timed Out**: Model "${modelName}" took too long to respond. The provider may be experiencing high latency or downtime. Please try again or choose another model.`;
  }

  if (
    status === 401 ||
    status === 403 ||
    /unauthorized|invalid api key|incorrect api key|authentication|access denied/i.test(
      errMsg,
    )
  ) {
    return `🔑 **Authentication Failed**: The API key for model "${modelName}" is invalid or unauthorized. Please verify your API key in Settings.`;
  }

  if (
    status === 429 ||
    /rate limit|too many requests|tokens per minute|tpm|rpm/i.test(errMsg)
  ) {
    return `⏳ **Rate Limit Exceeded**: Model "${modelName}" is temporarily rate-limited. Please wait a moment or choose another model.`;
  }

  return `⚠️ **Generation Error**: Model "${modelName}" encountered an issue (${errMsg}). Please select another model or try again.`;
};

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
      if (input.session.isAborted?.()) {
        await iterator.return?.(undefined);
        break;
      }

      const next = await nextWithTimeout();

      if (input.session.isAborted?.()) {
        await iterator.return?.(undefined);
        break;
      }

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
    if (input.session.isAborted?.()) {
      return;
    }
    console.error('Answer streaming failed:', streamErr);
    // BaseLLM exposes its provider config as protected; read the model name for the error text.
    const { config } = input.llm as AnswerModelWithProviderConfig;
    const modelName = config?.model || 'selected model';
    input.session.emitBlock({
      id: crypto.randomUUID(),
      type: 'text',
      data: formatModelError(streamErr, modelName),
    });
  }
};