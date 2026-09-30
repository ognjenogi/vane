'use client';

import { useId, useState } from 'react';
import { MessageCircleQuestion, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  Clarification,
  ClarificationAnswer,
} from '@/lib/agents/search/types';

/**
 * The answers the user actually gave, in order, with blank ones dropped.
 * Shared so the payload and the rendered message can never disagree about
 * what counts as answered.
 */
const answered = (entries: ClarificationAnswer[]): ClarificationAnswer[] =>
  entries.flatMap((entry) => {
    const answer = (entry.answer ?? '').trim();
    return answer ? [{ question: entry.question, answer }] : [];
  });

/**
 * The text of the user's turn once the questions are answered.
 *
 * `sendMessage` renders whatever it is handed as the user's message, so the
 * answers have to be part of the content and not just the `clarification`
 * payload: otherwise the transcript repeats the original query and hides what
 * the user actually typed. The `Q:`/`A:` lines are the convention
 * `buildEffectiveQuery` already uses server-side, and they still read when the
 * newlines collapse, because the user message is rendered as plain text.
 *
 * Blank answers and a skipped clarification leave the query untouched.
 */
export const buildClarifiedMessage = (
  query: string,
  clarification: Clarification,
): string => {
  if (clarification.skipped) {
    return query;
  }

  const qa = answered(clarification.answers ?? []).map(
    ({ question, answer }) => `Q: ${question}\nA: ${answer}`,
  );

  return qa.length === 0 ? query : `${query}\n\n${qa.join('\n\n')}`;
};

/**
 * The clarifying questions the search agent asks before research starts, plus
 * the two ways out: answer them, or skip and let the research run on the
 * original query.
 *
 * Deliberately props-driven with no context imports, so it renders (and is
 * tested) without a ChatProvider.
 */
const ClarificationPanel = ({
  questions,
  interactive,
  loading,
  onSubmit,
}: {
  questions: string[];
  interactive: boolean;
  loading: boolean;
  onSubmit: (payload: Clarification) => void;
}) => {
  const [answers, setAnswers] = useState<string[]>(() =>
    questions.map(() => ''),
  );
  const uid = useId();

  // A later turn means the questions are already behind us, and a stream in
  // flight means another send is about to start: both are read-only.
  const disabled = !interactive || loading;

  const submitAnswers = () => {
    // Blank answers are dropped rather than sent as empty strings, so the
    // server sees exactly the questions the user actually answered.
    onSubmit({
      skipped: false,
      answers: answered(
        questions.map((question, index) => ({
          question,
          answer: answers[index] ?? '',
        })),
      ),
    });
  };

  return (
    <div className="rounded-lg bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 p-3">
      <div className="flex flex-row items-center space-x-2">
        <MessageCircleQuestion
          className="text-black dark:text-white"
          size={18}
        />
        <h3 className="text-sm font-medium text-black dark:text-white">
          A couple of questions before I research
        </h3>
      </div>

      <div className="mt-3 space-y-3">
        {questions.map((question, index) => {
          const id = `${uid}-question-${index}`;

          return (
            <div key={id} className="flex flex-col space-y-1">
              <label
                htmlFor={id}
                className="text-sm text-black/70 dark:text-white/70"
              >
                {question}
              </label>
              <input
                id={id}
                type="text"
                value={answers[index] ?? ''}
                disabled={disabled}
                placeholder="Optional"
                onChange={(e) =>
                  setAnswers((previous) => {
                    const next = [...previous];
                    next[index] = e.target.value;
                    return next;
                  })
                }
                className={cn(
                  'w-full rounded-lg border px-3 py-2 text-sm text-black dark:text-white focus:outline-none transition duration-200',
                  'border-light-200 dark:border-dark-200 bg-light-primary dark:bg-dark-primary disabled:opacity-50',
                )}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-row items-center space-x-2">
        <button
          type="button"
          onClick={submitAnswers}
          disabled={disabled}
          className="flex flex-row items-center space-x-1.5 rounded-full bg-sky-400 px-3 py-1.5 text-sm text-white transition duration-200 hover:bg-sky-500 disabled:opacity-50 disabled:hover:bg-sky-400"
        >
          <Search size={14} />
          <span>Answer &amp; research</span>
        </button>
        <button
          type="button"
          onClick={() => onSubmit({ skipped: true })}
          disabled={disabled}
          className="flex flex-row items-center rounded-full px-3 py-1.5 text-sm text-black/70 dark:text-white/70 hover:bg-light-200 dark:hover:bg-dark-200 transition duration-200 disabled:opacity-50"
        >
          <span>Skip</span>
        </button>
      </div>
    </div>
  );
};

export default ClarificationPanel;
