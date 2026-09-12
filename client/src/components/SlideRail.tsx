import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { definitionFor } from '@pulse/shared';
import type { Slide } from '../lib/api';
import { SlideIcon } from './SlideIcon';
import styles from './SlideRail.module.css';

/**
 * The list of slides, reorderable by dragging.
 *
 * Arrow buttons worked but made moving a slide five places a five-click
 * job. Dragging is what an author expects, and dnd-kit gives it to keyboard
 * and screen-reader users too — space to lift, arrows to move, space to
 * drop — which a hand-rolled mouse-only drag never would.
 */
export function SlideRail({
  slides,
  selectedId,
  onSelect,
  onReorder,
}: {
  slides: Slide[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReorder: (slideId: string, toIndex: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A few pixels of travel before a drag starts, so a click to select
      // is never mistaken for the beginning of one.
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const toIndex = slides.findIndex((slide) => slide.id === over.id);
    if (toIndex !== -1) onReorder(String(active.id), toIndex);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // Constrained to the rail: a slide dragged onto the canvas or out of
      // the window has nowhere meaningful to land.
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={slides.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <ol className={styles.list}>
          {slides.map((slide, index) => (
            <SortableSlide
              key={slide.id}
              slide={slide}
              index={index}
              selected={slide.id === selectedId}
              onSelect={() => {
                onSelect(slide.id);
              }}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function SortableSlide({
  slide,
  index,
  selected,
  onSelect,
}: {
  slide: Slide;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id,
  });

  const definition = definitionFor(slide.kind);
  const prompt = (slide.config as { prompt?: string }).prompt;

  return (
    <li
      ref={setNodeRef}
      className={styles.item}
      data-dragging={isDragging}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      {/* A handle rather than the whole row: dragging from anywhere would
          make selecting a slide feel like it might move it. */}
      <button
        type="button"
        className={styles.handle}
        aria-label={`Reorder ${definition.label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>

      <button type="button" className={styles.body} data-selected={selected} onClick={onSelect}>
        <span className={styles.number}>{index + 1}</span>

        <span className={styles.icon} aria-hidden="true">
          <SlideIcon name={definition.icon} size={14} />
        </span>

        <span className={styles.text}>
          <span className={styles.prompt}>
            {prompt !== undefined && prompt.trim() !== '' ? prompt : definition.label}
          </span>
          <span className={styles.kind}>{definition.label}</span>
        </span>
      </button>
    </li>
  );
}
