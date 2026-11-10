// Locks a tab to its screen: the TV display, the customer screen or the self-service kiosk. A
// locked tab returns to that screen after a reload or a typed address, and only a team member's
// email and password unlock it. The lock lives in this tab's sessionStorage, so the staff app in
// another tab of the same browser stays free. Run the kiosk browser full screen (Chrome --kiosk)
// so visitors cannot close the tab or open a new one.

import { formDialog } from '../../dialogs';
import { icon } from '../../icons';
import type { Ops } from '../ops';
import { el } from './kit';

const KEY = 'vto:display-lock';
let watching = false;

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(hash: string | null): void {
  try {
    if (hash) sessionStorage.setItem(KEY, hash);
    else sessionStorage.removeItem(KEY);
  } catch {
    // No sessionStorage: the screen works, unlocked.
  }
}

/**
 * Runs before the app picks a screen. A link with `lock=1` locks the tab to it; a locked tab that
 * lands anywhere else goes back to its screen, now and on every later address change.
 */
export function enforceDisplayLock(): void {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (params.get('lock') === '1') {
    params.delete('lock');
    write(`#${params}`);
  }
  const locked = read();
  if (!locked) return;
  if (location.hash !== locked) history.replaceState(null, '', `${location.pathname}${locked}`);
  if (watching) return;
  watching = true;
  const restore = () => {
    const hash = read();
    if (hash && location.hash !== hash) location.replace(`${location.pathname}${hash}`);
  };
  window.addEventListener('hashchange', restore);
  window.addEventListener('popstate', restore);
}

/** The lock button in the corner of a display, and the sign-in that unlocks it. */
export function mountLockControl(ops: Ops, host: HTMLElement): void {
  const bar = el('div', 'display-lock');
  host.append(bar);

  const draw = () => {
    bar.replaceChildren();
    if (read()) {
      const button = el('button', 'display-lock-button');
      button.type = 'button';
      button.setAttribute('aria-label', 'Layar terkunci. Buka kunci untuk petugas.');
      button.append(icon('lock'));
      button.addEventListener('click', unlock);
      bar.append(button);
      return;
    }
    const lock = el('button', 'btn btn-outline btn-sm', 'Kunci layar');
    lock.type = 'button';
    lock.prepend(icon('lock'));
    lock.addEventListener('click', () => {
      write(location.hash);
      enforceDisplayLock();
      draw();
    });
    const leave = el('a', 'btn btn-ghost btn-sm', 'Buka aplikasi staf');
    leave.href = location.pathname;
    bar.append(lock, leave);
  };

  function unlock(): void {
    formDialog({
      title: 'Buka kunci layar',
      description: 'Khusus petugas. Masuk dengan email dan password akun tim Anda.',
      submitLabel: 'Buka kunci',
      fields: [
        { name: 'email', label: 'Email', value: '', type: 'email' },
        { name: 'password', label: 'Password', value: '', type: 'password' },
      ],
      async submit(values) {
        if (!ops.accounts) throw new Error('Akun tidak tersedia di layar ini.');
        const member = await ops.accounts.confirmMember(ops.account.id, String(values.email), String(values.password));
        const person = ops.state.staff.find((entry) => entry.id === member.userId);
        if (person ? !person.active : !member.userId.startsWith('owner-')) throw new Error(`${member.name} tidak aktif di tim ini.`);
        write(null);
        draw();
      },
    });
  }

  draw();
}
