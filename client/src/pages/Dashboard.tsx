import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Radio,
  Plus,
  LogOut,
  Settings,
  ChevronDown,
  Sun,
  Moon,
  Copy,
  Trash2,
  MoreVertical,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth-store';
import { api, ApiError, type DeckSummary } from '../lib/api';
import { SlideIcon } from '../components/SlideIcon';
import { definitionFor } from '@pulse/shared';
import styles from './Dashboard.module.css';

/** The signed-in home: your decks, and the way into a new one. */
export function Dashboard() {
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const navigate = useNavigate();

  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { decks: list } = await api.listDecks();
      setDecks(list);
      setListError(null);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : 'Your decks could not be loaded.');
      setDecks([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createDeck = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { deck } = await api.createDeck({ title: 'Untitled deck' });
      await navigate(`/decks/${deck.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That deck could not be created.');
      setCreating(false);
    }
  };

  const duplicateDeck = async (id: string) => {
    try {
      await api.duplicateDeck(id);
      await refresh();
      toast.success('Deck duplicated');
    } catch {
      toast.error('That deck could not be duplicated.');
    }
  };

  const deleteDeck = async (id: string, title: string) => {
    // Optimistic, because waiting for a round trip to remove a card the user
    // just deleted feels broken. Restored from the server if it fails.
    setDecks((current) => current?.filter((d) => d.id !== id) ?? null);
    try {
      await api.deleteDeck(id);
      toast.success(`"${title}" deleted`);
    } catch {
      toast.error('That deck could not be deleted.');
      await refresh();
    }
  };
  // Google's avatar CDN sometimes refuses a request, and a broken <img>
  // renders as an empty box with an icon. Fall back to the initials badge
  // that already exists for users with no picture at all.
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.dataset.theme as 'dark' | 'light' | undefined) ?? 'dark',
  );

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };

  const initials = (user?.name ?? '?')
    .split(' ')
    .map((part) => part[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <Radio size={17} />
          </span>
          <span className={styles.brandName}>Pulse</span>
        </div>

        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className={styles.accountButton}>
                {user?.avatarUrl && !avatarFailed ? (
                  <img
                    src={user.avatarUrl}
                    alt=""
                    className={styles.avatar}
                    // Google returns 403 for requests carrying a full referrer.
                    referrerPolicy="no-referrer"
                    onError={() => {
                      setAvatarFailed(true);
                    }}
                  />
                ) : (
                  <span className={styles.avatarFallback} aria-hidden="true">
                    {initials}
                  </span>
                )}
                <span className={styles.accountName}>{user?.name}</span>
                <ChevronDown size={15} className={styles.chevron} />
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content className={styles.menu} sideOffset={8} align="end">
                <div className={styles.menuHeader}>
                  <p className={styles.menuName}>{user?.name}</p>
                  <p className={styles.menuEmail}>{user?.email}</p>
                </div>

                <DropdownMenu.Separator className={styles.menuSeparator} />

                <DropdownMenu.Item className={styles.menuItem}>
                  <Settings size={15} />
                  Account settings
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  className={`${styles.menuItem} ${styles.menuItemDanger}`}
                  onSelect={() => {
                    void (async () => {
                      await signOut();
                      toast.success('Signed out');
                    })();
                  }}
                >
                  <LogOut size={15} />
                  Sign out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      <main className={styles.main}>
        <motion.div
          className={styles.content}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0, 0, 0.2, 1] }}
        >
          <div className={styles.titleRow}>
            <div>
              <h1 className={styles.title}>
                {greeting()}, {user?.name.split(' ')[0]}
              </h1>
              <p className={styles.subtitle}>Build a deck, then present it to a room.</p>
            </div>

            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                void createDeck();
              }}
              disabled={creating}
            >
              {creating ? <Loader2 size={17} className={styles.spin} /> : <Plus size={17} />}
              New deck
            </button>
          </div>

          {decks === null ? (
            <div className={styles.grid} aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className={`skeleton ${styles.cardSkeleton}`} />
              ))}
            </div>
          ) : decks.length === 0 ? (
            <div className={`glass ${styles.empty}`}>
              <span className={styles.emptyMark} aria-hidden="true">
                <Radio size={26} />
              </span>
              <h2 className={styles.emptyTitle}>
                {listError ? 'Your decks could not be loaded' : 'No decks yet'}
              </h2>
              <p className={styles.emptyBody}>
                {listError ??
                  'A deck is a set of questions your audience answers on their phones. Create one to get started.'}
              </p>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => {
                  if (listError) void refresh();
                  else void createDeck();
                }}
                disabled={creating}
              >
                {listError ? (
                  'Try again'
                ) : (
                  <>
                    <Plus size={17} />
                    Create your first deck
                  </>
                )}
              </button>
            </div>
          ) : (
            <div className={styles.grid}>
              {decks.map((deck) => (
                <DeckCard
                  key={deck.id}
                  deck={deck}
                  onOpen={() => {
                    void navigate(`/decks/${deck.id}`);
                  }}
                  onDuplicate={() => {
                    void duplicateDeck(deck.id);
                  }}
                  onDelete={() => {
                    void deleteDeck(deck.id, deck.title);
                  }}
                />
              ))}
            </div>
          )}
        </motion.div>
      </main>
    </div>
  );
}

function DeckCard({
  deck,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  deck: DeckSummary;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <article className={styles.card}>
      {/* The whole card opens the deck; the menu sits above it so its own
          clicks do not fall through to this button. */}
      <button type="button" className={styles.cardOpen} onClick={onOpen}>
        <span className={styles.cardPreview} aria-hidden="true">
          {deck.preview.length === 0 ? (
            <span className={styles.cardEmptyMark}>
              <Radio size={18} />
            </span>
          ) : (
            deck.preview.map((kind, i) => (
              <span key={`${kind}-${String(i)}`} className={styles.cardChip}>
                <SlideIcon name={definitionFor(kind).icon} size={13} />
              </span>
            ))
          )}
        </span>

        <span className={styles.cardTitle}>{deck.title}</span>
        <span className={styles.cardMeta}>
          {deck.slideCount} {deck.slideCount === 1 ? 'slide' : 'slides'} · edited{' '}
          {relativeTime(deck.updatedAt)}
        </span>
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={styles.cardMenuButton}
            aria-label={`Actions for ${deck.title}`}
          >
            <MoreVertical size={15} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={styles.menu} sideOffset={6} align="end">
            <DropdownMenu.Item className={styles.menuItem} onSelect={onDuplicate}>
              <Copy size={14} />
              Duplicate
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={`${styles.menuItem} ${styles.menuItemDanger}`}
              onSelect={onDelete}
            >
              <Trash2 size={14} />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </article>
  );
}

/** "2 hours ago" — close enough for a card, with no date library. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${String(days)} ${days === 1 ? 'day' : 'days'} ago`;

  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
