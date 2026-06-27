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
  setPersona: (p: Persona) => void;
  setCurrentClientCode: (c: string | null) => void;
}

export const usePersona = create<PersonaState>()(
  persist(
    (set, get) => ({
      persona: "finops",
      currentClientCode: null,
      setPersona: (p) => {
        if (p === "client" && !get().currentClientCode) {
          set({ persona: p, currentClientCode: "CL001" });
        } else {
          set({ persona: p });
        }
      },
      setCurrentClientCode: (c) => set({ currentClientCode: c }),
    }),
    { name: "tia.persona" },
  ),
);
