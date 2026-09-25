// Small element builders shared by the pages that are drawn from code.

import { icon, type IconName } from './icons';

export type TileTone = 'accent' | 'ink' | 'soft';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

export function tile(name: IconName, tone: TileTone = 'soft'): HTMLElement {
  const span = el('span', `tile tile--${tone}`);
  span.append(icon(name));
  return span;
}

export function actionButton(label: string, className: string, iconName?: IconName): HTMLButtonElement {
  const button = el('button', className);
  button.type = 'button';
  if (iconName) {
    button.append(icon(iconName));
    button.setAttribute('aria-label', label);
  }
  button.append(el('span', '', label));
  return button;
}

/** A stat card: label, big value and hint on the left, a tinted icon tile on the right. */
export function stat(label: string, value: string, hint: string, iconName: IconName, tone: TileTone): HTMLElement {
  const card = el('div', 'stat');
  const text = el('div', 'stat-text');
  text.append(el('p', 'stat-label', label), el('p', 'stat-value', value), el('p', 'stat-hint', hint));
  card.append(text, tile(iconName, tone));
  return card;
}
