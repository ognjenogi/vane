import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import { buildEffectiveQuery, clarify } from './clarifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { streamAnswer, formatModelError } from './answerStream';
import { runSuperfast } from './superfast';
import { getTokenCount } from '@/lib/utils/splitText';

class SearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.followUp,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }

    try {
      // In quality mode the turn starts by checking with the user: ask 2-4
      // clarifying questions and stop here, so research can run against what
      // they actually wanted. A clarification on the input means the questions
      // have already been answered, and an empty result (the model saw no
      // ambiguity, or the clarifier failed) falls straight through, because a
      // broken clarifier must never strand the user.
      if (input.config.mode === 'quality' && !input.clarification) {
        const questions = await clarify({
          query: input.followUp,
          chatHistory: input.chatHistory,
          llm: input.config.llm,
        });

        if (questions.length > 0) {
          session.emitBlock({
            id: crypto.randomUUID(),
            type: 'questions',
            data: { questions },
          });
          session.emit('end', {});

          await db
            .update(messages)
            .set({
              status: 'completed',
              responseBlocks: session.getAllBlocks(),
            })
            .where(
              and(
                eq(messages.chatId, input.chatId),
                eq(messages.messageId, input.messageId),
              ),
            )
            .execute();
          return;
        }
      }

      // What the rest of the pipeline sees. The stored query above stays the
      // user's own text: the clarifications are context for the model, not a
      // rewrite of what was typed.
      const effectiveQuery = input.clarification
        ? buildEffectiveQuery(input.followUp, input.clarification)
        : input.followUp;

      let classification;
      try {
        classification = await classify(
          {
            chatHistory: input.chatHistory,
            enabledSources: input.config.sources,
            query: effectiveQuery,
            llm: input.config.llm,
          },
          input.config.mode === 'superfast' ? 2500 : 4000,
        );
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
        console.warn('Classification failed, using defaults:', err);
        classification = {
          classification: {
            skipSearch: false,
            personalSearch: false,
            academicSearch: false,
            discussionSearch: false,
            showWeatherWidget: false,
            showStockWidget: false,
            showCalculationWidget: false,
          },
          standaloneFollowUp: input.followUp,
          degraded: true,
        };
      }

      if (input.config.mode === 'superfast') {
        await runSuperfast({
          session,
          agentInput: input,
          classification,
        });
      } else {
        const widgetPromise = WidgetExecutor.executeAll({
          classification,
          chatHistory: input.chatHistory,
          followUp: effectiveQuery,
          llm: input.config.llm,
        })
          .then((widgetOutputs) => {
            widgetOutputs.forEach((o) => {
              session.emitBlock({
                id: crypto.randomUUID(),
                type: 'widget',
                data: {
                  widgetType: o.type,
                  params: o.data,
                },
              });
            });
            return widgetOutputs;
          })
          .catch((err) => {
            console.error('Widget execution failed:', err);
            return [];
          });

        let searchPromise: Promise<ResearcherOutput | null> =
          Promise.resolve(null);

        if (!classification.classification.skipSearch) {
          const researcher = new Researcher();
          searchPromise = researcher
            .research(session, {
              chatHistory: input.chatHistory,
              followUp: effectiveQuery,
              classification: classification,
              config: input.config,
            })
            .catch((err) => {
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
              console.error('Researcher failed:', err);
              return null;
            });
        }

        const [widgetOutputs, searchResults] = await Promise.all([
          widgetPromise,
          searchPromise,
        ]);

        if (session.isAborted?.()) {
          session.emit('end', {});
          await db
            .update(messages)
            .set({
              status: 'completed',
              responseBlocks: session.getAllBlocks(),
            })
            .where(
              and(
                eq(messages.chatId, input.chatId),
                eq(messages.messageId, input.messageId),
              ),
            )
            .execute();
          return;
        }

        session.emit('data', {
          type: 'researchComplete',
        });

        const didSkipSearch = classification.classification.skipSearch;

        let finalContext =
          '<Query to be answered without searching; Search not made>';

        if (searchResults) {
          finalContext = searchResults.searchFindings
            .map(
              (f, index) =>
                `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
            )
            .join('\n');
        }

        const hasSearchResults =
          !!searchResults && searchResults.searchFindings.length > 0;

        const widgetContext = widgetOutputs
          .map((o) => {
            return `<result>${o.llmContext}</result>`;
          })
          .join('\n-------------\n');

        const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

        const writerPrompt = getWriterPrompt(
          finalContextWithWidgets,
          input.config.systemInstructions,
          input.config.mode,
          hasSearchResults,
        );

        await streamAnswer({
          session,
          llm: input.config.llm,
          messages: [
            {
              role: 'system',
              content: writerPrompt,
            },
            ...input.chatHistory,
            {
              role: 'user',
              content: effectiveQuery,
            },
          ],
        });
      }

      session.emit('end', {});

      await db
        .update(messages)
        .set({
          status: 'completed',
          responseBlocks: session.getAllBlocks(),
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    } catch (globalErr) {
      console.error('Unhandled error in searchAsync:', globalErr);
      session.emit('data', {
        type: 'researchComplete',
      });
      const modelName =
        (input.config.llm as any)?.config?.model || 'selected model';
      session.emitBlock({
        id: crypto.randomUUID(),
        type: 'text',
        data: formatModelError(globalErr, modelName),
      });
      session.emit('end', {});

      await db
        .update(messages)
        .set({
          status: 'error',
          responseBlocks: session.getAllBlocks(),
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }
  }
}

export default SearchAgent;
