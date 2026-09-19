import BaseEmbedding from '@/lib/models/base/embedding';
import BaseLLM from '@/lib/models/base/llm';
import { searchSearxng, SearxngSearchOptions } from '@/lib/searxng';
import SessionManager from '@/lib/session';
import { Chunk, ResearchBlock, SearchResultsResearchBlock } from '@/lib/types';
import { SearchAgentConfig } from '../../../types';
import computeSimilarity from '@/lib/utils/computeSimilarity';
import z from 'zod';
import Scraper from '@/lib/scraper';
import { splitText } from '@/lib/utils/splitText';

export const executeSearch = async (input: {
  queries: string[];
  mode: SearchAgentConfig['mode'];
  searchConfig?: SearxngSearchOptions;
  researchBlock: ResearchBlock;
  session: InstanceType<typeof SessionManager>;
  llm: BaseLLM<any>;
  embedding: BaseEmbedding<any>;
}) => {
  const researchBlock = input.researchBlock;

  researchBlock.data.subSteps.push({
    id: crypto.randomUUID(),
    type: 'searching',
    searching: input.queries,
  });

  input.session.updateBlock(researchBlock.id, [
    {
      op: 'replace',
      path: '/data/subSteps',
      value: researchBlock.data.subSteps,
    },
  ]);

  if (
    input.mode === 'speed' ||
    input.mode === 'balanced' ||
    input.mode === 'superfast'
  ) {
    const searchResultsBlockId = crypto.randomUUID();
    let searchResultsEmitted = false;

    const results: Chunk[] = [];

    const search = async (q: string) => {
      const res = await searchSearxng(q, {
        ...(input.searchConfig ? input.searchConfig : {}),
      });

      let resultChunks: Chunk[] = [];

      try {
        const queryEmbedding = (await input.embedding.embedText([q]))[0];

        const allChunks = await Promise.all(
          res.results.map(async (r) => {
            const content = r.content || r.title;
            const chunkEmbedding = (
              await input.embedding.embedText([content])
            )[0];

            return {
              content,
              metadata: {
                title: r.title,
                url: r.url,
                similarity: computeSimilarity(queryEmbedding, chunkEmbedding),
                embedding: chunkEmbedding,
              },
            };
          }),
        );

        // Lower threshold from 0.5 to 0.3, with fallback to top 5 by score
        resultChunks = allChunks.filter((c) => c.metadata.similarity > 0.3);
        if (resultChunks.length === 0 && allChunks.length > 0) {
          resultChunks = allChunks
            .sort((a, b) => b.metadata.similarity - a.metadata.similarity)
            .slice(0, 5);
        }
      } catch (err) {
        resultChunks = res.results.map((r) => {
          const content = r.content || r.title;

          return {
            content,
            metadata: {
              title: r.title,
              url: r.url,
              similarity: 1,
              embedding: [],
            },
          };
        });
      } finally {
        results.push(...resultChunks);
      }

      if (!searchResultsEmitted) {
        searchResultsEmitted = true;

        researchBlock.data.subSteps.push({
          id: searchResultsBlockId,
          type: 'search_results',
          reading: resultChunks,
        });

        input.session.updateBlock(researchBlock.id, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      } else if (searchResultsEmitted) {
        const subStepIndex = researchBlock.data.subSteps.findIndex(
          (step) => step.id === searchResultsBlockId,
        );

        const subStep = researchBlock.data.subSteps[
          subStepIndex
        ] as SearchResultsResearchBlock;

        subStep.reading.push(...resultChunks);

        input.session.updateBlock(researchBlock.id, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      }
    };

    await Promise.all(input.queries.map(search));

    results.sort((a, b) => b.metadata.similarity - a.metadata.similarity);

    const uniqueSearchResultIndices: Set<number> = new Set();

    for (let i = 0; i < results.length; i++) {
      let isDuplicate = false;

      for (const indice of uniqueSearchResultIndices.keys()) {
        if (
          results[i].metadata.embedding.length === 0 ||
          results[indice].metadata.embedding.length === 0
        )
          continue;

        const similarity = computeSimilarity(
          results[i].metadata.embedding,
          results[indice].metadata.embedding,
        );

        if (similarity > 0.75) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        uniqueSearchResultIndices.add(i);
      }
    }

    const uniqueSearchResults = Array.from(uniqueSearchResultIndices.keys())
      .map((i) => {
        const uniqueResult = results[i];

        delete uniqueResult.metadata.embedding;
        delete uniqueResult.metadata.similarity;

        return uniqueResult;
      })
      .slice(0, 20);

    return uniqueSearchResults;
  } else if (input.mode === 'quality') {
    const searchResultsBlockId = crypto.randomUUID();
    let searchResultsEmitted = false;

    const searchResults: Chunk[] = [];

    const search = async (q: string) => {
      const res = await searchSearxng(q, {
        ...(input.searchConfig ? input.searchConfig : {}),
      });

      let resultChunks: Chunk[] = [];

      resultChunks = res.results.map((r) => {
        const content = r.content || r.title;

        return {
          content,
          metadata: {
            title: r.title,
            url: r.url,
            similarity: 1,
            embedding: [],
          },
        };
      });

      searchResults.push(...resultChunks);

      if (!searchResultsEmitted) {
        searchResultsEmitted = true;

        researchBlock.data.subSteps.push({
          id: searchResultsBlockId,
          type: 'search_results',
          reading: resultChunks,
        });

        input.session.updateBlock(researchBlock.id, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      } else if (searchResultsEmitted) {
        const subStepIndex = researchBlock.data.subSteps.findIndex(
          (step) => step.id === searchResultsBlockId,
        );

        const subStep = researchBlock.data.subSteps[
          subStepIndex
        ] as SearchResultsResearchBlock;

        subStep.reading.push(...resultChunks);

        input.session.updateBlock(researchBlock.id, [
          {
            op: 'replace',
            path: '/data/subSteps',
            value: researchBlock.data.subSteps,
          },
        ]);
      }
    };

    await Promise.all(input.queries.map(search));

    // Pick top 2-3 distinct domain results directly (instant, 0ms LLM overhead)
    const seenDomains = new Set<string>();
    const pickedResults: Chunk[] = [];
    for (const res of searchResults) {
      try {
        const domain = new URL(res.metadata.url).hostname.replace('www.', '');
        if (!seenDomains.has(domain)) {
          seenDomains.add(domain);
          pickedResults.push(res);
          if (pickedResults.length >= 3) break;
        }
      } catch {
        if (pickedResults.length < 3) pickedResults.push(res);
      }
    }

    const alreadyExtractedURLs: string[] = [];

    researchBlock.data.subSteps.forEach((step) => {
      if (step.type === 'reading') {
        step.reading.forEach((chunk) => {
          alreadyExtractedURLs.push(chunk.metadata.url);
        });
      }
    });

    const filteredResults = pickedResults.filter(
      (r) => !alreadyExtractedURLs.find((url) => url === r.metadata.url),
    );

    if (filteredResults.length > 0) {
      researchBlock.data.subSteps.push({
        id: crypto.randomUUID(),
        type: 'reading',
        reading: filteredResults,
      });

      input.session.updateBlock(researchBlock.id, [
        {
          path: '/data/subSteps',
          op: 'replace',
          value: researchBlock.data.subSteps,
        },
      ]);
    }

    const extractedFacts: Chunk[] = [];

    await Promise.all(
      filteredResults.map(async (result) => {
        try {
          const scrapedData = await Scraper.scrape(result.metadata.url).catch(
            (err) => {
              console.log('Error scraping data from', result.metadata.url, err);
            },
          );

          if (!scrapedData || !scrapedData.content) return;

          const cleanContent = scrapedData.content
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 3500);

          if (cleanContent) {
            extractedFacts.push({
              ...result,
              content: cleanContent,
            });
          }
        } catch (err) {
          console.log(
            'Error scraping data from',
            result.metadata.url,
            err,
          );
        }
      }),
    );

    if (extractedFacts.length === 0 && searchResults.length > 0) {
      return searchResults.slice(0, 8);
    }

    return extractedFacts;
  } else {
    return [];
  }
};
