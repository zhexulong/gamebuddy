import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * The shell's own draft store: the words a player has typed but not yet saved.
 *
 * Why it lives here and not in the field. The composed shell renders each peer surface
 * conditionally - `shownSurface === …` in `ComposedReferenceGameApp` - so leaving Characters for
 * Settings unmounts the whole subtree, and every `useState` inside it goes with it. The Chat
 * composer never had that problem because its text was lifted into the shell
 * (`inputText`/`writeInput`); this is that same precedent generalised - one store owned by the
 * mount that outlives every surface, read and written by the fields whose text belongs to the
 * player rather than to the projection.
 *
 * A draft always WINS over the value the authority supplies, and that is the whole point. These
 * panels re-seed from durable read-backs by design - a saved value must be what the store returned
 * - and the defect was that the re-seed ran while the player held unsaved text: the field came back
 * holding the stored value, which reads as "your text was accepted" when it had been thrown away.
 * So the caller passes the authority's value as `seed` on EVERY render, and the store answers with
 * the player's text whenever there is any. The projection still seeds every field the player has
 * not touched, and it cannot overwrite one they have.
 *
 * Releasing is the other half, and it is careful for a reason: a save releases the draft only when
 * the field still holds exactly what that save sent. Text typed DURING the request is the player's
 * (`1af99e73`), and clearing it would be the same defect pointing the other way.
 */
type Drafts = Readonly<Record<string, string>>;

type DraftStore = Readonly<{
  drafts: Drafts;
  write: (key: string, value: string) => void;
  /** Forget the draft if it is still exactly `sent`; a field the player has gone on typing in keeps it. */
  release: (key: string, sent: string) => void;
  /** Forget the draft outright: the player discarded it. */
  forget: (key: string) => void;
}>;

const SurfaceDraftsContext = createContext<DraftStore | null>(null);

export function SurfaceDrafts({ children }: Readonly<{ children: ReactNode }>) {
  const [drafts, setDrafts] = useState<Drafts>({});
  const store = useMemo<DraftStore>(
    () => ({
      drafts,
      write: (key, value) => setDrafts((current) => ({ ...current, [key]: value })),
      release: (key, sent) =>
        setDrafts((current) => {
          if (current[key] !== sent) return current;
          const next = { ...current };
          delete next[key];
          return next;
        }),
      forget: (key) =>
        setDrafts((current) => {
          if (!(key in current)) return current;
          const next = { ...current };
          delete next[key];
          return next;
        }),
    }),
    [drafts],
  );
  return <SurfaceDraftsContext.Provider value={store}>{children}</SurfaceDraftsContext.Provider>;
}

function storeFor(key: string): DraftStore {
  const store = useContext(SurfaceDraftsContext);
  if (store === null) {
    // Not a fallback: a field that quietly kept its own state would be exactly the defect this
    // store removes, and it would only surface after the player switched away and lost work.
    throw new Error(`${key} needs a SurfaceDrafts provider above it, or its draft dies with its surface`);
  }
  return store;
}

export type DraftField<T> = Readonly<{
  /** What the field shows: the player's text if there is any, otherwise what the authority says. */
  value: T;
  /** The player's own edit. */
  type: (next: T) => void;
  /** A save the Host accepted: hand the field back to the authority, unless the player has typed since. */
  release: (sent: T) => void;
  /** The player discarding their own text: forget it, and show the authority's value again. */
  clear: () => void;
}>;

function field<T>(store: DraftStore, key: string, seed: T): DraftField<T> {
  const draft = store.drafts[key];
  return {
    value: draft === undefined ? seed : (draft as unknown as T),
    type: (next: T) => store.write(key, next as unknown as string),
    release: (sent: T) => store.release(key, sent as unknown as string),
    clear: () => store.forget(key),
  };
}

/**
 * One text field's draft over the value the authority supplies.
 *
 * Memoised on the store, the key and the seed, so a caller can hand `release` to an effect without
 * the effect firing on every render. The store's own identity moves only when a draft moves, so the
 * one re-run a release causes converges: the second call finds nothing to release.
 */
export function useDraft(key: string, seed: string): DraftField<string> {
  const store = storeFor(key);
  return useMemo(() => field(store, key, seed), [store, key, seed]);
}

/** A field whose value the player picked from a bounded set: the same rule, one erased type. */
export function useChoiceDraft<T extends string>(key: string, seed: T): DraftField<T> {
  const store = storeFor(key);
  return useMemo(() => field(store, key, seed), [store, key, seed]);
}

/**
 * A disclosure the player opened, which is the one thing standing between them and a field.
 *
 * It belongs here for the same reason the words do: `authoringOpen` was mount-local, so a player
 * who opened the memory form, typed into it and left the surface came back to a COLLAPSED form -
 * the words were not lost so much as made unreachable, which costs them the same work.
 */
export function useOpenDraft(key: string, seed: boolean): DraftField<boolean> {
  const store = storeFor(key);
  return useMemo(() => field(store, key, seed), [store, key, seed]);
}

/**
 * A field whose authority re-seeds it: the player's text wins, and a draft the authority already
 * agrees with is dropped.
 *
 * The second half matters for the fields that save on their own (the companion language commits on
 * blur, the thinking levels and the prompt addition save through their own buttons). Once the Host
 * states the value the player asked for, the draft has done its job: keeping it would freeze the
 * field on a copy that merely happens to match, and a later authoritative change would be invisible
 * behind it. A REFUSED save leaves the old value on the authority, so nothing is released and the
 * player's text stays where they can retry it.
 */
export function useDraftOverAuthority(key: string, authoritative: string): DraftField<string> {
  const draft = useDraft(key, authoritative);
  useEffect(() => {
    // Only the draft that still equals the authority is released, so text typed since is kept.
    draft.release(authoritative);
  }, [draft, authoritative]);
  return draft;
}

/**
 * A list of authored rows - the opening's variants are the one such field today.
 *
 * Kept whole rather than per row: a row's text keyed by its position lands on a different row once
 * the list is reordered or shortened, and the store must not invent that mapping.
 */
export function useRowsDraft<T>(key: string, seed: readonly T[]): DraftField<readonly T[]> {
  const store = storeFor(key);
  // The seed is a fresh array on most renders; keying the memo on its contents would be a second
  // spelling of "did it change". A new field object per render is harmless here because nothing
  // hands this one to an effect.
  return field(store, key, seed);
}
