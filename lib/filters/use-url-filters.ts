"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { applyPreset, clearFilters, NO_DEFAULT_PARAM, parseFilterParams, resolveInitialQuery, serializeFilterState, toggleOption } from "./index";
import type { FilterDef, FilterState } from "./index";

/**
 * Filter state kept in the URL, so Back, reload and shared links all return to the same view. State is also held in
 * React so typing stays instant: the URL is written with history.replaceState (Next keeps useSearchParams in sync with
 * it), which avoids a server round trip on every keystroke and never adds a history entry or scrolls the page.
 *
 * `savedDefault` is the query the person saved with "Save as my default". It applies only when the URL says nothing.
 * Clearing everything while a default exists writes `v=0`, so the default does not come straight back.
 */
export function useUrlFilters<T>(def: FilterDef<T>, savedDefault: string | null) {
  const sp = useSearchParams();
  const urlQuery = sp.toString();
  const lastWritten = useRef<string | null>(null);
  const [state, setState] = useState<FilterState>(() => parseFilterParams(def, resolveInitialQuery(def, urlQuery, savedDefault)));

  // Back and forward: when the URL changes and it was not us, take the new state.
  useEffect(() => {
    if (lastWritten.current === urlQuery) return;
    lastWritten.current = urlQuery;
    setState(parseFilterParams(def, resolveInitialQuery(def, urlQuery, savedDefault)));
  }, [urlQuery, def, savedDefault]);

  const write = useCallback(
    (next: FilterState) => {
      setState(next);
      let qs = serializeFilterState(def, next);
      if (qs === "" && savedDefault) qs = `${NO_DEFAULT_PARAM}=0`;
      lastWritten.current = qs;
      const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
      window.history.replaceState(window.history.state, "", url);
    },
    [def, savedDefault],
  );

  return useMemo(
    () => ({
      state,
      setSearch: (q: string) => write({ ...state, q }),
      setSort: (sort: string) => write({ ...state, sort }),
      toggle: (facet: string, value: string) => write(toggleOption(def, state, facet, value)),
      applyPreset: (id: string) => write(applyPreset(def, id, state)),
      clear: () => write(clearFilters(def, state)),
      /** The query string that "Save as my default" should store for the current view. */
      query: serializeFilterState(def, state),
    }),
    [state, write, def],
  );
}
