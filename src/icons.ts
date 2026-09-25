// Lucide icons (stroke 2), the one icon set the house style allows.

import {
  Aperture,
  ArrowDownRight,
  ArrowUpRight,
  Camera,
  Check,
  ChevronRight,
  CircleCheck,
  Clock,
  Copy,
  Download,
  Ellipsis,
  Hand,
  Images,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  MapPin,
  MonitorSmartphone,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Rows3,
  Search,
  Share,
  Shirt,
  Sparkles,
  Table,
  Square,
  Trash2,
  TriangleAlert,
  Upload,
  X,
  createElement,
  type IconNode,
} from 'lucide';

const ICONS = {
  aperture: Aperture,
  down: ArrowDownRight,
  up: ArrowUpRight,
  camera: Camera,
  check: Check,
  chevron: ChevronRight,
  ok: CircleCheck,
  clock: Clock,
  copy: Copy,
  download: Download,
  more: Ellipsis,
  hand: Hand,
  images: Images,
  dashboard: LayoutDashboard,
  grid: LayoutGrid,
  logout: LogOut,
  pin: MapPin,
  point: MonitorSmartphone,
  collapse: PanelLeftClose,
  expand: PanelLeftOpen,
  edit: Pencil,
  plus: Plus,
  strip: Rows3,
  search: Search,
  share: Share,
  shirt: Shirt,
  sparkles: Sparkles,
  table: Table,
  single: Square,
  trash: Trash2,
  alert: TriangleAlert,
  upload: Upload,
  close: X,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGElement {
  const svg = createElement(ICONS[name], { 'stroke-width': 2, 'aria-hidden': 'true' });
  svg.classList.add('icon');
  return svg;
}

/** Replaces every `<i data-icon="name">` placeholder in the markup with its SVG, keeping its classes. */
export function hydrateIcons(root: ParentNode): void {
  for (const slot of root.querySelectorAll<HTMLElement>('i[data-icon]')) {
    const svg = icon(slot.dataset.icon as IconName);
    svg.classList.add(...slot.classList);
    slot.replaceWith(svg);
  }
}

/** A round ghost button holding one icon, labelled for screen readers and on hover. */
export function iconButton(name: IconName, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-ghost btn-icon';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  return button;
}
