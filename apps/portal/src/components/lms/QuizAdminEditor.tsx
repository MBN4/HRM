'use client';

import { FormEvent, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { addQuizQuestion, upsertQuiz } from '../../lib/api/lms';
import { ApiError } from '../../lib/api/client';
import type { Quiz, QuizQuestion } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { Input, Label, Textarea } from '../ui/Field';
import { Alert } from '../ui/Alert';

/**
 * `options`/`correctOptionKey` are authored as a plain textarea, one
 * option per line (`key: text`), rather than a dynamic add/remove option
 * list — the same "functional over fancy" posture this codebase's other
 * config-as-data forms already take (e.g. Country Pack overrides are
 * edited as raw JSON, not a generated form). Parsed client-side before
 * hitting `createQuizQuestionSchema`'s real validation server-side.
 */
function parseOptions(raw: string): { key: string; text: string }[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(':');
      return { key: key.trim(), text: rest.join(':').trim() || key.trim() };
    });
}

export function QuizAdminEditor({ courseId, quiz, onChanged }: { courseId: string; quiz: (Quiz & { questions: QuizQuestion[] }) | null; onChanged: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(quiz?.title ?? '');
  const [passMarkPercent, setPassMarkPercent] = useState(String(quiz?.passMarkPercent ?? 70));
  const [isRequired, setIsRequired] = useState(quiz?.isRequired ?? true);
  const [savingQuiz, setSavingQuiz] = useState(false);
  const [quizError, setQuizError] = useState<string | null>(null);

  async function handleSaveQuiz(e: FormEvent) {
    e.preventDefault();
    setSavingQuiz(true);
    setQuizError(null);
    try {
      await upsertQuiz(courseId, { title, passMarkPercent: Number(passMarkPercent), isRequired });
      onChanged();
    } catch (err) {
      setQuizError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSavingQuiz(false);
    }
  }

  return (
    <div className="space-y-3">
      {!quiz && <p className="text-sm text-ink-400">{t('lms.admin.noQuiz')}</p>}
      <form onSubmit={handleSaveQuiz} className="flex flex-wrap items-end gap-2 rounded-lg bg-sand-50 p-3" data-testid="quiz-form">
        <div>
          <Label htmlFor={`quiz-title-${courseId}`}>{t('lms.quiz.title')}</Label>
          <Input id={`quiz-title-${courseId}`} value={title} onChange={(e) => setTitle(e.target.value)} required data-testid="quiz-title-input" />
        </div>
        <div>
          <Label htmlFor={`quiz-pass-${courseId}`}>{t('lms.admin.passMarkPercent')}</Label>
          <Input
            id={`quiz-pass-${courseId}`}
            type="number"
            min="1"
            max="100"
            value={passMarkPercent}
            onChange={(e) => setPassMarkPercent(e.target.value)}
            className="w-24"
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-ink-700">
          <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} data-testid="quiz-required-checkbox" />
          {t('lms.admin.quizRequired')}
        </label>
        {quizError && <Alert tone="error">{quizError}</Alert>}
        <Button type="submit" size="sm" loading={savingQuiz} data-testid="save-quiz-button">
          {t('action.save')}
        </Button>
      </form>

      {quiz && (
        <>
          <ul className="space-y-1.5">
            {quiz.questions.map((q, index) => (
              <li key={q.id} className="rounded-lg bg-sand-50 px-3 py-2 text-sm text-ink-700" data-testid="admin-quiz-question-row">
                {index + 1}. {q.questionText}
              </li>
            ))}
          </ul>
          <AddQuestionForm courseId={courseId} nextOrderIndex={quiz.questions.length} onAdded={onChanged} />
        </>
      )}
    </div>
  );
}

function AddQuestionForm({ courseId, nextOrderIndex, onAdded }: { courseId: string; nextOrderIndex: number; onAdded: () => void }) {
  const { t } = useI18n();
  const [questionText, setQuestionText] = useState('');
  const [optionsRaw, setOptionsRaw] = useState('a: Option A\nb: Option B');
  const [correctOptionKey, setCorrectOptionKey] = useState('a');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const options = parseOptions(optionsRaw);
      await addQuizQuestion(courseId, { orderIndex: nextOrderIndex, questionText, options, correctOptionKey });
      setQuestionText('');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-lg bg-sand-50 p-3" data-testid="add-question-form">
      <div>
        <Label htmlFor={`question-text-${courseId}-${nextOrderIndex}`}>{t('lms.admin.questionText')}</Label>
        <Input
          id={`question-text-${courseId}-${nextOrderIndex}`}
          value={questionText}
          onChange={(e) => setQuestionText(e.target.value)}
          required
          data-testid="question-text-input"
        />
      </div>
      <div>
        <Label htmlFor={`question-options-${courseId}-${nextOrderIndex}`}>{t('lms.admin.options')}</Label>
        <Textarea
          id={`question-options-${courseId}-${nextOrderIndex}`}
          rows={3}
          value={optionsRaw}
          onChange={(e) => setOptionsRaw(e.target.value)}
          data-testid="question-options-input"
        />
      </div>
      <div>
        <Label htmlFor={`question-correct-${courseId}-${nextOrderIndex}`}>{t('lms.admin.correctOption')}</Label>
        <Input
          id={`question-correct-${courseId}-${nextOrderIndex}`}
          value={correctOptionKey}
          onChange={(e) => setCorrectOptionKey(e.target.value)}
          required
          className="w-24"
          data-testid="question-correct-option-input"
        />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <Button type="submit" size="sm" loading={submitting} data-testid="add-question-button">
        {t('lms.admin.addQuestion')}
      </Button>
    </form>
  );
}
