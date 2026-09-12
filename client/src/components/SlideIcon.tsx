import {
  Cloud,
  MessageSquareText,
  ListChecks,
  Images,
  ToggleLeft,
  Trophy,
  SlidersHorizontal,
  ArrowUpDown,
  Coins,
  Grid2x2,
  MapPin,
  Hash,
  Star,
  Gauge,
  CircleCheck,
  Keyboard,
  Link2,
  ListOrdered,
  Medal,
  MessagesSquare,
  ClipboardList,
  Pencil,
  Globe,
  Heading1,
  Text,
  List,
  TrendingUp,
  Quote,
  Image,
  Video,
  QrCode,
  Minus,
  ExternalLink,
  Columns2,
  Square,
  type LucideProps,
} from 'lucide-react';

/**
 * Renders the Lucide icon named by a slide definition.
 *
 * The registry stores icons as strings so the shared package stays free of
 * React imports, and this map turns a name back into a component.
 *
 * Every icon is imported by name rather than through `import * as icons`.
 * The namespace form defeats tree-shaking: it pulled all 1552 icons into the
 * bundle and cost roughly 160KB gzipped for the 34 actually used. A test in
 * shared/ asserts every registry icon name has an entry here, so a new slide
 * kind cannot silently fall back to a blank square.
 */
const ICONS: Record<string, React.ComponentType<LucideProps>> = {
  Cloud,
  MessageSquareText,
  ListChecks,
  Images,
  ToggleLeft,
  Trophy,
  SlidersHorizontal,
  ArrowUpDown,
  Coins,
  Grid2x2,
  MapPin,
  Hash,
  Star,
  Gauge,
  CircleCheck,
  Keyboard,
  Link2,
  ListOrdered,
  Medal,
  MessagesSquare,
  ClipboardList,
  Pencil,
  Globe,
  Heading1,
  Text,
  List,
  TrendingUp,
  Quote,
  Image,
  Video,
  QrCode,
  Minus,
  ExternalLink,
  Columns2,
};

/** The names this component can render, for the coverage test. */
export const SLIDE_ICON_NAMES = Object.keys(ICONS);

export function SlideIcon({ name, ...props }: { name: string } & LucideProps) {
  const Icon = ICONS[name] ?? Square;
  return <Icon {...props} />;
}
