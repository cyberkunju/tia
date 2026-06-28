import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FocusedEntity } from "./types";

export type Persona = "client" | "finops" | "finance";

interface PersonaState {
  persona: Persona;
  /**
   * The client this "Client" persona acts on behalf of. Null until the user
   * picks one; we auto-pick CL001 the first time someone switches into the
   * Client persona so the portal lands populated.
   */
  currentClientCode: string | null;
  /**
   * Increments every time the user hits Reset Demo. Components that hold
   * post-upload UI state (e.g. the live UploadReceipt on ClientSubmit) watch
   * this and wipe themselves so the next demo run starts clean.
   */
  resetTick: number;
  /**
   * AIDA side-panel open state. Lifted into the store so any component (a
   * sparkle on an invoice row, a "Ask TIA" CTA inside a card) can open it
   * without prop-drilling through `AppShell`.
   */
  aidaOpen: boolean;
  /**
   * Currently focused entity for the chat panel. Null = global ask. Set by
   * `InvoiceChatTrigger` and (on page mount) by URL `?aida=` reader. Not
   * persisted — focus is per-session.
   */
  focusedEntity: FocusedEntity | null;
  setPersona: (p: Persona) => void;
  setCurrentClientCode: (c: string | null) => void;
  bumpReset: () => void;
  setAidaOpen: (open: boolean) => void;
  setFocusedEntity: (entity: FocusedEntity | null) => void;
}

export const usePersona = create<PersonaState>()(
  persist(
    (set, get) => ({
      persona: "finops",
      currentClientCode: null,
      resetTick: 0,
      aidaOpen: false,
      focusedEntity: null,
      setPersona: (p) => {
        if (p === "client" && !get().currentClientCode) {
          set({ persona: p, currentClientCode: "CL001" });
        } else {
          set({ persona: p });
        }
      },
      setCurrentClientCode: (c) => set({ currentClientCode: c }),
      bumpReset: () => set((s) => ({ resetTick: s.resetTick + 1 })),
      setAidaOpen: (open) => set({ aidaOpen: open }),
      setFocusedEntity: (entity) => set({ focusedEntity: entity }),
    }),
    {
      name: "tia.persona",
      // resetTick, aidaOpen, focusedEntity are in-memory only — per-session UX state.
      partialize: (s) => ({ persona: s.persona, currentClientCode: s.currentClientCode }),
    },
  ),
);
