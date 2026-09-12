import { useState } from 'react';
import { motion } from 'motion/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Radio, Plus, LogOut, Settings, ChevronDown, Sun, Moon } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth-store';
import styles from './Dashboard.module.css';

/**
 * The signed-in home. Currently the shell and the empty state; the deck grid
 * lands with the deck API.
 */
export function Dashboard() {
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
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

            <button type="button" className={styles.primaryButton}>
              <Plus size={17} />
              New deck
            </button>
          </div>

          <div className={`glass ${styles.empty}`}>
            <span className={styles.emptyMark} aria-hidden="true">
              <Radio size={26} />
            </span>
            <h2 className={styles.emptyTitle}>No decks yet</h2>
            <p className={styles.emptyBody}>
              A deck is a set of questions your audience answers on their phones. Create one to get
              started.
            </p>
            <button type="button" className={styles.primaryButton}>
              <Plus size={17} />
              Create your first deck
            </button>
          </div>
        </motion.div>
      </main>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
