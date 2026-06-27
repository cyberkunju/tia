import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  setPersona: (p: Persona) => void;
  setCurrentClientCode: (c: string | null) => void;
  bumpReset: () => void;
}

export const usePersona = create<PersonaState>()(
  persist(
    (set, get) => ({
      persona: "finops",
      currentClientCode: null,
      resetTick: 0,
      setPersona: (p) => {
        if (p === "client" && !get().currentClientCode) {
          set({ persona: p, currentClientCode: "CL001" });
        } else {
          set({ persona: p });
        }
      },
      setCurrentClientCode: (c) => set({ currentClientCode: c }),
      bumpReset: () => set((s) => ({ resetTick: s.resetTick + 1 })),
    }),
    {
      name: "tia.persona",
      // resetTick is in-memory only — no point persisting demo-replay state.
      partialize: (s) => ({ persona: s.persona, currentClientCode: s.currentClientCode }),
    },
  ),
);
