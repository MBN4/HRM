'use client';

import { useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { submitQuizAttempt } from '../../lib/api/lms';
import { ApiError } from '../../lib/api/client';
import type { Quiz, QuizAttempt, QuizQuestion } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Alert';

export function QuizTaker({
  quiz,
  enrollmentId,
  onSubmitted,
}: {
  quiz: Quiz & { questions: QuizQuestion[] };
  enrollmentId: string;
  onSubmitted: (attempt: QuizAttempt) => void;
}) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuizAttempt | null>(null);

  const allAnswered = quiz.questions.every((q) => answers[q.id]);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const attempt = await submitQuizAttempt(enrollmentId, answers);
      setResult(attempt);
      onSubmitted(attempt);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="quiz-taker">
      <p className="text-xs text-ink-400">{t('lms.quiz.passMark', { passMark: quiz.passMarkPercent })}</p>
      {quiz.questions.map((question, index) => (
        <fieldset key={question.id} className="rounded-lg border border-ink-100 p-3">
          <legend className="px-1 text-sm font-medium text-ink-800">
            {index + 1}. {question.questionText}
          </legend>
          <div className="mt-2 space-y-1.5">
            {question.options.map((option) => (
              <label key={option.key} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="radio"
                  name={`question-${question.id}`}
                  value={option.key}
                  checked={answers[question.id] === option.key}
                  onChange={() => setAnswers((prev) => ({ ...prev, [question.id]: option.key }))}
                  data-testid="quiz-option-input"
                />
                {option.text}
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      {error && <Alert tone="error">{error}</Alert>}
      {result && (
        <Alert tone={result.passed ? 'success' : 'error'}>
          <span data-testid="quiz-result-alert">
            {t('lms.quiz.score', { score: result.scorePercent })} — {result.passed ? t('lms.quiz.passed') : t('lms.quiz.failed')}
          </span>
        </Alert>
      )}

      <Button onClick={handleSubmit} loading={submitting} disabled={!allAnswered} data-testid="submit-quiz-button">
        {t('lms.quiz.submit')}
      </Button>
    </div>
  );
}
