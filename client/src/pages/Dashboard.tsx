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
  Sparkles,
  Search,
  Shield,
  History as HistoryIcon,
  Archive,
  ArchiveRestore,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth-store';
import { api, ApiError, type DeckSummary } from '../lib/api';
import { SlideIcon } from '../components/SlideIcon';
import { AiPanel, useAiAvailable } from '../components/AiPanel';
import { CommandMenu, CommandHint } from '../components/CommandMenu';
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
  const [aiOpen, setAiOpen] = useState(false);
  const aiAvailable = useAiAvailable();

  /*
   * Whether to show archived decks.
   *
   * Archiving existed end to end -- a route, a service, a filter, an API
   * method -- and nothing ever called it, so a deck could never be put
   * away and an archived one would have been invisible with no way back.
   */
  const [showArchived, setShowArchived] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { decks: list } = await api.listDecks({ includeArchived: true });
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

  /*
   * Split rather than filtered at the source: the list is fetched once
   * including archived, so toggling the section costs no request.
   */
  const active = decks?.filter((deck) => !deck.archived) ?? [];
  const archived = decks?.filter((deck) => deck.archived) ?? [];

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

  const setArchived = async (id: string, archived: boolean) => {
    try {
      await api.archiveDeck(id, archived);
      await refresh();
      toast.success(archived ? 'Deck archived' : 'Deck restored');
    } catch {
      toast.error(
        archived ? 'That deck could not be archived.' : 'That deck could not be restored.',
      );
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
          {/* Tells people the palette exists; hidden on touch devices,
              where there is no keyboard to press. */}
          <button
            type="button"
            className={styles.commandButton}
            onClick={() => {
              // Synthesised rather than lifting the dialog's state up: the
              // menu owns its own open state and listens for this.
              document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true }),
              );
            }}
            title="Search and commands"
          >
            <Search size={15} />
            <span className={styles.commandLabel}>Search</span>
            <CommandHint />
          </button>

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

                <DropdownMenu.Item
                  className={styles.menuItem}
                  onSelect={() => {
                    void navigate('/settings');
                  }}
                >
                  <Settings size={15} />
                  Account settings
                </DropdownMenu.Item>

                {user?.role === 'admin' && (
                  <DropdownMenu.Item
                    className={styles.menuItem}
                    onSelect={() => {
                      void navigate('/admin');
                    }}
                  >
                    <Shield size={15} />
                    Admin
                  </DropdownMenu.Item>
                )}

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

            <div className={styles.titleActions}>
              {/* Only shown when a provider is actually configured; a dead
                  AI button is worse than none. */}
              {aiAvailable && (
                <button
                  type="button"
                  className={styles.aiButton}
                  onClick={() => {
                    setAiOpen(true);
                  }}
                >
                  <Sparkles size={17} />
                  Build with AI
                </button>
              )}

              <button
                type="button"
                className={styles.aiButton}
                onClick={() => {
                  void navigate('/history');
                }}
                title="Past sessions and their results"
              >
                <HistoryIcon size={17} />
                Past sessions
              </button>

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
          </div>

          {decks === null ? (
            <div className={styles.grid} aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className={`skeleton ${styles.cardSkeleton}`} />
              ))}
            </div>
          ) : active.length === 0 && archived.length === 0 ? (
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
            <>
              <div className={styles.grid}>
                {active.map((deck) => (
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
                    onArchive={() => {
                      void setArchived(deck.id, true);
                    }}
                  />
                ))}
              </div>

              {/* Collapsed by default. Archived decks are the ones someone
                  decided to stop looking at, so they should not take up
                  the top of the screen -- but they must be reachable, or
                  archiving is indistinguishable from deleting. */}
              {archived.length > 0 && (
                <section className={styles.archived}>
                  <button
                    type="button"
                    className={styles.archivedToggle}
                    onClick={() => {
                      setShowArchived((current) => !current);
                    }}
                    aria-expanded={showArchived}
                  >
                    <ChevronDown
                      size={15}
                      className={styles.archivedChevron}
                      data-open={showArchived}
                    />
                    Archived
                    <span className={styles.archivedCount}>{archived.length}</span>
                  </button>

                  {showArchived && (
                    <div className={styles.grid}>
                      {archived.map((deck) => (
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
                          onRestore={() => {
                            void setArchived(deck.id, false);
                          }}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </motion.div>
      </main>

      {/* Reachable from anywhere on this page with Cmd+K. */}
      <CommandMenu
        onCreateDeck={() => {
          void createDeck();
        }}
        onOpenAi={
          aiAvailable
            ? () => {
                setAiOpen(true);
              }
            : undefined
        }
      />

      <AiPanel
        open={aiOpen}
        onOpenChange={setAiOpen}
        onDone={(id) => {
          void navigate(`/decks/${id}`);
        }}
      />
    </div>
  );
}

function DeckCard({
  deck,
  onOpen,
  onDuplicate,
  onDelete,
  onArchive,
  onRestore,
}: {
  deck: DeckSummary;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Given for a live deck. */
  onArchive?: () => void;
  /** Given for an archived one. Exactly one of the two is ever present. */
  onRestore?: () => void;
}) {
  return (
    <article className={styles.card} data-archived={deck.archived}>
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

            {onArchive && (
              <DropdownMenu.Item className={styles.menuItem} onSelect={onArchive}>
                <Archive size={14} />
                Archive
              </DropdownMenu.Item>
            )}

            {onRestore && (
              <DropdownMenu.Item className={styles.menuItem} onSelect={onRestore}>
                <ArchiveRestore size={14} />
                Restore
              </DropdownMenu.Item>
            )}
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
