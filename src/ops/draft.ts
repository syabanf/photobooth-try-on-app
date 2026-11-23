// Copy-on-write drafts. A change mutates a proxy of the state as if it were a deep copy, but only
// the objects it writes to are copied; everything else stays shared with the state before. The
// store then saves only the records whose identity changed, so a sale costs about the same whether
// the workspace holds forty orders or forty thousand.

interface DraftNode {
  base: object;
  copy: Record<PropertyKey, unknown> | null;
  parent: DraftNode | null;
  /** Where the base sat in its parent, to put the copy back in its place. */
  key: PropertyKey;
  proxy: object;
  /** Children reached through this node; the touched ones replace their base at the end. */
  kids: DraftNode[];
  /** Objects the recipe put into the copy: drafts to swap for their result, new objects to walk. */
  added: object[];
  finalized: boolean;
}

/**
 * Array searches whose callbacks only read. They see untouched records as plain objects, which
 * saves a proxy per record on a scan of thousands; only what they return becomes a draft.
 */
const SEARCHES = new Set<PropertyKey>(['find', 'findLast', 'findIndex', 'findLastIndex', 'some', 'every', 'filter']);
/** Array edits run natively on the copy: one trap for an unshift onto thousands, not one per index. */
const EDITS = new Set<PropertyKey>(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']);

/**
 * Objects already part of a saved state, which no draft will ever change in place. A new list a
 * change builds from the old one (say, the tickets plus one) holds thousands of them, and the end
 * of a change skips them instead of walking each one again.
 */
const SETTLED = new WeakSet<object>();

const plain = (value: unknown): value is Record<PropertyKey, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return Array.isArray(value) || proto === Object.prototype || proto === null;
};

/**
 * Runs `recipe` on a draft of `base` and returns the next state. Untouched objects keep their
 * identity, so `next.orders === base.orders` means no order changed. `base` is never mutated, so a
 * recipe that throws leaves it as it was.
 */
