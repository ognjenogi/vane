import SessionManager from '@/lib/session';
import { Chunk, ResearchBlock, SourceBlock } from '@/lib/types';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { ClassifierOutput, SearchAgentInput } from './types';
import { executeSearch } from './researcher/actions/search/baseSearch';
import { streamAnswer } from './answerStream';

const FRESH_INFO_PATTERN =
  /\b(latest|newest|current|currently|today|tonight|tomorrow|yesterday|recent|recently|news|breaking|price|prices|cost|stock|shares?|weather|forecast|temperature|score|scores|standings|results?|who won|release date|released|schedule|opening hours|as of|right now|this (week|month|year)|20(2[6-9]|3\d))\b|https?:\/\//i;

export const needsFreshInfo = (query: string) => FRESH_INFO_PATTERN.test(query);

export const shouldSearch = (
  classification: ClassifierOutput,
  followUp: string,
) =>
  classification.degraded
    ? needsFreshInfo(followUp)
    : classification.classification.skipSearch === false;

const dedupeFindings = (chunks: Chunk[]): Chunk[] => {
  const seenUrls = new Map<string, number>();
  const results: Chunk[] = [];

  chunks.forEach((chunk) => {
    const url = chunk.metadata?.url;
    if (url && seenUrls.has(url)) {
      const existing = results[seenUrls.get(url)!];
      existing.content += `\n\n${chunk.content}`;
      return;
    }
    if (url) seenUrls.set(url, results.length);
    results.push(chunk);
  });

  return results;
};

export const runSuperfast = async (input: {
  session: SessionManager;
  agentInput: SearchAgentInput;
  classification: ClassifierOutput;
}): Promise<void> => {
  const { session, agentInput, classification } = input;

  let searchFindings: Chunk[] = [];

  if (shouldSearch(classification, agentInput.followUp)) {
    const query =
      classification.standaloneFollowUp?.trim() || agentInput.followUp;

    const researchBlock: ResearchBlock = {
      id: crypto.randomUUID(),
      type: 'research',
      data: {
        subSteps: [
          {
            id: crypto.randomUUID(),
            type: 'reasoning',
            reasoning: 'Searching the web...',
          },
        ],
      },
    };

    session.emitBlock(researchBlock);

    try {
      const chunks = await executeSearch({
        queries: [query],
        mode: agentInput.config.mode,
        researchBlock,
        session,
        llm: agentInput.config.llm,
        embedding: agentInput.config.embedding,
      });

      searchFindings = dedupeFindings(chunks);

      if (searchFindings.length > 0) {
        const sourceBlock: SourceBlock = {
          id: crypto.randomUUID(),
          type: 'source',
          data: searchFindings,
        };
        session.emitBlock(sourceBlock);
      }
    } catch (err) {
      console.warn('Superfast search failed, answering without sources:', err);
    }
  }

  session.emit('data', {
    type: 'researchComplete',
  });

  const hasSearchResults = searchFindings.length > 0;

  const context = hasSearchResults
    ? searchFindings
        .map(
          (f, index) =>
            `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
        )
        .join('\n')
    : '<Query to be answered without searching; Search not made>';

  const writerPrompt = getWriterPrompt(
    context,
    agentInput.config.systemInstructions,
    'superfast',
    hasSearchResults,
  );

  await streamAnswer({
    session,
    llm: agentInput.config.llm,
    messages: [
      {
        role: 'system',
        content: writerPrompt,
      },
      ...agentInput.chatHistory,
      {
        role: 'user',
        content: agentInput.followUp,
      },
    ],
  });
};