// The quick access page (one tap into a saved workspace, or a new trial) and the account sheet
// behind the avatar pill.

import type { AccountBackend } from './account/backend';
import { TRIAL_DAYS, TRIAL_LIMITS, initials, trialDaysLeft, trialExpired, type Account } from './account/model';
import { clearErrors, openDialog, showError } from './dialogs';
import { el } from './dom';
import { icon } from './icons';

const longDate = (time: number) => new Date(time).toLocaleDateString(undefined, { dateStyle: 'long' });
const daysLeftText = (days: number) => `${days} ${days === 1 ? 'day' : 'days'} left`;

/** Resolves with the signed-in account, showing the quick access page first when nobody is signed in. */
export async function signedIn(backend: AccountBackend): Promise<Account> {
  const existing = await backend.current();
  if (existing && !trialExpired(existing, Date.now())) return existing;

  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
  const screen = $<HTMLElement>('#authScreen');
  const access = $<HTMLElement>('#authAccess');
  const expired = $<HTMLElement>('#authExpired');
  const list = $<HTMLElement>('#workspaceList');
  const form = $<HTMLFormElement>('#quickForm');
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  screen.hidden = false;

  function showExpired(account: Account): void {
    access.hidden = true;
    expired.hidden = false;
    $('#authExpiredDesc').textContent =
      `The trial for ${account.business} ended on ${longDate(account.trialEndsAt)}. ` +
      'Your locations and points are kept for when the plan continues.';
  }

  return new Promise((resolve) => {
    async function run(button: HTMLButtonElement, action: () => Promise<Account>): Promise<void> {
      clearErrors(access);
      button.disabled = true;
      try {
        const account = await action();
        if (trialExpired(account, Date.now())) {
          showExpired(account);
          return;
        }
        screen.hidden = true;
        resolve(account);
      } catch (error) {
        showError(access, error);
      } finally {
        button.disabled = false;
      }
    }

    function workspaceRow(account: Account): HTMLButtonElement {
      const row = el('button', 'pick-row');
      row.type = 'button';
      const days = trialDaysLeft(account, Date.now());
      const text = el('span', 'pick-text');
      text.append(el('span', 'pick-name', account.business), el('span', 'card-desc', days ? daysLeftText(days) : 'Trial ended'));
      row.append(el('span', 'avatar', initials(account.business)), text, icon('chevron'));
      row.addEventListener('click', () => void run(row, () => backend.signIn(account.id)));
      return row;
    }

    async function showAccess(): Promise<void> {
      expired.hidden = true;
      access.hidden = false;
      const saved = await backend.workspaces();
      list.replaceChildren(el('p', 'kicker', 'On this device'), ...saved.map(workspaceRow));
      list.hidden = saved.length === 0;
      $('#authDesc').textContent = saved.length
        ? 'Tap a workspace to pick up where you left off, or start a new one.'
        : `One tap opens a ${TRIAL_DAYS}-day trial. No email or password.`;
      submit.textContent = saved.length ? 'Start a new trial' : 'Enter the app';
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const business = String(new FormData(form).get('business'));
      void run(submit, () => backend.startTrial(business));
    });

    $('#authSwitch').addEventListener('click', async () => {
      await backend.signOut();
      await showAccess();
    });

    if (existing) showExpired(existing);
    else void showAccess();
  });
}

/** The avatar pill in the header: days left, and a sheet with the workspace and Switch workspace. */
export function mountAccountButton(backend: AccountBackend, account: Account): void {
  const button = document.querySelector<HTMLButtonElement>('#accountButton')!;
  const daysLeft = trialDaysLeft(account, Date.now());
  const daysText = daysLeftText(daysLeft);
  document.querySelector('#accountInitials')!.textContent = initials(account.business);
  const trial = document.querySelector<HTMLElement>('#accountTrial')!;
  trial.textContent = `Trial · ${daysText}`;
  trial.dataset.urgent = String(daysLeft <= 3);

  button.addEventListener('click', () => {
    const who = document.createElement('div');
    who.className = 'account-who';
    who.innerHTML = `
      <span class="avatar avatar--lg"></span>
      <div><p class="device-name"></p><p class="card-desc"></p></div>`;
    who.querySelector('.avatar')!.textContent = initials(account.business);
    who.querySelector('.device-name')!.textContent = account.business;
    who.querySelector('.card-desc')!.textContent = `Started ${longDate(account.createdAt)}`;

    const meter = document.createElement('div');
    meter.className = 'trial-meter';
    meter.innerHTML = `
      <div class="trial-meter-head"><span class="kicker">Free trial</span><strong></strong></div>
      <div class="meter"><span></span></div>
      <p class="field-hint"></p>`;
    meter.querySelector('strong')!.textContent = daysText;
    meter.querySelector<HTMLElement>('.meter span')!.style.width = `${(daysLeft / TRIAL_DAYS) * 100}%`;
    meter.querySelector('.field-hint')!.textContent =
      `Ends ${longDate(account.trialEndsAt)}. Covers up to ${TRIAL_LIMITS.locations} locations and ${TRIAL_LIMITS.points} points.`;

    const signOut = document.createElement('button');
    signOut.type = 'button';
    signOut.className = 'btn btn-outline';
    signOut.append(icon('logout'), 'Switch workspace');
    signOut.addEventListener('click', async () => {
      await backend.signOut();
      // A reload stops the camera and every model, and lands on the quick access page.
      location.reload();
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-secondary';
    close.dataset.close = '';
    close.textContent = 'Done';

    openDialog({ title: 'Workspace', body: [who, meter], footer: [signOut, close] });
  });
}
