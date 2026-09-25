// Dialogs built from code: a centred card on desktop, a bottom sheet on phones (the share dialog's
// styles), plus the form and confirm variants the master-data pages use.

import { AccountError } from './account/model';
import { iconButton } from './icons';

export interface DialogHandle {
  root: HTMLElement;
  close(): void;
}

interface DialogOptions {
  title: string;
  description?: string;
  body: Node[];
  footer: Node[];
}

let dialogCount = 0;
let formCount = 0;

function button(label: string, className: string, type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = type;
  element.className = className;
  element.textContent = label;
  return element;
}

export function openDialog({ title, description, body, footer }: DialogOptions): DialogHandle {
  const returnFocus = document.activeElement as HTMLElement | null;
  const titleId = `dialog-title-${++dialogCount}`;
  const root = document.createElement('div');
  root.className = 'dialog-root';
  root.innerHTML = `
    <div class="dialog-backdrop" data-close></div>
    <section class="dialog dialog--narrow" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <span class="sheet-handle" aria-hidden="true"></span>
      <header class="dialog-head">
        <div><h2 id="${titleId}" class="card-title"></h2><p class="card-desc"></p></div>
      </header>
      <div class="dialog-body"></div>
      <footer class="dialog-foot"></footer>
    </section>`;
  root.querySelector('h2')!.textContent = title;
  const desc = root.querySelector<HTMLElement>('.card-desc')!;
  desc.textContent = description ?? '';
  desc.hidden = !description;

  const closeButton = iconButton('close', 'Close');
  closeButton.dataset.close = '';
  root.querySelector('.dialog-head')!.append(closeButton);
  root.querySelector('.dialog-body')!.append(...body);
  root.querySelector('.dialog-foot')!.append(...footer);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') handle.close();
  };
  const handle: DialogHandle = {
    root,
    close() {
      document.removeEventListener('keydown', onKey);
      root.remove();
      returnFocus?.focus();
    },
  };
  for (const closer of root.querySelectorAll('[data-close]')) closer.addEventListener('click', handle.close);
  document.addEventListener('keydown', onKey);
  document.body.append(root);
  root.querySelector<HTMLElement>('input, select, .dialog-foot .btn-primary')?.focus();
  return handle;
}

// ---------- field errors, shared with the sign-in forms ----------

export function clearErrors(form: HTMLElement): void {
  for (const slot of form.querySelectorAll<HTMLElement>('[data-error-for]')) slot.hidden = true;
  for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
}

/** Shows an AccountError under the input it names, anything else at the top of the form. */
export function showError(form: HTMLElement, error: unknown): void {
  if (!(error instanceof AccountError)) console.error(error);
  const named = error instanceof AccountError && error.field ? error.field : null;
  const field = named && form.querySelector(`[data-error-for="${named}"]`) ? named : 'form';
  const slot = form.querySelector<HTMLElement>(`[data-error-for="${field}"]`)!;
  slot.textContent = error instanceof AccountError ? error.message : 'Something went wrong. Try again.';
  slot.hidden = false;
  const input = form.querySelector<HTMLElement>(`[name="${field}"]`);
  input?.setAttribute('aria-invalid', 'true');
  input?.focus();
}

function errorSlot(field: string): HTMLParagraphElement {
  const slot = document.createElement('p');
  slot.className = 'field-error';
  slot.dataset.errorFor = field;
  slot.hidden = true;
  return slot;
}

// ---------- form dialog ----------

export type FieldValue = string | boolean;

export interface FormField {
  name: string;
  label: string;
  value: FieldValue;
  /** A select when options are given, a switch when the value is boolean, text otherwise. */
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
}

interface FormDialogOptions {
  title: string;
  description?: string;
  fields: FormField[];
  submitLabel: string;
  /** A red text action on the left of the footer, such as Delete. */
  danger?: { label: string; run(close: () => void): void };
  submit(values: Record<string, FieldValue>): Promise<void>;
}

export interface FormDialogHandle extends DialogHandle {
  input(name: string): HTMLInputElement | HTMLSelectElement;
}

function control(field: FormField): HTMLInputElement | HTMLSelectElement {
  if (field.options) {
    const select = document.createElement('select');
    select.className = 'input select';
    for (const option of field.options) select.add(new Option(option.label, option.value, false, option.value === field.value));
    select.name = field.name;
    return select;
  }
  const input = document.createElement('input');
  input.name = field.name;
  if (typeof field.value === 'boolean') {
    input.type = 'checkbox';
    input.className = 'switch';
    input.setAttribute('role', 'switch');
    input.checked = field.value;
  } else {
    input.type = 'text';
    input.className = 'input';
    input.value = field.value;
    input.placeholder = field.placeholder ?? '';
    input.autocomplete = 'off';
  }
  return input;
}

export function formDialog(options: FormDialogOptions): FormDialogHandle {
  const form = document.createElement('form');
  form.className = 'form-stack';
  form.id = `dialog-form-${++formCount}`;
  form.noValidate = true;
  form.append(errorSlot('form'));

  const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
  for (const field of options.fields) {
    const element = control(field);
    controls.set(field.name, element);
    const label = document.createElement('label');
    label.className = typeof field.value === 'boolean' ? 'field field--switch' : 'field';
    const caption = document.createElement('span');
    caption.className = 'field-label';
    caption.textContent = field.label;
    label.append(caption, element);
    if (field.hint) {
      const hint = document.createElement('span');
      hint.className = 'field-hint';
      hint.textContent = field.hint;
      label.append(hint);
    }
    form.append(label, errorSlot(field.name));
  }

  const cancel = button('Cancel', 'btn btn-outline');
  cancel.dataset.close = '';
  const save = button(options.submitLabel, 'btn btn-primary', 'submit');
  save.setAttribute('form', form.id);
  const footer: Node[] = [cancel, save];
  if (options.danger) {
    const danger = button(options.danger.label, 'btn btn-ghost btn-danger');
    danger.addEventListener('click', () => options.danger!.run(handle.close));
    footer.unshift(danger);
  }

  const handle: FormDialogHandle = {
    ...openDialog({ title: options.title, description: options.description, body: [form], footer }),
    input: (name) => controls.get(name)!,
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    const values: Record<string, FieldValue> = {};
    for (const [name, element] of controls) {
      values[name] = element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : element.value;
    }
    save.disabled = true;
    try {
      await options.submit(values);
      handle.close();
    } catch (error) {
      showError(form, error);
    } finally {
      save.disabled = false;
    }
  });
  return handle;
}

export function confirmDialog(options: { title: string; message: string; confirmLabel: string; run(): Promise<void> }): void {
  const cancel = button('Cancel', 'btn btn-outline');
  cancel.dataset.close = '';
  const confirm = button(options.confirmLabel, 'btn btn-primary');
  const error = errorSlot('form');
  const handle = openDialog({ title: options.title, description: options.message, body: [error], footer: [cancel, confirm] });
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      await options.run();
      handle.close();
    } catch (e) {
      showError(handle.root, e);
      confirm.disabled = false;
    }
  });
}
