import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import {
  Plus,
  Sparkles,
  History,
  Settings,
  Shield,
  LogOut,
  Search,
  Moon,
  Sun,
  FileText,
} from 'lucide-react';
import { api, type DeckSummary } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import styles from './CommandMenu.module.css';

/**
 * Everything, one keystroke away.
 *
 * Cmd+K is how people who use software all day expect to move around it.
 * The alternative is a menu they have to find, and a deck twelve rows down
 * that takes three clicks to open.
 *
 * Deck titles are searched alongside the actions, so "retro" reaches both
 * the deck called Retro and the command to build one.
 */

export function CommandMenu({
  onCreateDeck,
  onOpenAi,
}: {
  onCreateDeck?: () => void;
  onOpenAi?: () => void;
}) {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);

  const [open, setOpen] = useState(false);
  const [decks, setDecks] = useState<DeckSummary[]>([]);

  // Both shortcuts, because a mixed office has both kinds of keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Loaded when the menu opens rather than on mount: a palette nobody
  // presses should not cost a request on every page load.
  useEffect(() => {
    if (!open) return;

    void api
      .listDecks()
      .then((result) => {
        setDecks(result.decks.slice(0, 8));
      })
      .catch(() => {
        setDecks([]);
      });
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    // After the dialog closes, so a navigation does not fight its own
    // closing animation.
    setTimeout(action, 0);
  };

  const toggleTheme = () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command menu"
      className={styles.dialog}
      overlayClassName={styles.overlay}
      contentClassName={styles.content}
    >
      <div className={styles.inputRow}>
        <Search size={17} className={styles.searchIcon} aria-hidden="true" />
        <Command.Input placeholder="Search decks, or type a command" className={styles.input} />
        <kbd className={styles.esc}>esc</kbd>
      </div>

      <Command.List className={styles.list}>
        <Command.Empty className={styles.empty}>Nothing matches that.</Command.Empty>

        {decks.length > 0 && (
          <Command.Group heading="Your decks" className={styles.group}>
            {decks.map((deck) => (
              <Command.Item
                key={deck.id}
                value={`deck ${deck.title}`}
                className={styles.item}
                onSelect={() => {
                  run(() => {
                    void navigate(`/decks/${deck.id}`);
                  });
                }}
              >
                <FileText size={16} />
                <span className={styles.itemText}>
                  {deck.title}
                  <span className={styles.itemHint}>
                    {deck.slideCount} {deck.slideCount === 1 ? 'slide' : 'slides'}
                  </span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Create" className={styles.group}>
          {onCreateDeck && (
            <Command.Item
              value="new deck create blank"
              className={styles.item}
              onSelect={() => {
                run(onCreateDeck);
              }}
            >
              <Plus size={16} />
              <span className={styles.itemText}>New deck</span>
            </Command.Item>
          )}

          {onOpenAi && (
            <Command.Item
              value="build with ai generate document"
              className={styles.item}
              onSelect={() => {
                run(onOpenAi);
              }}
            >
              <Sparkles size={16} />
              <span className={styles.itemText}>
                Build with AI
                <span className={styles.itemHint}>From a topic or a document</span>
              </span>
            </Command.Item>
          )}
        </Command.Group>

        <Command.Group heading="Go to" className={styles.group}>
          <Command.Item
            value="past sessions history results export download"
            className={styles.item}
            onSelect={() => {
              run(() => {
                void navigate('/history');
              });
            }}
          >
            <History size={16} />
            <span className={styles.itemText}>
              Past sessions
              <span className={styles.itemHint}>Results and downloads</span>
            </span>
          </Command.Item>

          <Command.Item
            value="account settings password devices"
            className={styles.item}
            onSelect={() => {
              run(() => {
                void navigate('/settings');
              });
            }}
          >
            <Settings size={16} />
            <span className={styles.itemText}>Account settings</span>
          </Command.Item>

          {user?.role === 'admin' && (
            <Command.Item
              value="admin users moderation"
              className={styles.item}
              onSelect={() => {
                run(() => {
                  void navigate('/admin');
                });
              }}
            >
              <Shield size={16} />
              <span className={styles.itemText}>Admin</span>
            </Command.Item>
          )}
        </Command.Group>

        <Command.Group heading="Other" className={styles.group}>
          <Command.Item
            value="theme dark light appearance"
            className={styles.item}
            onSelect={() => {
              run(toggleTheme);
            }}
          >
            {document.documentElement.dataset.theme === 'light' ? (
              <Moon size={16} />
            ) : (
              <Sun size={16} />
            )}
            <span className={styles.itemText}>Switch theme</span>
          </Command.Item>

          <Command.Item
            value="sign out log out"
            className={`${styles.item} ${styles.itemDanger}`}
            onSelect={() => {
              run(() => {
                void signOut();
              });
            }}
          >
            <LogOut size={16} />
            <span className={styles.itemText}>Sign out</span>
          </Command.Item>
        </Command.Group>
      </Command.List>

      <footer className={styles.footer}>
        <span>
          <kbd className={styles.key}>↑</kbd>
          <kbd className={styles.key}>↓</kbd>
          to move
        </span>
        <span>
          <kbd className={styles.key}>↵</kbd>
          to open
        </span>
      </footer>
    </Command.Dialog>
  );
}

/** The hint that tells people the palette exists at all. */
export function CommandHint() {
  const mac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent);

  return (
    <span className={styles.hint}>
      <kbd className={styles.key}>{mac ? '⌘' : 'Ctrl'}</kbd>
      <kbd className={styles.key}>K</kbd>
    </span>
  );
}

/** Present, from anywhere in the editor. */
export function usePresentShortcut(onPresent: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const onKey = (event: KeyboardEvent) => {
      // Cmd+Enter rather than a bare key: the editor is full of text fields,
      // and a single letter would fire while someone types a question.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onPresent();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onPresent, enabled]);
}
