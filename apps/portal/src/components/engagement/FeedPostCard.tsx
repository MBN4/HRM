'use client';

import { FormEvent, useState } from 'react';
import { Cake, Megaphone, MessageCircle, PartyPopper, Pin, ThumbsUp, Trash2, UserPlus, Award } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { useAsync } from '../../lib/useAsync';
import { ApiError } from '../../lib/api/client';
import { addFeedComment, listFeedComments, reactToPost, removeFeedComment, removeFeedPost, unreactToPost } from '../../lib/api/engagement';
import { formatDateTime } from '../../lib/format';
import type { CelebrationKind, FeedPost, ReactionType } from '../../lib/api/types';
import { Alert } from '../ui/Alert';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody } from '../ui/Card';
import { Input } from '../ui/Field';
import { Avatar } from './Avatar';
import { ModerationDialog } from './ModerationDialog';
import { RecognitionCard } from './RecognitionCard';

const CELEBRATION_ICON: Record<CelebrationKind, typeof Cake> = { BIRTHDAY: Cake, WORK_ANNIVERSARY: Award, NEW_JOINER: UserPlus };

function PostBody({ post, onOpenPerson }: { post: FeedPost; onOpenPerson: (id: string) => void }) {
  const { t } = useI18n();
  if (post.type === 'RECOGNITION' && post.recognition) {
    return <RecognitionCard recognition={post.recognition} onOpenPerson={onOpenPerson} showDate={false} />;
  }
  if (post.type === 'CELEBRATION' && post.celebration) {
    const c = post.celebration;
    const Icon = CELEBRATION_ICON[c.kind] ?? PartyPopper;
    const name = c.subject?.name ?? '—';
    // Celebration posts carry no prose — the text is localized here from kind/subject/meta (and never shows a birth year).
    return (
      <p className="flex items-center gap-2 text-sm text-ink-900" data-testid="celebration-text">
        <Icon className="h-5 w-5 text-accent-500" aria-hidden />
        {t(`feed.celebration.${c.kind}`, { name, years: c.meta?.years ?? '' })}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {post.title && <h3 className="text-sm font-semibold text-ink-900">{post.title}</h3>}
      <p className="whitespace-pre-line text-sm text-ink-800">{post.body}</p>
    </div>
  );
}

export function FeedPostCard({
  post,
  canInteract,
  canModerate,
  onRemoved,
  onOpenPerson,
}: {
  post: FeedPost;
  canInteract: boolean;
  canModerate: boolean;
  onRemoved: (postId: string) => void;
  onOpenPerson: (employeeId: string) => void;
}) {
  const { t, locale } = useI18n();
  const [reactions, setReactions] = useState(post.reactions);
  const [commentCount, setCommentCount] = useState(post.commentCount);
  const [showComments, setShowComments] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removingComment, setRemovingComment] = useState<string | null>(null);
  const [reactError, setReactError] = useState<string | null>(null);

  async function toggle(type: ReactionType) {
    setReactError(null);
    try {
      setReactions(reactions.mine === type ? await unreactToPost(post.id) : await reactToPost(post.id, type));
    } catch (err) {
      setReactError(err instanceof ApiError ? err.message : t('error.generic'));
    }
  }

  const typeLabel = t(`feed.type.${post.type}`);
  const TypeIcon = post.type === 'RECOGNITION' ? Award : post.type === 'CELEBRATION' ? PartyPopper : Megaphone;
  const authorName = post.author?.name ?? post.recognition?.giver.name ?? null;

  return (
    <Card data-testid="feed-post" data-post-type={post.type} data-post-id={post.id}>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
          {authorName && <Avatar name={authorName} size="sm" />}
          <span className="inline-flex items-center gap-1 font-medium text-ink-700">
            <TypeIcon className="h-3.5 w-3.5" aria-hidden />
            {typeLabel}
          </span>
          {post.type === 'ANNOUNCEMENT' && post.author && <span>· {post.author.name}</span>}
          {post.pinned && (
            <Badge tone="warning">
              <Pin className="me-1 h-3 w-3" aria-hidden />
              {t('feed.pinned')}
            </Badge>
          )}
          {post.scopeType !== 'ORG' && <Badge tone="info">{t('feed.scopedPost')}</Badge>}
          <span className="ms-auto">{formatDateTime(post.createdAt, locale)}</span>
          {canModerate && (
            <Button size="sm" variant="ghost" onClick={() => setRemoving(true)} data-testid="remove-post-button" aria-label={t('feed.moderation.removePost')}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {t('common.remove')}
            </Button>
          )}
        </div>

        <PostBody post={post} onOpenPerson={onOpenPerson} />

        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
          {(['LIKE', 'CELEBRATE'] as const).map((type) => {
            const Icon = type === 'LIKE' ? ThumbsUp : PartyPopper;
            const active = reactions.mine === type;
            return (
              <button
                key={type}
                type="button"
                disabled={!canInteract}
                aria-pressed={active}
                onClick={() => toggle(type)}
                data-testid={`react-${type}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-default ${
                  active ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-ink-200 bg-surface text-ink-600 enabled:hover:bg-sand-100'
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {t(`feed.react.${type}`)}
                <span data-testid={`count-${type}`}>{reactions[type]}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setShowComments((v) => !v)}
            aria-expanded={showComments}
            data-testid="toggle-comments"
            className="ms-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold text-ink-600 hover:bg-sand-100"
          >
            <MessageCircle className="h-3.5 w-3.5" aria-hidden />
            {t('feed.comments.count', { count: commentCount })}
          </button>
        </div>
        {reactError && <Alert tone="error">{reactError}</Alert>}

        {showComments && (
          <Comments
            postId={post.id}
            canInteract={canInteract}
            canModerate={canModerate}
            onAdded={() => setCommentCount((c) => c + 1)}
            onRemoved={() => setCommentCount((c) => Math.max(0, c - 1))}
            onRequestRemove={setRemovingComment}
            removingId={removingComment}
            onRemoveDone={() => setRemovingComment(null)}
          />
        )}
      </CardBody>

      {removing && (
        <ModerationDialog
          title={t('feed.moderation.removePost')}
          body={post.type === 'RECOGNITION' ? t('feed.moderation.removeRecognitionBody') : t('feed.moderation.removePostBody')}
          onClose={() => setRemoving(false)}
          onConfirm={async (reason) => {
            await removeFeedPost(post.id, reason);
            setRemoving(false);
            onRemoved(post.id);
          }}
        />
      )}
    </Card>
  );
}

function Comments({
  postId,
  canInteract,
  canModerate,
  onAdded,
  onRemoved,
  onRequestRemove,
  removingId,
  onRemoveDone,
}: {
  postId: string;
  canInteract: boolean;
  canModerate: boolean;
  onAdded: () => void;
  onRemoved: () => void;
  onRequestRemove: (id: string | null) => void;
  removingId: string | null;
  onRemoveDone: () => void;
}) {
  const { t, locale } = useI18n();
  const { data: comments, loading, error, reload } = useAsync(() => listFeedComments(postId), [postId]);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    setPostError(null);
    try {
      await addFeedComment(postId, body.trim());
      setBody('');
      onAdded();
      reload();
    } catch (err) {
      setPostError(err instanceof ApiError ? err.message : t('error.generic'));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl bg-sand-50 p-3" data-testid="comments-panel">
      {loading && !comments ? (
        <p className="text-xs text-ink-400">{t('common.loading')}</p>
      ) : error ? (
        <Alert tone="error">{error}</Alert>
      ) : comments && comments.length === 0 ? (
        <p className="text-xs text-ink-400">{t('feed.comments.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {(comments ?? []).map((c) => (
            <li key={c.id} data-testid="feed-comment" className="flex items-start gap-2 text-sm">
              <Avatar name={c.author.name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-ink-500">
                  <span className="font-medium text-ink-800">{c.author.name}</span> · {formatDateTime(c.createdAt, locale)}
                </p>
                <p className="whitespace-pre-line text-ink-800">{c.body}</p>
              </div>
              {canModerate && (
                <button type="button" onClick={() => onRequestRemove(c.id)} aria-label={t('feed.moderation.removeComment')} className="rounded-md p-1 text-ink-400 hover:bg-ink-100 hover:text-coral-600" data-testid="remove-comment-button">
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canInteract && (
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input aria-label={t('feed.comments.add')} placeholder={t('feed.comments.add')} value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} data-testid="comment-input" />
          <Button type="submit" size="sm" loading={posting} disabled={!body.trim()} data-testid="comment-submit">
            {t('feed.comments.post')}
          </Button>
        </form>
      )}
      {postError && <Alert tone="error">{postError}</Alert>}
      {removingId && (
        <ModerationDialog
          title={t('feed.moderation.removeComment')}
          body={t('feed.moderation.removeCommentBody')}
          withReason={false}
          onClose={onRemoveDone}
          onConfirm={async () => {
            await removeFeedComment(removingId);
            onRemoveDone();
            onRemoved();
            reload();
          }}
        />
      )}
    </div>
  );
}
