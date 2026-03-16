/**
 * editor autocomplete capability registry.
 *
 * contributors decorate the editor's base autocomplete provider rather than
 * replacing the editor host itself. that keeps domain semantics out of the ui
 * host while preserving normal fallback behavior like @file completion.
 *
 * sync API only — cross-extension state sharing requires a shared singleton.
 * separate ManagedRuntimes per extension would create isolated SubscriptionRefs
 * with no shared state, defeating the purpose.
 */

import type { AutocompleteProvider } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface EditorAutocompleteContext {
  cwd: string;
}

export interface EditorAutocompleteContributor {
  id: string;
  priority?: number;
  enhance(provider: AutocompleteProvider, context: EditorAutocompleteContext): AutocompleteProvider;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sortContributors(
  contributors: Map<string, EditorAutocompleteContributor>,
): EditorAutocompleteContributor[] {
  return [...contributors.values()].sort((a, b) => {
    const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return a.id.localeCompare(b.id);
  });
}

function composeProvider(
  baseProvider: AutocompleteProvider,
  context: EditorAutocompleteContext,
  contributors: Map<string, EditorAutocompleteContributor>,
): AutocompleteProvider {
  let provider = baseProvider;
  for (const contributor of sortContributors(contributors)) {
    provider = contributor.enhance(provider, context);
  }
  return provider;
}

// ---------------------------------------------------------------------------
// sync API — encapsulated state (no bare module-level singletons)
// ---------------------------------------------------------------------------

const _state = {
  contributors: new Map<string, EditorAutocompleteContributor>(),
  listeners: new Set<() => void>(),
};

function emitChange(): void {
  for (const listener of _state.listeners) listener();
}

export function registerEditorAutocompleteContributor(
  contributor: EditorAutocompleteContributor,
): () => void {
  const previous = _state.contributors.get(contributor.id);
  _state.contributors.set(contributor.id, contributor);
  if (previous !== contributor) emitChange();

  return () => {
    if (_state.contributors.get(contributor.id) !== contributor) return;
    _state.contributors.delete(contributor.id);
    emitChange();
  };
}

export function subscribeEditorAutocompleteContributors(listener: () => void): () => void {
  _state.listeners.add(listener);
  return () => {
    _state.listeners.delete(listener);
  };
}

export function listEditorAutocompleteContributors(): EditorAutocompleteContributor[] {
  return sortContributors(_state.contributors);
}

export function composeEditorAutocompleteProvider(
  baseProvider: AutocompleteProvider,
  context: EditorAutocompleteContext,
): AutocompleteProvider {
  return composeProvider(baseProvider, context, _state.contributors);
}
