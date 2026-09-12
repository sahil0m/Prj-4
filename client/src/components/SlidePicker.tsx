import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { motion } from 'motion/react';
import { Search, X } from 'lucide-react';
import {
  ALL_DEFINITIONS,
  SLIDE_FAMILIES,
  FAMILY_LABELS,
  type SlideKind,
  type SlideFamily,
} from '@pulse/shared';
import { SlideIcon } from './SlideIcon';
import styles from './SlidePicker.module.css';

/**
 * The "add a slide" dialog.
 *
 * Every card here is generated from the shared slide registry, so a new
 * slide kind appears in this menu the moment it is registered — there is no
 * second list to keep in step.
 */
export function SlidePicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (kind: SlideKind) => void;
}) {
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<SlideFamily | 'all'>('all');

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return ALL_DEFINITIONS.filter((definition) => {
      if (family !== 'all' && definition.family !== family) return false;
      if (!needle) return true;
      return (
        definition.label.toLowerCase().includes(needle) ||
        definition.blurb.toLowerCase().includes(needle)
      );
    });
  }, [query, family]);

  // Grouped so the list reads as sections rather than one long wall.
  const grouped = useMemo(() => {
    const map = new Map<SlideFamily, typeof results>();
    for (const definition of results) {
      const list = map.get(definition.family) ?? [];
      list.push(definition);
      map.set(definition.family, list);
    }
    return SLIDE_FAMILIES.map((f) => ({ family: f, items: map.get(f) ?? [] })).filter(
      (group) => group.items.length > 0,
    );
  }, [results]);

  const choose = (kind: SlideKind) => {
    onPick(kind);
    onOpenChange(false);
    setQuery('');
    setFamily('all');
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <header className={styles.header}>
            <div>
              <Dialog.Title className={styles.title}>Add a slide</Dialog.Title>
              <p className={styles.subtitle}>
                {ALL_DEFINITIONS.length} types. Pick what the room should do.
              </p>
            </div>
            <Dialog.Close className={styles.close} aria-label="Close">
              <X size={18} />
            </Dialog.Close>
          </header>

          <div className={styles.searchRow}>
            <Search size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              className={styles.search}
              placeholder="Search slide types"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              // The dialog steals focus on open; this is where it should land.
              autoFocus
            />
          </div>

          <div className={styles.families}>
            <FamilyChip
              active={family === 'all'}
              onClick={() => {
                setFamily('all');
              }}
            >
              All
            </FamilyChip>
            {SLIDE_FAMILIES.map((f) => (
              <FamilyChip
                key={f}
                active={family === f}
                onClick={() => {
                  setFamily(f);
                }}
              >
                {FAMILY_LABELS[f]}
              </FamilyChip>
            ))}
          </div>

          <div className={styles.scroll}>
            {grouped.length === 0 ? (
              <p className={styles.noResults}>Nothing matches “{query}”.</p>
            ) : (
              grouped.map((group) => (
                <section key={group.family} className={styles.group}>
                  <h3 className={styles.groupTitle}>{FAMILY_LABELS[group.family]}</h3>
                  <div className={styles.grid}>
                    {group.items.map((definition) => (
                      <button
                        key={definition.kind}
                        type="button"
                        className={styles.card}
                        onClick={() => {
                          choose(definition.kind);
                        }}
                      >
                        <span className={styles.cardIcon} aria-hidden="true">
                          <SlideIcon name={definition.icon} size={18} />
                        </span>
                        <span className={styles.cardText}>
                          <span className={styles.cardLabel}>{definition.label}</span>
                          <span className={styles.cardBlurb}>{definition.blurb}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FamilyChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={styles.chip} data-active={active} onClick={onClick}>
      {active && (
        <motion.span
          layoutId="family-chip"
          className={styles.chipPill}
          transition={{ duration: 0.2 }}
        />
      )}
      <span className={styles.chipLabel}>{children}</span>
    </button>
  );
}
