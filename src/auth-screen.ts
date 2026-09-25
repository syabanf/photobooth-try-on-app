// The sign-in page (trial sign-up and sign-in) and the account sheet behind the avatar pill.

import type { AccountBackend } from './account/backend';
import { TRIAL_DAYS, TRIAL_LIMITS, initials, trialDaysLeft, trialExpired, type Account } from './account/model';
import { clearErrors, openDialog, showError } from './dialogs';
import { icon } from './icons';
import { segmented } from './ui';

const longDate = (time: number) => new Date(time).toLocaleDateString(undefined, { dateStyle: 'long' });

function formValues(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));
}

/** Resolves with the signed-in account, showing the sign-in page first when nobody is signed in. */
export async function signedIn(backend: AccountBackend): Promise<Account> {
  const existing = await backend.current();
  if (existing && !trialExpired(existing, Date.now())) return existing;

  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
  const screen = $<HTMLElement>('#authScreen');
  const forms = $<HTMLElement>('#authForms');
  const expired = $<HTMLElement>('#authExpired');
  const trialForm = $<HTMLFormElement>('#trialForm');
  const signInForm = $<HTMLFormElement>('#signInForm');
  screen.hidden = false;

  const COPY = {
    trial: { title: 'Start your free trial', desc: 'Set up your stores and points in a few minutes.' },
    signin: { title: 'Welcome back', desc: 'Sign in to open your stores and points.' },
  };
  function showTab(tab: keyof typeof COPY, focus = true): void {
    $('#authTitle').firstChild!.textContent = COPY[tab].title;
    $('#authDesc').textContent = COPY[tab].desc;
    trialForm.hidden = tab !== 'trial';
    signInForm.hidden = tab !== 'signin';
    for (const button of $('#authTabs').querySelectorAll<HTMLElement>('button')) {
      button.classList.toggle('is-active', button.dataset.auth === tab);
    }
    // Not on first paint: a focused field opens the keyboard over the page on phones.
    if (focus) (tab === 'trial' ? trialForm : signInForm).querySelector('input')!.focus();
  }

  function showExpired(account: Account): void {
    forms.hidden = true;
    expired.hidden = false;
    $('#authExpiredDesc').textContent =
      `The trial for ${account.business} ended on ${longDate(account.trialEndsAt)}. ` +
      'Your locations and points are kept for when the plan continues.';
  }

  segmented($('#authTabs'), (button) => showTab(button.dataset.auth as keyof typeof COPY));
  if (existing) showExpired(existing);
  else showTab('trial', false);

  return new Promise((resolve) => {
    function enter(account: Account): void {
      if (trialExpired(account, Date.now())) {
        showExpired(account);
        return;
      }
      screen.hidden = true;
      resolve(account);
    }

    function handle(form: HTMLFormElement, submit: (values: Record<string, string>) => Promise<Account>): void {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearErrors(form);
        const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        button.disabled = true;
        try {
          enter(await submit(formValues(form)));
        } catch (error) {
          showError(form, error);
        } finally {
          button.disabled = false;
        }
      });
    }

    handle(trialForm, (values) =>
      backend.startTrial({ name: values.name, business: values.business, email: values.email, password: values.password }),
    );
    handle(signInForm, (values) => backend.signIn(values.email, values.password));

    $('#authSwitch').addEventListener('click', async () => {
      await backend.signOut();
      expired.hidden = true;
      forms.hidden = false;
      showTab('signin');
    });
  });
}

/** The avatar pill in the header: days left, and a sheet with the account and Sign out. */
export function mountAccountButton(backend: AccountBackend, account: Account): void {
  const button = document.querySelector<HTMLButtonElement>('#accountButton')!;
  const daysLeft = trialDaysLeft(account, Date.now());
  const daysText = `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`;
  document.querySelector('#accountInitials')!.textContent = initials(account.name);
  const trial = document.querySelector<HTMLElement>('#accountTrial')!;
  trial.textContent = `Trial · ${daysText}`;
  trial.dataset.urgent = String(daysLeft <= 3);

  button.addEventListener('click', () => {
    const who = document.createElement('div');
    who.className = 'account-who';
    who.innerHTML = `
      <span class="avatar avatar--lg"></span>
      <div><p class="device-name"></p><p class="card-desc"></p></div>`;
    who.querySelector('.avatar')!.textContent = initials(account.name);
    who.querySelector('.device-name')!.textContent = account.name;
    who.querySelector('.card-desc')!.textContent = `${account.email} · ${account.business}`;

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
    signOut.append(icon('logout'), 'Sign out');
    signOut.addEventListener('click', async () => {
      await backend.signOut();
      // A reload stops the camera and every model, and lands on the sign-in page.
      location.reload();
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-secondary';
    close.dataset.close = '';
    close.textContent = 'Done';

    openDialog({ title: 'Account', body: [who, meter], footer: [signOut, close] });
  });
}