export function produce<T extends object>(base: T, recipe: (draft: T) => void): T {
  const byProxy = new WeakMap<object, DraftNode>();
  const byBase = new Map<object, DraftNode>();
  /** Objects the recipe created and put into the draft: owned by it, so mutated in place. */
  const fresh = new WeakSet<object>();

  const current = (node: DraftNode) => node.copy ?? (node.base as Record<PropertyKey, unknown>);

  function touch(node: DraftNode): void {
    if (node.copy) return;
    node.copy = (Array.isArray(node.base) ? [...node.base] : { ...node.base }) as Record<PropertyKey, unknown>;
    if (node.parent) touch(node.parent);
  }

  /** Notes an object going into a copy: a new one becomes the recipe's own; either is settled at the end. */
  function adopt(node: DraftNode, value: unknown): void {
    if (!plain(value)) return;
    if (!byProxy.has(value) && !byBase.has(value)) fresh.add(value);
    node.added.push(value);
  }

  /** What a callback should see: an element reached before goes in as its draft, so its edits show. */
  const view = (item: unknown) => (plain(item) ? (byBase.get(item)?.proxy ?? item) : item);

  function wrap(node: DraftNode, item: unknown, key: PropertyKey): unknown {
    return plain(item) && !byProxy.has(item) && !fresh.has(item) ? draftOf(item, node, key) : item;
  }

  function search(node: DraftNode, method: string) {
    // An element with no draft was never reached, so nothing under it changed and the plain object
    // reads the same.
    return (callback: (item: unknown, index: number, list: unknown) => unknown, thisArg?: unknown) => {
      const items = current(node) as unknown as unknown[];
      const test = (item: unknown, index: number) => callback.call(thisArg, view(item), index, node.proxy);
      const found = (items as unknown as Record<string, (test: (item: unknown, index: number) => unknown) => unknown>)[method](test);
      if (method === 'find' || method === 'findLast') return wrap(node, found, items.indexOf(found));
      if (method === 'filter') return (found as unknown[]).map((item) => wrap(node, item, items.indexOf(item)));
      return found;
    };
  }

  function edit(node: DraftNode, method: string) {
    return (...args: unknown[]) => {
      touch(node);
      const items = node.copy as unknown as unknown[];
      if (method === 'sort') {
        const compare = args[0] as ((a: unknown, b: unknown) => number) | undefined;
        items.sort(compare ? (a, b) => compare(view(a), view(b)) : undefined);
        return node.proxy;
      }
      if (method === 'reverse') {
        items.reverse();
        return node.proxy;
      }
      const added = method === 'splice' ? args.slice(2) : method === 'push' || method === 'unshift' ? args : [];
      for (const item of added) adopt(node, item);
      const result = (items as unknown as Record<string, (...args: unknown[]) => unknown>)[method](...args);
      // What comes out (pop, shift, splice) leaves as a draft, so a later write to it is not lost.
      if (method === 'pop' || method === 'shift') return wrap(node, result, -1);
      if (method === 'splice') return (result as unknown[]).map((item) => wrap(node, item, -1));
      return result;
    };
  }

  function draftOf(value: object, parent: DraftNode | null, key: PropertyKey): object {
    const known = byBase.get(value);
    if (known) return known.proxy;
    const node: DraftNode = { base: value, copy: null, parent, key, proxy: value, kids: [], added: [], finalized: false };
    node.proxy = new Proxy(value, {
      get(_, key) {
        if (Array.isArray(value)) {
          if (SEARCHES.has(key)) return search(node, key as string);
          if (EDITS.has(key)) return edit(node, key as string);
        }
        const found = Reflect.get(current(node), key);
        if (!plain(found) || byProxy.has(found) || fresh.has(found)) return found;
        return draftOf(found, node, key);
      },
      set(_, key, value) {
        const target = current(node);
        if (Object.is(target[key as string], value) && (value !== undefined || key in target)) return true;
        touch(node);
        adopt(node, value);
        node.copy![key as string] = value;
        return true;
      },
      deleteProperty(_, key) {
        if (!(key in current(node))) return true;
        touch(node);
        return delete node.copy![key as string];
      },
      defineProperty(_, key, descriptor) {
        touch(node);
        adopt(node, descriptor.value);
        return Reflect.defineProperty(node.copy!, key, descriptor);
      },
      has: (_, key) => key in current(node),
      ownKeys: () => Reflect.ownKeys(current(node)),
      getOwnPropertyDescriptor(_, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(current(node), key);
        // The proxy's target is the base, whose properties may no longer exist on the copy.
        if (descriptor && key !== 'length') descriptor.configurable = true;
        return descriptor;
      },
    });
    byProxy.set(node.proxy, node);
    byBase.set(value, node);
    parent?.kids.push(node);
    return node.proxy;
  }

  /** Swaps every draft in the result for its final object: the copy if written, else the base. */
  function finalize(value: unknown, insideFresh = false): unknown {
    if (!plain(value)) return value;
    const node = byProxy.get(value) ?? byBase.get(value);
    if (node) return settle(node);
    // A new object may hold drafts anywhere inside it, so it is walked all the way down, once.
    if ((insideFresh || fresh.has(value)) && !SETTLED.has(value)) {
      for (const key of Object.keys(value)) value[key] = finalize(value[key], true);
      SETTLED.add(value);
    }
    return value;
  }

  function settle(node: DraftNode): object {
    if (!node.copy) return node.base;
    if (node.finalized) return node.copy;
    node.finalized = true;
    const copy = node.copy;
    // Only what changed gets a look, never every entry: a list of thousands costs a few lookups.
    const replace = (from: object, to: object) => {
      if (from === to) return;
      if (Array.isArray(copy)) {
        for (let at = copy.indexOf(from); at >= 0; at = copy.indexOf(from, at + 1)) copy[at] = to;
      } else for (const key of Object.keys(copy)) if (copy[key] === from) copy[key] = to;
    };
    for (const kid of node.kids) if (kid.copy) replace(kid.base, settle(kid));
    for (const value of node.added) {
      const draft = byProxy.get(value) ?? byBase.get(value);
      if (draft) replace(value, settle(draft));
      else finalize(value, true);
    }
    SETTLED.add(copy);
    return copy;
  }

  const root = draftOf(base, null, '') as T;
  recipe(root);
  return finalize(root) as T;
}
